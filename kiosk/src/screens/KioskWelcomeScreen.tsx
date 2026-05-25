import React, { useState } from 'react';
import { ArrowLeft, Gift, Loader2, ShoppingBag, Sparkles } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useKioskBinding } from '../context/KioskBindingContext';
import { useKioskCart } from '../context/KioskCartContext';
import { useKioskCustomer } from '../context/KioskCustomerContext';
import { useIdleTimer } from '../hooks/useIdleTimer';
import { fetchActiveDraft, identifyCustomer, resumeDraft, type KioskActiveDraft } from '../lib/kioskApi';

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

const KioskWelcomeScreen: React.FC = () => {
  const navigate = useNavigate();
  const { tenantId, kioskToken } = useKioskBinding();
  const { setSessionFromIdentify } = useKioskCustomer();
  const { replaceLines } = useKioskCart();

  const [step, setStep] = useState<'phone' | 'name' | 'resume'>('phone');
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resumeData, setResumeData] = useState<{
    draft: KioskActiveDraft;
    customerToken: string;
    firstName: string;
  } | null>(null);

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

  const afterIdentify = async (sess: ReturnType<typeof setSessionFromIdentify>) => {
    if (!sess || !auth) {
      goToMenu();
      return;
    }
    try {
      const draft = await fetchActiveDraft(auth, sess.customerToken);
      if (draft) {
        setResumeData({ draft, customerToken: sess.customerToken, firstName: sess.firstName });
        setStep('resume');
        return;
      }
    } catch {
      // Drafts are a nice-to-have — if the check fails, just proceed to menu.
    }
    goToMenu();
  };

  const submitPhone = async () => {
    if (!auth || busy || phone.length !== 10) return;
    setBusy(true);
    setError(null);
    try {
      const result = await identifyCustomer(auth, { phone, country_code: 'MX' });
      if (result.found) {
        const sess = setSessionFromIdentify(result);
        await afterIdentify(sess);
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
        const sess = setSessionFromIdentify(result);
        await afterIdentify(sess);
        return;
      }
      setError('No se pudo registrar. Intenta de nuevo.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo registrar');
    } finally {
      setBusy(false);
    }
  };

  const confirmResume = async () => {
    if (!auth || !resumeData || busy) return;
    setBusy(true);
    setError(null);
    try {
      const items = await resumeDraft(auth, resumeData.draft.id, resumeData.customerToken);
      replaceLines(items.map((item) => ({
        menu_item_id: item.menu_item_id,
        name: item.item_name,
        price: Number(item.unit_price),
        quantity: item.quantity,
      })));
      navigate('/cart');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo reanudar');
    } finally {
      setBusy(false);
    }
  };

  const declineResume = () => {
    setResumeData(null);
    goToMenu();
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

  if (step === 'resume' && resumeData) {
    const money = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });
    const itemCount = resumeData.draft.items.reduce((sum, item) => sum + item.quantity, 0);
    return (
      <div className="h-full w-full bg-neutral-950 text-white flex flex-col items-center justify-center px-10 py-8 text-center">
        <ShoppingBag className="h-20 w-20 text-brand-400 mb-6" />
        <h1 className="text-4xl font-black leading-tight">
          ¡Hola de nuevo, {resumeData.firstName}!
        </h1>
        <p className="text-xl text-neutral-300 font-bold mt-3 max-w-xl">
          Tienes una orden pendiente con {itemCount} {itemCount === 1 ? 'producto' : 'productos'} por {money.format(Number(resumeData.draft.total))}.
        </p>

        <div className="mt-8 w-full max-w-md space-y-2 rounded-2xl bg-neutral-900 border border-neutral-800 p-5">
          {resumeData.draft.items.slice(0, 5).map((item) => (
            <div key={item.menu_item_id} className="flex justify-between text-lg font-bold">
              <span className="truncate">{item.quantity}× {item.item_name}</span>
              <span className="text-neutral-400">{money.format(Number(item.unit_price) * item.quantity)}</span>
            </div>
          ))}
          {resumeData.draft.items.length > 5 && (
            <p className="text-sm text-neutral-500 font-bold pt-2 border-t border-neutral-800">
              + {resumeData.draft.items.length - 5} más
            </p>
          )}
        </div>

        <div className="mt-8 flex flex-col gap-3 w-full max-w-md">
          <button
            onClick={confirmResume}
            disabled={busy}
            className="h-16 rounded-2xl bg-brand-600 active:bg-brand-700 disabled:opacity-50 text-xl font-black touch-manipulation"
          >
            Continuar mi orden
          </button>
          <button
            onClick={declineResume}
            disabled={busy}
            className="h-14 rounded-2xl bg-neutral-800 active:bg-neutral-700 disabled:opacity-50 text-lg font-black text-neutral-300 touch-manipulation"
          >
            Empezar de nuevo
          </button>
        </div>

        {error && <p className="mt-4 text-cockpit-out-text text-base font-bold">{error}</p>}
      </div>
    );
  }

  if (step === 'phone') {
    return (
      <div className="h-full w-full bg-neutral-950 text-white grid grid-cols-2 gap-8 px-10 py-8">
        <div className="flex flex-col justify-center min-w-0">
          <div className="inline-flex items-center gap-3 text-brand-300 mb-4">
            <Gift className="h-7 w-7" />
            <span className="text-base font-black uppercase tracking-widest">Recompensas</span>
          </div>
          <h1 className="text-4xl xl:text-5xl font-black leading-[1.05]">
            Identifícate y ordena más rápido
          </h1>
          <p className="text-xl text-neutral-400 font-bold mt-4 max-w-md">
            Acumula sellos y te recomendamos lo que más te gusta.
          </p>

          <button
            onClick={skip}
            className="mt-10 h-16 w-fit px-6 rounded-2xl bg-neutral-800 active:bg-neutral-700 text-xl font-black text-neutral-200 touch-manipulation"
          >
            No, gracias — solo quiero ordenar
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
              <Pad key={d} label={d} onClick={() => onDigit(d)} />
            ))}
            <div />
            <Pad label="0" onClick={() => onDigit('0')} />
            <Pad label="⌫" muted onClick={onBackspace} disabled={phone.length === 0} />
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

  return (
    <div className="h-full w-full bg-neutral-950 text-white flex flex-col items-center justify-center px-10 py-8">
      <div className="text-center mb-6">
        <h1 className="text-4xl font-black leading-tight">¡Bienvenido! 👋</h1>
        <p className="text-xl text-neutral-400 font-bold mt-2 max-w-xl">
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
        className="w-[460px] h-20 rounded-2xl bg-neutral-900 border-2 border-neutral-700 focus:border-brand-500 outline-none text-center text-3xl font-black px-6"
      />

      <div className={`my-3 h-6 text-base font-bold ${error ? 'text-cockpit-out-text' : 'text-transparent'}`}>
        {error || 'placeholder'}
      </div>

      <button
        onClick={submitName}
        disabled={!name.trim()}
        className="w-[460px] h-16 rounded-2xl bg-brand-600 active:bg-brand-700 disabled:bg-neutral-800 disabled:text-neutral-600 text-xl font-black touch-manipulation"
      >
        Registrarme y ordenar
      </button>

      <p className="mt-3 text-sm text-neutral-500 font-bold max-w-md text-center">
        Te enviaremos un SMS con tu tarjeta de recompensas.
      </p>

      <button
        onClick={() => {
          setStep('phone');
          setError(null);
        }}
        className="mt-4 inline-flex items-center gap-2 text-base font-bold text-neutral-500 active:text-neutral-300 touch-manipulation"
      >
        <ArrowLeft className="h-5 w-5" />
        Cambiar número
      </button>
    </div>
  );
};

export default KioskWelcomeScreen;
