import React from 'react';
import { ShoppingBag, Utensils } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useKioskCart, type KioskFulfillmentType } from '../context/KioskCartContext';
import { useIdleTimer } from '../hooks/useIdleTimer';

const KioskFulfillmentScreen: React.FC = () => {
  const navigate = useNavigate();
  const { setFulfillmentType } = useKioskCart();

  useIdleTimer(() => navigate('/'), 30_000);

  const choose = (type: KioskFulfillmentType) => {
    setFulfillmentType(type);
    navigate('/welcome');
  };

  return (
    <div className="h-full w-full bg-neutral-950 text-white flex flex-col">
      <main className="flex-1 px-10 py-10 flex flex-col items-center justify-center">
        <h1 className="text-5xl xl:text-6xl font-black text-center leading-none mb-10">
          ¿Para comer aqui o para llevar?
        </h1>

        <div className="grid grid-cols-2 gap-8 w-full max-w-5xl">
          <button
            onClick={() => choose('for_here')}
            className="min-h-[360px] rounded-lg bg-brand-600 active:bg-brand-700 text-white touch-manipulation flex flex-col items-center justify-center gap-7 px-6"
          >
            <Utensils className="h-28 w-28" />
            <span className="text-5xl font-black leading-none">Para aqui</span>
          </button>

          <button
            onClick={() => choose('to_go')}
            className="min-h-[360px] rounded-lg bg-neutral-800 active:bg-neutral-700 text-white touch-manipulation flex flex-col items-center justify-center gap-7 px-6"
          >
            <ShoppingBag className="h-28 w-28" />
            <span className="text-5xl font-black leading-none">Para llevar</span>
          </button>
        </div>
      </main>
    </div>
  );
};

export default KioskFulfillmentScreen;
