import React from 'react';
import { ShoppingBag, Utensils } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useKioskCart, type KioskFulfillmentType } from '../context/KioskCartContext';
import { useIdleTimer } from '../hooks/useIdleTimer';

const KioskFulfillmentScreen: React.FC = () => {
  const navigate = useNavigate();
  const { setFulfillmentType } = useKioskCart();

  useIdleTimer(() => navigate('/'), 60_000);

  const choose = (type: KioskFulfillmentType) => {
    setFulfillmentType(type);
    // Para Aquí: name-first identify, then send-to-kitchen (eat → pay later).
    // Para Llevar: keeps the existing phone-first welcome with skip-to-menu
    // (pay-upfront grab-and-go).
    navigate(type === 'for_here' ? '/identify' : '/welcome');
  };

  return (
    <div className="h-full w-full bg-neutral-950 text-white flex flex-col">
      <main className="flex-1 px-10 py-10 flex flex-col items-center justify-center">
        <h1 className="text-5xl xl:text-6xl font-black text-center leading-none mb-10">
          ¿Como quieres tu orden?
        </h1>

        <div className="grid grid-cols-2 gap-6 w-full max-w-4xl">
          <button
            onClick={() => choose('for_here')}
            className="min-h-[360px] rounded-lg bg-brand-600 active:bg-brand-700 text-white touch-manipulation flex flex-col items-center justify-center gap-7 px-6"
          >
            <Utensils className="h-24 w-24" />
            <span className="text-4xl xl:text-5xl font-black leading-none text-center">Para aqui</span>
          </button>

          <button
            onClick={() => choose('to_go')}
            className="min-h-[360px] rounded-lg bg-neutral-800 active:bg-neutral-700 text-white touch-manipulation flex flex-col items-center justify-center gap-7 px-6"
          >
            <ShoppingBag className="h-24 w-24" />
            <span className="text-4xl xl:text-5xl font-black leading-none text-center">Para llevar</span>
          </button>
        </div>
      </main>
    </div>
  );
};

export default KioskFulfillmentScreen;
