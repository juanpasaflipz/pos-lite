import React, { useState } from 'react';
import { ArrowLeft, Gift, Loader2, Sparkles } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useKioskBinding } from '../context/KioskBindingContext';
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
    className={`h-24 rounded-2xl text-3xl font-black touch-manipulation flex items-center justify-center transition-colors disabled:opacity-40 ${
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

const KioskWelcomeScreen: React.FC = () => {
  const navigate = useNavigate();
  const { tenantId, kioskToken } = useKioskBinding();
  const { setSessionFromIdentify } = useKioskCustomer();

  const [step, setStep] = useState<'phone' | 'name'>('phone');
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useIdleTimer(() => navigate('/'), 60_000);

  const auth = tenantId && kioskToken ? { tenantId, kioskToken } : null;

  const onDigit = (d: string) => {
    if (busy || phone.length >= 10) return;
    setPhone(phone + d);
    setError(null);
  };

  const onBackspace = () => {
    if (busy) return;
    setPhone(phone.slice(0, -1));
    setError(null);
  };

  const skip = () => navigate('/menu');

  const goToMenu = () => navigate('/menu');

  const submitPhone = async () => {
    if (!auth || busy || phone.length !== 10) return;
    setBusy(true);
    setError(null);
    try {
      const result = await identifyCustomer(auth, { phone, country_code: 'MX' });
      if (result.found) {
        setSessionFromIdentify(result);
        goToMenu();
        return;
      }
      // Unknown number — collect a name to enroll them.
      setStep('name');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo continuar');
    } finally {
      setBusy(false);
    }
  };

  const submitName = async () => {
    if (!auth || busy || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await identifyCustomer(auth, {
        phone,
        country_code: 'MX',
        name: name.trim(),
        sms_opt_in: true,
      });
      if (result.found) {
        setSessionFromIdentify(result);
        goToMenu();
        return;
      }
      setError('No se pudo registrar. Intenta de nuevo.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo registrar');
    } finally {
      setBusy(false);
    }
  };

  if (busy) {
    return (
      <div className="h-full w-full bg-neutral-950 text-white flex flex-col items-center justify-center gap-8 px-10 text-center">
        <Loader2 className="h-24 w-24 animate-spin text-brand-400" />
        <p className="text-4xl font-black">
          {step === 'name' ? 'Creando tu cuenta…' : 'Buscando tus recompensas…'}
        </p>
        <p className="text-2xl text-neutral-400 font-bold">
          Estamos preparando tus recomendaciones <Sparkles className="inline h-6 w-6 text-brand-400" />
        </p>
      </div>
    );
  }

  return (
    <div className="h-full w-full bg-neutral-950 text-white flex flex-col items-center justify-center p-8">
      {step === 'phone' && (
        <>
          <div className="text-center mb-8">
            <div className="inline-flex items-center gap-3 text-brand-300 mb-3">
              <Gift className="h-9 w-9" />
              <span className="text-xl font-black uppercase tracking-widest">Recompensas</span>
            </div>
            <h1 className="text-5xl font-black leading-tight">Identifícate y ordena más rápido</h1>
            <p className="text-2xl text-neutral-400 font-bold mt-3 max-w-xl">
              Acumula sellos y te recomendamos lo que más te gusta.
            </p>
          </div>

          <div className="h-20 mb-2 flex items-center justify-center">
            <span className="text-6xl font-black tracking-wider tabular-nums">
              {formatPhone(phone) || <span className="text-neutral-700">55 0000 0000</span>}
            </span>
          </div>

          <div className={`mb-4 h-7 text-lg font-bold ${error ? 'text-red-400' : 'text-transparent'}`}>
            {error || 'placeholder'}
          </div>

          <div className="grid grid-cols-3 gap-3 w-[360px]">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
              <Pad key={d} label={d} onClick={() => onDigit(d)} />
            ))}
            <div />
            <Pad label="0" onClick={() => onDigit('0')} />
            <Pad label="⌫" muted onClick={onBackspace} disabled={phone.length === 0} />
          </div>

          <button
            onClick={submitPhone}
            disabled={phone.length !== 10}
            className="mt-6 w-[360px] h-20 rounded-2xl bg-brand-600 active:bg-brand-700 disabled:bg-neutral-800 disabled:text-neutral-600 text-2xl font-black touch-manipulation"
          >
            Continuar
          </button>

          <button
            onClick={skip}
            className="mt-6 text-lg font-bold text-neutral-500 active:text-neutral-300 underline underline-offset-4 touch-manipulation"
          >
            Continuar sin registrarme
          </button>
        </>
      )}

      {step === 'name' && (
        <>
          <div className="text-center mb-8">
            <h1 className="text-5xl font-black leading-tight">¡Bienvenido! 👋</h1>
            <p className="text-2xl text-neutral-400 font-bold mt-3 max-w-xl">
              Es tu primera vez. ¿Cómo te llamas?
            </p>
          </div>

          <input
            autoFocus
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            placeholder="Tu nombre"
            maxLength={40}
            className="w-[460px] h-24 rounded-2xl bg-neutral-900 border-2 border-neutral-700 focus:border-brand-500 outline-none text-center text-4xl font-black px-6"
          />

          <div className={`my-4 h-7 text-lg font-bold ${error ? 'text-red-400' : 'text-transparent'}`}>
            {error || 'placeholder'}
          </div>

          <button
            onClick={submitName}
            disabled={!name.trim()}
            className="w-[460px] h-20 rounded-2xl bg-brand-600 active:bg-brand-700 disabled:bg-neutral-800 disabled:text-neutral-600 text-2xl font-black touch-manipulation"
          >
            Registrarme y ordenar
          </button>

          <p className="mt-4 text-base text-neutral-500 font-bold max-w-md text-center">
            Te enviaremos un SMS con tu tarjeta de recompensas.
          </p>

          <button
            onClick={() => {
              setStep('phone');
              setError(null);
            }}
            className="mt-6 inline-flex items-center gap-2 text-lg font-bold text-neutral-500 active:text-neutral-300 touch-manipulation"
          >
            <ArrowLeft className="h-5 w-5" />
            Cambiar número
          </button>
        </>
      )}
    </div>
  );
};

export default KioskWelcomeScreen;
