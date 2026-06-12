import React, { useState } from 'react';
import { ArrowLeft, CreditCard, Loader2, Plus, Search, Utensils } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useKioskBinding } from '../context/KioskBindingContext';
import { useKioskCart } from '../context/KioskCartContext';
import { useKioskCustomer } from '../context/KioskCustomerContext';
import { useIdleTimer } from '../hooks/useIdleTimer';
import { fetchOpenOrders, identifyCustomer, type KioskOpenOrder } from '../lib/kioskApi';

const money = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });

export type LookupMode = 'pay' | 'agregar';

interface Props {
  mode: LookupMode;
}

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

function elapsedMinutes(createdAt: string): number {
  const ms = Date.now() - new Date(createdAt).getTime();
  return Math.max(0, Math.round(ms / 60000));
}

function previewItems(order: KioskOpenOrder): string {
  if (!order.items.length) return 'sin productos';
  const first = order.items.slice(0, 2).map((it) => `${it.quantity}× ${it.item_name}`);
  const rest = order.items.length - 2;
  return rest > 0 ? `${first.join(', ')} +${rest} más` : first.join(', ');
}

/**
 * Find-my-open-order screen. Shared by Pagar mi cuenta and Agregar a mi orden:
 * customer enters their name (or phone for loyalty members), backend returns
 * the open unpaid dine-in orders matching, then we either auto-proceed (one
 * match) or show a disambiguator (multiple matches). Going forward is mode-
 * specific: pay → KioskPayExistingScreen; agregar → KioskMenuScreen in
 * append mode (cart context tracks appendToOrderId).
 */
