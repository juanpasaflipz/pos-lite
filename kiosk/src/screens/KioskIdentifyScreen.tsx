import React, { useState } from 'react';
import { ArrowLeft, Loader2, Phone, Sparkles } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useKioskBinding } from '../context/KioskBindingContext';
import { useKioskCart } from '../context/KioskCartContext';
import { useKioskCustomer } from '../context/KioskCustomerContext';
import { useIdleTimer } from '../hooks/useIdleTimer';
import { identifyCustomer } from '../lib/kioskApi';

const Pad: React.FC<{
  label: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  muted?: boolean;
}> = ({ label, onClick, disabled, muted }) => (
  <button
    onClick={onClick}
    disabled={disabled}
    className={`h-20 rounded-2xl text-3xl font-black touch-manipulation flex items-center justify-center transition-colors disabled:opacity-40 ${
      muted
        ? 'bg-neutral-800 active:bg-neutral-700 text-neutral-400'
        : 'bg-neutral-800 active:bg-neutral-700 text-white'
    }`}
  >
    {label}
  </button>
);

function formatPhone(digits: string): string {
  const a = digits.slice(0, 2);
  const b = digits.slice(2, 6);
  const c = digits.slice(6, 10);
  return [a, b, c].filter(Boolean).join(' ');
}

/**
 * Para Comer Aquí identify screen — name-first with optional loyalty phone path.
 * Name is the bridge customers use later to come back and pay or add items
 * (Pagar mi cuenta / Agregar a mi orden). Loyalty-identified customers get
 * their name from the profile and skip the name field entirely.
 */
