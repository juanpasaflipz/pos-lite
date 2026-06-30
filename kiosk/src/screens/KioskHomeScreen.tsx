import React from 'react';
import { Utensils } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useKioskBinding } from '../context/KioskBindingContext';
import { useIdleTimer } from '../hooks/useIdleTimer';

/**
 * Single-tile home screen after the AttractScreen tap. Customers always pay
 * when ordering (no hold-tab), so the legacy "Pagar mi cuenta" / "Agregar a
 * mi orden" tiles are gone — there are no kiosk-held tabs to come back to.
 */
const KioskHomeScreen: React.FC = () => {
  const navigate = useNavigate();
  const { tenantName } = useKioskBinding();

  useIdleTimer(() => navigate('/'), 60_000);

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

      <main className="flex-1 min-h-0">
        <button
          onClick={() => navigate('/fulfillment')}
          className="h-full w-full rounded-lg bg-brand-600 active:bg-brand-700 text-white touch-manipulation flex flex-col items-center justify-center gap-6 px-6"
        >
          <Utensils className="h-32 w-32 xl:h-40 xl:w-40" />
          <span className="text-6xl xl:text-7xl font-black leading-none">Ordenar</span>
        </button>
      </main>
    </div>
  );
};

export default KioskHomeScreen;
