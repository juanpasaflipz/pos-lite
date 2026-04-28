import React, { useState } from 'react';
import { useKioskBinding } from '../context/KioskBindingContext';
import { bindKiosk } from '../lib/kioskApi';

const Pad: React.FC<{ label: string; onClick: () => void; variant?: 'default' | 'primary' | 'danger'; disabled?: boolean }> = ({
  label,
  onClick,
  variant = 'default',
  disabled,
}) => {
  const base = 'w-28 h-28 rounded-2xl text-3xl font-bold touch-manipulation flex items-center justify-center transition-colors';
  const variants = {
    default: 'bg-neutral-800 active:bg-neutral-700 text-white',
    primary: 'bg-brand-600 active:bg-brand-700 text-white disabled:bg-neutral-800 disabled:text-neutral-600',
    danger: 'bg-neutral-800 active:bg-neutral-700 text-neutral-400',
  };
  return (
    <button onClick={onClick} disabled={disabled} className={`${base} ${variants[variant]}`}>
      {label}
    </button>
  );
};

const BindDeviceScreen: React.FC = () => {
  const { bind } = useKioskBinding();
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onDigit = (d: string) => {
    if (busy || pin.length >= 6) return;
    setPin(pin + d);
    setError(null);
  };

  const onBackspace = () => {
    if (busy) return;
    setPin(pin.slice(0, -1));
    setError(null);
  };

  const onSubmit = async () => {
    if (busy || pin.length < 4) return;
    setBusy(true);
    setError(null);
    try {
      const result = await bindKiosk(pin);
      bind(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Bind failed');
      setPin('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-full w-full bg-neutral-950 flex flex-col items-center justify-center p-8 text-white">
      <div className="text-center mb-12">
        <h1 className="text-4xl md:text-5xl font-bold mb-3">Setup Kiosk</h1>
        <p className="text-lg text-neutral-400 max-w-md">
          Enter staff PIN to bind this iPad to a restaurant. This is a one-time setup.
        </p>
      </div>

      <div className="mb-8 h-16 flex items-center justify-center gap-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className={`w-8 h-12 rounded-sm border-b-4 transition-colors ${
              i < pin.length ? 'border-brand-500' : 'border-neutral-700'
            }`}
          />
        ))}
      </div>

      <div className={`mb-4 h-6 text-base ${error ? 'text-red-400' : 'text-transparent'}`}>
        {error || 'placeholder'}
      </div>

      <div className="grid grid-cols-3 gap-4">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <Pad key={d} label={d} onClick={() => onDigit(d)} disabled={busy} />
        ))}
        <Pad label="⌫" variant="danger" onClick={onBackspace} disabled={busy || pin.length === 0} />
        <Pad label="0" onClick={() => onDigit('0')} disabled={busy} />
        <Pad
          label={busy ? '…' : 'Bind'}
          variant="primary"
          onClick={onSubmit}
          disabled={busy || pin.length < 4}
        />
      </div>
    </div>
  );
};

export default BindDeviceScreen;