const KioskLookupScreen: React.FC<Props> = ({ mode }) => {
  const navigate = useNavigate();
  const { tenantId, kioskToken } = useKioskBinding();
  const { setSessionFromIdentify } = useKioskCustomer();
  const { setAppendToOrderId, setCallName } = useKioskCart();

  const [step, setStep] = useState<'name' | 'phone' | 'results'>('name');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [results, setResults] = useState<KioskOpenOrder[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useIdleTimer(() => navigate('/'), 60_000);

  const auth = tenantId && kioskToken ? { tenantId, kioskToken } : null;

  const isPay = mode === 'pay';
  const heading = isPay ? 'Pagar mi cuenta' : 'Agregar a mi orden';
  const Icon = isPay ? CreditCard : Plus;

  // Single-match auto-advance and disambiguator pick both go through here.
  const continueWith = (order: KioskOpenOrder) => {
    if (isPay) {
      navigate('/pay-existing', {
        replace: true,
        state: { order },
      });
    } else {
      // Cart context tracks appendToOrderId so the cart screen knows to call
      // appendOrderItems instead of creating a new order.
      setAppendToOrderId(order.id);
      navigate('/menu', { replace: true });
    }
  };

  const searchByName = async () => {
    if (!auth || busy) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Escribe tu nombre para buscar');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const orders = await fetchOpenOrders(auth, { name: trimmed, mode });
      if (orders.length === 0) {
        setResults([]);
        setStep('results');
        return;
      }
      // Persist the typed name in cart context so the agregar flow sends the
      // same customer_call_name on appended items (mostly for cashier display).
      setCallName(trimmed);
      if (orders.length === 1) {
        continueWith(orders[0]);
        return;
      }
      setResults(orders);
      setStep('results');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo buscar tu cuenta');
    } finally {
      setBusy(false);
    }
  };

  const searchByPhone = async () => {
    if (!auth || busy || phone.length !== 10) return;
    setBusy(true);
    setError(null);
    try {
      const result = await identifyCustomer(auth, { phone, country_code: 'MX' });
      if (!result.found || !result.customer_token) {
        setError('No te encontramos. Intenta con tu nombre.');
        setStep('name');
        return;
      }
      setSessionFromIdentify(result);
      const orders = await fetchOpenOrders(auth, { customerToken: result.customer_token, mode });
      if (orders.length === 0) {
        setResults([]);
        setStep('results');
        return;
      }
      if (orders.length === 1) {
        continueWith(orders[0]);
        return;
      }
      setResults(orders);
      setStep('results');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo buscar tu cuenta');
    } finally {
      setBusy(false);
    }
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

  const backToHome = () => navigate('/home');

  if (busy) {
    return (
      <div className="h-full w-full bg-neutral-950 text-white flex flex-col items-center justify-center gap-8 px-10 text-center">
        <Loader2 className="h-24 w-24 animate-spin text-brand-400" />
        <p className="text-4xl font-black">Buscando tu cuenta…</p>
      </div>
    );
  }

  if (step === 'results') {
    return (
      <div className="h-full w-full bg-neutral-950 text-white flex flex-col px-10 py-8">
        <header className="flex items-center justify-between mb-6">
          <button
            onClick={() => setStep('name')}
            className="h-14 px-5 rounded-lg bg-neutral-800 active:bg-neutral-700 text-lg font-bold touch-manipulation inline-flex items-center gap-2"
          >
            <ArrowLeft className="h-5 w-5" />
            Atrás
          </button>
          <h1 className="text-3xl font-black">{heading}</h1>
          <div className="w-[100px]" />
        </header>

        {results.length === 0 ? (
          <main className="flex-1 flex flex-col items-center justify-center text-center gap-6">
            <Search className="h-24 w-24 text-neutral-700" />
            <p className="text-3xl font-black">No encontramos tu cuenta</p>
            <p className="text-xl text-neutral-400 font-bold max-w-xl">
              Verifica que escribiste tu nombre tal como lo diste al ordenar. Si necesitas ayuda, pídele al cajero.
            </p>
            <div className="flex gap-3 mt-4">
              <button
                onClick={() => setStep('name')}
                className="h-16 px-8 rounded-2xl bg-brand-600 active:bg-brand-700 text-xl font-black touch-manipulation"
              >
                Intentar de nuevo
              </button>
              <button
                onClick={backToHome}
                className="h-16 px-8 rounded-2xl bg-neutral-800 active:bg-neutral-700 text-xl font-black touch-manipulation"
              >
                Volver
              </button>
            </div>
          </main>
        ) : (
          <main className="flex-1 overflow-y-auto">
            <p className="text-xl text-neutral-300 font-bold mb-4">
              Encontramos {results.length} {results.length === 1 ? 'cuenta' : 'cuentas'}. ¿Cuál es la tuya?
            </p>
            <div className="space-y-3">
              {results.map((order) => (
                <button
                  key={order.id}
                  onClick={() => continueWith(order)}
                  className="w-full text-left rounded-lg bg-neutral-900 border-2 border-neutral-800 active:border-brand-500 active:bg-neutral-800 p-5 touch-manipulation"
                >
                  <div className="flex items-start justify-between gap-4 mb-2">
                    <div className="flex items-center gap-3 min-w-0">
                      <Utensils className="h-7 w-7 text-brand-400 shrink-0" />
                      <div className="min-w-0">
                        <p className="text-2xl font-black truncate">
                          #{order.order_number}
                          {order.customer_call_name && (
                            <span className="text-neutral-400 ml-2 text-xl">· {order.customer_call_name}</span>
                          )}
                        </p>
                        <p className="text-sm text-neutral-500 font-bold mt-0.5">
                          hace {elapsedMinutes(order.created_at)} min
                        </p>
                      </div>
                    </div>
                    <p className="text-2xl font-black text-brand-300 shrink-0">
                      {money.format(Number(order.total))}
                    </p>
                  </div>
                  <p className="text-base text-neutral-400 font-bold truncate">
                    {previewItems(order)}
                  </p>
                </button>
              ))}
            </div>
          </main>
        )}
      </div>
    );
  }

  if (step === 'phone') {
    return (
      <div className="h-full w-full bg-neutral-950 text-white grid grid-cols-2 gap-8 px-10 py-8">
        <div className="flex flex-col justify-center min-w-0">
          <button
            onClick={() => {
              setStep('name');
              setError(null);
            }}
            className="mb-6 h-14 w-fit px-5 rounded-lg bg-neutral-800 active:bg-neutral-700 text-lg font-bold touch-manipulation inline-flex items-center gap-2"
          >
            <ArrowLeft className="h-5 w-5" />
            Mejor con mi nombre
          </button>
          <h1 className="text-4xl xl:text-5xl font-black leading-[1.05]">{heading}</h1>
          <p className="text-xl text-neutral-400 font-bold mt-4 max-w-md">
            Pon tu teléfono y buscamos tu cuenta abierta.
          </p>
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
            onClick={searchByPhone}
            disabled={phone.length !== 10}
            className="mt-5 w-[320px] h-16 rounded-2xl bg-brand-600 active:bg-brand-700 disabled:bg-neutral-800 disabled:text-neutral-600 text-xl font-black touch-manipulation"
          >
            Buscar
          </button>
        </div>
      </div>
    );
  }

  // step === 'name'
  return (
    <div className="h-full w-full bg-neutral-950 text-white flex flex-col px-10 py-8">
      <header className="flex items-center justify-between mb-8">
        <button
          onClick={backToHome}
          className="h-14 px-5 rounded-lg bg-neutral-800 active:bg-neutral-700 text-lg font-bold touch-manipulation inline-flex items-center gap-2"
        >
          <ArrowLeft className="h-5 w-5" />
          Inicio
        </button>
        <div className="inline-flex items-center gap-3 text-brand-300">
          <Icon className="h-7 w-7" />
          <span className="text-base font-black uppercase tracking-widest">{heading}</span>
        </div>
        <div className="w-[120px]" />
      </header>

      <main className="flex-1 flex flex-col items-center justify-start pt-8 md:pt-16">
        <h1 className="text-4xl xl:text-5xl font-black leading-tight text-center mb-3">
          ¿Cómo te llamas?
        </h1>
        <p className="text-xl text-neutral-400 font-bold mb-8 max-w-xl text-center">
          {isPay
            ? 'Buscamos tu cuenta para que pagues aquí mismo.'
            : 'Buscamos tu cuenta para sumarle más productos.'}
        </p>

        <input
          autoFocus
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') searchByName();
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
            onClick={() => {
              setStep('phone');
              setError(null);
              setPhone('');
            }}
            className="h-16 rounded-2xl bg-neutral-800 active:bg-neutral-700 text-lg font-black touch-manipulation"
          >
            Mejor con mi teléfono
          </button>
          <button
            onClick={searchByName}
            disabled={!name.trim()}
            className="h-16 rounded-2xl bg-brand-600 active:bg-brand-700 disabled:bg-neutral-800 disabled:text-neutral-600 text-lg font-black touch-manipulation inline-flex items-center justify-center gap-2"
          >
            <Search className="h-5 w-5" />
            Buscar
          </button>
        </div>
      </main>
    </div>
  );
};

export default KioskLookupScreen;
