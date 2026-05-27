import React from 'react';
import { CreditCard, Plus, Utensils } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useKioskBinding } from '../context/KioskBindingContext';
import { useIdleTimer } from '../hooks/useIdleTimer';

/**
 * Three-tile home screen that comes after the AttractScreen tap. The three
 * actions are the full surface area of a fast-casual dine-in kiosk:
 *
 *   1. Ordenar (primary)        — start a new order
 *   2. Pagar mi cuenta (sec.)   — return after dining, find your open order, pay
 *   3. Agregar a mi orden (sec.)— return mid-meal, find your open order, add items
 *
 * The two secondary tiles exist because Mexican fast-casual customers order,
 * sit, eat, and only then pay — and they always add extras. The customer-pulls
 * model (re-enter name → find your open order) means we don't need to track
 * which tablet a particular customer used originally.
 *
 * NOTE: A "Hola [Name], tienes una cuenta abierta" banner is intentionally
 * NOT shown here. Customer sessions are cleared on AttractScreen, so a
 * returning customer arrives fresh; surfacing the banner would require
 * persisting the customer token across Attract resets (out of scope here).
 */
const KioskHomeScreen: React.FC = () => {
  const navigate = useNavigate();
  const { tenantName } = useKioskBinding();

  useIdleTimer(() => navigate('/'), 30_000);

  return (
    <div className="h-full w-full bg-neutral-950 text-white flex flex-col px-10 py-8">
      <header className="text-center mb-8">
        <p className="text-base text-neutral-500 font-black uppercase tracking-widest mb-1">
          Bienvenido a
        </p>
        <h1 className="text-5xl xl:text-6xl font-black leading-none">
          {tenantName || 'la tienda'}
        </h1>
      </header>

      <main className="flex-1 grid grid-rows-[3fr_2fr] gap-5 min-h-0">
        <button
          onClick={() => navigate('/fulfillment')}
          className="w-full rounded-lg bg-brand-600 active:bg-brand-700 text-white touch-manipulation flex flex-col items-center justify-center gap-6 px-6"
        >
          <Utensils className="h-28 w-28 xl:h-32 xl:w-32" />
          <span className="text-6xl xl:text-7xl font-black leading-none">Ordenar</span>
        </button>

        <div className="grid grid-cols-2 gap-5 min-h-0">
          <button
            onClick={() => navigate('/pagar')}
            className="rounded-lg bg-neutral-800 active:bg-neutral-700 text-white touch-manipulation flex flex-col items-center justify-center gap-4 px-6"
          >
            <CreditCard className="h-20 w-20" />
            <span className="text-4xl xl:text-5xl font-black leading-tight text-center">
              Pagar mi cuenta
            </span>
          </button>

          <button
            onClick={() => navigate('/agregar')}
            className="rounded-lg bg-neutral-800 active:bg-neutral-700 text-white touch-manipulation flex flex-col items-center justify-center gap-4 px-6"
          >
            <Plus className="h-20 w-20" />
            <span className="text-4xl xl:text-5xl font-black leading-tight text-center">
              Agregar a mi orden
            </span>
          </button>
        </div>
      </main>
    </div>
  );
};

export default KioskHomeScreen;
