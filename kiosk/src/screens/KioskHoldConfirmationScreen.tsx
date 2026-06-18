import React, { useEffect, useState } from 'react';
import { CheckCircle2, Plus, Store, Utensils } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useKioskCart } from '../context/KioskCartContext';
import { useKioskCustomer } from '../context/KioskCustomerContext';

type ConfirmMode = 'hold' | 'kitchen' | 'appended' | 'paid';

interface HoldState {
  mode?: ConfirmMode;
  orderId?: number;
  orderNumber: string | number;
  total: number;
  firstName?: string;
  /** Only set for the 'appended' mode — how many units we just added. */
  addedCount?: number;
}

const money = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });
// Dine-in / appended / paid clears faster so the tablet rolls to the next customer.
// Takeaway hold lingers because the cashier needs time to walk over.
const COUNTDOWN_BY_MODE: Record<ConfirmMode, number> = {
  hold: 30,
  kitchen: 12,
  appended: 10,
  paid: 12,
};

const KioskHoldConfirmationScreen: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { clearCart } = useKioskCart();
  const { clearSession } = useKioskCustomer();

  const state = (location.state as HoldState | null) || null;
  const validModes = new Set<ConfirmMode>(['hold', 'kitchen', 'appended', 'paid']);
  const mode: ConfirmMode = validModes.has(state?.mode as ConfirmMode)
    ? (state!.mode as ConfirmMode)
    : 'hold';
  const [seconds, setSeconds] = useState(COUNTDOWN_BY_MODE[mode]);

  useEffect(() => {
    if (!state) {
      navigate('/', { replace: true });
    }
  }, [state, navigate]);

  useEffect(() => {
    if (!state) return;
    const id = setInterval(() => {
      setSeconds((s) => {
        if (s <= 1) {
          clearInterval(id);
          clearCart();
          clearSession();
          navigate('/', { replace: true });
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [state, navigate, clearCart, clearSession]);

  if (!state) return null;

  const handleAddMore = () => {
    // Hold mode: cart + session stay intact so the next "Llamar a la caja"
    // supersedes the existing held draft on the server (same draft updates).
    // Kitchen mode: the order is already fired and unchangeable from the kiosk
    // here — to add more, the customer goes back through "Agregar a mi orden"
    // on Welcome, which uses the append-items endpoint. We just send them
    // back to Welcome.
    if (mode === 'kitchen') {
      clearCart();
      clearSession();
      navigate('/', { replace: true });
      return;
    }
    navigate('/menu', { replace: true });
  };

  const handleDone = () => {
    clearCart();
    clearSession();
    navigate('/', { replace: true });
  };

  const isKitchen = mode === 'kitchen';
  const isAppended = mode === 'appended';
  const isPaid = mode === 'paid';
  const showsBigOrderCard = !isAppended;

  let heading: string;
  if (isPaid) {
    heading = state.firstName ? `¡Gracias, ${state.firstName}!` : '¡Gracias!';
  } else if (isAppended) {
    heading = state.firstName ? `¡Agregado, ${state.firstName}!` : '¡Agregado!';
  } else {
    heading = state.firstName ? `¡Listo, ${state.firstName}!` : '¡Listo!';
  }

  let subheading: string;
  if (isPaid) {
    subheading = 'Pago recibido. ¡Vuelve pronto!';
  } else if (isAppended) {
    subheading = `Sumamos ${state.addedCount ?? 'tus'} ${state.addedCount === 1 ? 'producto' : 'productos'} a tu cuenta. La cocina los está preparando. Tu total actualizado es ${money.format(state.total)}.`;
  } else if (isKitchen) {
    subheading = 'Tu comida está en camino. Te llamamos por tu nombre. Cuando quieras pagar o agregar más, regresa al kiosko.';
  } else {
    subheading = 'El cajero te llevará la terminal a tu mesa.';
  }

  return (
    <div className="h-full w-full bg-neutral-950 text-white flex flex-col items-center justify-center p-10 text-center">
      {isKitchen || isAppended ? (
        <Utensils className="h-28 w-28 text-cockpit-in-text mb-6" />
      ) : (
        <CheckCircle2 className="h-28 w-28 text-cockpit-in-text mb-6" />
      )}
      <h1 className="text-5xl font-black leading-tight">{heading}</h1>
      <p className="text-2xl text-neutral-300 font-bold mt-4 max-w-2xl">{subheading}</p>

      {showsBigOrderCard && (
        <div className="mt-10 grid grid-cols-2 gap-6 max-w-xl w-full">
          <div className="rounded-2xl bg-neutral-900 border border-neutral-800 p-6">
            <p className="text-sm text-neutral-500 font-bold uppercase tracking-wider">Orden</p>
            <p className="text-5xl font-black text-brand-300 mt-1">#{state.orderNumber}</p>
          </div>
          <div className="rounded-2xl bg-neutral-900 border border-neutral-800 p-6">
            <p className="text-sm text-neutral-500 font-bold uppercase tracking-wider">Total</p>
            <p className="text-5xl font-black mt-1">{money.format(state.total)}</p>
          </div>
        </div>
      )}

      {isKitchen || isAppended || isPaid ? (
        // Single big "Listo" for any flow where the customer's task is done.
        // Adding more requires going back through Agregar a mi orden from
        // Welcome, so we don't expose a misleading "Agregar más" here that
        // would silently create a separate order.
        <div className="mt-10 w-full max-w-xl">
          <button
            onClick={handleDone}
            className="w-full h-20 rounded-2xl bg-brand-600 active:bg-brand-700 text-2xl font-black touch-manipulation inline-flex items-center justify-center gap-3"
          >
            <Store className="h-7 w-7" />
            Listo · {seconds}s
          </button>
        </div>
      ) : (
        <div className="mt-10 grid grid-cols-1 sm:grid-cols-2 gap-4 w-full max-w-xl">
          <button
            onClick={handleAddMore}
            className="h-20 rounded-2xl bg-brand-600 active:bg-brand-700 text-2xl font-black touch-manipulation inline-flex items-center justify-center gap-3"
          >
            <Plus className="h-7 w-7" />
            Agregar más
          </button>
          <button
            onClick={handleDone}
            className="h-20 rounded-2xl bg-neutral-800 active:bg-neutral-700 text-2xl font-black touch-manipulation inline-flex items-center justify-center gap-3"
          >
            <Store className="h-7 w-7" />
            Listo · {seconds}s
          </button>
        </div>
      )}

      <p className="mt-6 text-sm text-neutral-500 font-bold">
        Esta pantalla se cerrará sola en {seconds}s.
      </p>
    </div>
  );
};

export default KioskHoldConfirmationScreen;
