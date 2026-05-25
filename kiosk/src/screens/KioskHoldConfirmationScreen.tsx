import React, { useEffect, useState } from 'react';
import { CheckCircle2, Store } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useKioskCart } from '../context/KioskCartContext';
import { useKioskCustomer } from '../context/KioskCustomerContext';

interface HoldState {
  orderNumber: string | number;
  total: number;
  firstName?: string;
}

const money = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });
const COUNTDOWN_SECONDS = 10;

const KioskHoldConfirmationScreen: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { clearCart } = useKioskCart();
  const { clearSession } = useKioskCustomer();

  const state = (location.state as HoldState | null) || null;
  const [seconds, setSeconds] = useState(COUNTDOWN_SECONDS);

  useEffect(() => {
    if (!state) {
      navigate('/', { replace: true });
      return;
    }
    clearCart();
    clearSession();
  }, []); // run once

  useEffect(() => {
    if (!state) return;
    const id = setInterval(() => {
      setSeconds((s) => {
        if (s <= 1) {
          clearInterval(id);
          navigate('/', { replace: true });
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [state, navigate]);

  if (!state) return null;

  return (
    <div className="h-full w-full bg-neutral-950 text-white flex flex-col items-center justify-center p-10 text-center">
      <CheckCircle2 className="h-28 w-28 text-cockpit-in-text mb-6" />
      <h1 className="text-5xl font-black leading-tight">
        {state.firstName ? `¡Listo, ${state.firstName}!` : '¡Listo!'}
      </h1>
      <p className="text-2xl text-neutral-300 font-bold mt-4 max-w-2xl">
        Tu orden está esperando en la caja.
      </p>

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

      <div className="mt-10 inline-flex items-center gap-3 text-xl font-bold text-neutral-300">
        <Store className="h-7 w-7 text-brand-400" />
        Ve a la caja para pagar
      </div>

      <button
        onClick={() => navigate('/', { replace: true })}
        className="mt-12 h-14 px-8 rounded-2xl bg-neutral-800 active:bg-neutral-700 text-lg font-black touch-manipulation"
      >
        Listo · {seconds}s
      </button>
    </div>
  );
};

export default KioskHoldConfirmationScreen;