const KioskIdentifyScreen: React.FC = () => {
  const navigate = useNavigate();
  const { tenantId, tenantName, kioskToken } = useKioskBinding();
  const { setSessionFromIdentify } = useKioskCustomer();
  const { setCallName } = useKioskCart();

  const [step, setStep] = useState<'name' | 'phone' | 'offer'>('name');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useIdleTimer(() => navigate('/'), 60_000);

  const auth = tenantId && kioskToken ? { tenantId, kioskToken } : null;
  const restaurantName = tenantName || 'nosotros';

  const goToMenu = () => navigate('/menu');

  const proceedAnonymous = (typedName: string) => {
    setCallName(typedName);
    goToMenu();
  };

  const onSubmitName = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setError(null);
    setStep('offer');
  };

  const onPickPhone = () => {
    setError(null);
    setPhone('');
    setStep('phone');
  };

  const onPhoneDigit = (d: string) => {
    if (busy || phone.length >= 10) return;
    setPhone(phone + d);
    setError(null);
  };

  const onPhoneBackspace = () => {
    if (busy) return;
    setPhone(phone.slice(0, -1));
    setError(null);
  };

  const submitPhone = async () => {
    if (!auth || busy || phone.length !== 10) return;
    setBusy(true);
    setError(null);
    try {
      const trimmedName = name.trim();
      const result = await identifyCustomer(auth, {
        phone,
        country_code: 'MX',
        // If they typed a name before tapping "Ya tengo cuenta", pre-fill it
        // so an unknown phone enrolls them in one shot instead of bouncing back.
        name: trimmedName || undefined,
        sms_opt_in: true,
      });
      if (result.found) {
        setSessionFromIdentify(result);
        goToMenu();
        return;
      }
      // Unknown number with no typed name — bounce back to the name step
      // so we can enroll them on retry.
      setStep('name');
      setError('No te encontramos. Escribe tu nombre y volvemos a intentarlo.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo continuar');
    } finally {
      setBusy(false);
    }
  };

  if (busy) {
    return (
      <div className="h-full w-full bg-neutral-950 text-white flex flex-col items-center justify-center gap-8 px-10 text-center">
        <Loader2 className="h-24 w-24 animate-spin text-brand-400" />
        <p className="text-4xl font-black">Buscando tus recompensas…</p>
        <p className="text-2xl text-neutral-400 font-bold">
          <Sparkles className="inline h-6 w-6 text-brand-400" /> Un momento
        </p>
      </div>
    );
  }

  if (step === 'phone') {
    return (
      <div className="h-full w-full bg-neutral-950 text-white grid grid-cols-2 gap-8 px-10 py-8">
        <div className="flex flex-col justify-center min-w-0">
          <div className="inline-flex items-center gap-3 text-brand-300 mb-4">
            <Phone className="h-7 w-7" />
            <span className="text-base font-black uppercase tracking-widest">Tu cuenta</span>
          </div>
          <h1 className="text-4xl xl:text-5xl font-black leading-[1.05]">
            Pon tu teléfono y te reconocemos
          </h1>
          <p className="text-xl text-neutral-400 font-bold mt-4 max-w-md">
            Vamos a sumar este pedido a tus puntos.
          </p>

          <button
            onClick={() => {
              setStep('name');
              setError(null);
            }}
            className="mt-10 inline-flex items-center gap-2 h-14 w-fit px-5 rounded-2xl bg-neutral-800 active:bg-neutral-700 text-lg font-black text-neutral-200 touch-manipulation"
          >
            <ArrowLeft className="h-5 w-5" />
            Mejor solo mi nombre
          </button>
        </div>

        <div className="flex flex-col items-center justify-center">
          <div className="h-16 mb-1 flex items-center justify-center">
            <span className="text-5xl font-black tracking-wider tabular-nums">
              {formatPhone(phone) || <span className="text-neutral-700">55 0000 0000</span>}
            </span>
          </div>

          <div className={`mb-3 h-6 text-base font-bold ${error ? 'text-cockpit-out-text' : 'text-transparent'}`}>
            {error || 'placeholder'}
          </div>

          <div className="grid grid-cols-3 gap-3 w-[320px]">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
              <Pad key={d} label={d} onClick={() => onPhoneDigit(d)} />
            ))}
            <div />
            <Pad label="0" onClick={() => onPhoneDigit('0')} />
            <Pad label="⌫" muted onClick={onPhoneBackspace} disabled={phone.length === 0} />
          </div>

          <button
            onClick={submitPhone}
            disabled={phone.length !== 10}
            className="mt-5 w-[320px] h-16 rounded-2xl bg-brand-600 active:bg-brand-700 disabled:bg-neutral-800 disabled:text-neutral-600 text-xl font-black touch-manipulation"
          >
            Continuar
          </button>
        </div>
      </div>
    );
  }

  if (step === 'offer') {
    return (
      <div className="h-full w-full bg-neutral-950 text-white flex flex-col items-center justify-center px-10 py-8">
        <div className="w-full max-w-xl rounded-2xl bg-neutral-900 border border-neutral-800 shadow-2xl p-8">
          <div className="flex items-center gap-3 text-brand-300 mb-2">
            <Sparkles className="h-7 w-7" />
            <span className="text-sm font-black uppercase tracking-widest">Lealtad de {restaurantName}</span>
          </div>
          <h2 className="text-3xl xl:text-4xl font-black leading-[1.1]">
            ¡Hola, {name.trim().split(/\s+/)[0]}! ¿Quieres acumular puntos?
          </h2>
          <p className="text-xl text-neutral-300 font-bold mt-4">
            Cada 10 puntos, el burrito de tu preferencia gratis.
          </p>

          <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 gap-3">
            <button
              onClick={() => proceedAnonymous(name.trim())}
              className="h-16 rounded-2xl bg-neutral-800 active:bg-neutral-700 text-lg font-black text-neutral-200 touch-manipulation"
            >
              Ahora no
            </button>
            <button
              onClick={onPickPhone}
              className="h-16 rounded-2xl bg-brand-600 active:bg-brand-700 text-lg font-black touch-manipulation inline-flex items-center justify-center gap-2"
            >
              <Phone className="h-5 w-5" />
              Sí, agregar mi teléfono
            </button>
          </div>
        </div>
      </div>
    );
  }

  // step === 'name'
  return (
    <div className="h-full w-full bg-neutral-950 text-white flex flex-col items-center justify-center px-10 py-8">
      <div className="text-center mb-8">
        <h1 className="text-4xl xl:text-5xl font-black leading-tight">¿Cómo te llamas?</h1>
        <p className="text-xl text-neutral-400 font-bold mt-3 max-w-xl">
          Te llamamos por tu nombre cuando esté lista tu orden.
        </p>
      </div>

      <input
        autoFocus
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSubmitName();
        }}
        placeholder="Tu nombre"
        maxLength={40}
        className="w-[520px] max-w-full h-20 rounded-2xl bg-neutral-900 border-2 border-neutral-700 focus:border-brand-500 outline-none text-center text-3xl font-black px-6"
      />

      <div className={`my-3 h-6 text-base font-bold ${error ? 'text-cockpit-out-text' : 'text-transparent'}`}>
        {error || 'placeholder'}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-[520px] max-w-full">
        <button
          onClick={onPickPhone}
          className="h-16 rounded-2xl bg-neutral-800 active:bg-neutral-700 text-lg font-black touch-manipulation inline-flex items-center justify-center gap-2"
        >
          <Phone className="h-5 w-5" />
          Ya tengo cuenta
        </button>
        <button
          onClick={onSubmitName}
          disabled={!name.trim()}
          className="h-16 rounded-2xl bg-brand-600 active:bg-brand-700 disabled:bg-neutral-800 disabled:text-neutral-600 text-lg font-black touch-manipulation"
        >
          Continuar
        </button>
      </div>
    </div>
  );
};

export default KioskIdentifyScreen;
