import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useIdleTimer } from '../hooks/useIdleTimer';

const KioskPaymentScreen: React.FC = () => {
  const navigate = useNavigate();
  useIdleTimer(() => navigate('/'), 60_000);

  return (
    <div className="h-full w-full bg-neutral-950 text-white flex flex-col">
      <header className="px-8 py-6 border-b border-neutral-800 flex items-center justify-between">
        <button
          onClick={() => navigate('/cart')}
          className="px-6 py-3 rounded-xl bg-neutral-800 active:bg-neutral-700 text-base font-semibold touch-manipulation"
        >
          ← Back
        </button>
        <h1 className="text-3xl font-bold">Payment</h1>
        <div className="w-24" />
      </header>
      <main className="flex-1 p-8 flex flex-col items-center justify-center gap-8">
        <p className="text-neutral-500 text-base">Coming next commit (MP Point card flow + cash counter handoff)</p>
        <div className="grid grid-cols-2 gap-6 w-full max-w-3xl">
          <button
            onClick={() => navigate('/done')}
            className="aspect-[4/3] bg-brand-600 active:bg-brand-700 rounded-3xl text-3xl font-bold touch-manipulation flex flex-col items-center justify-center gap-3"
          >
            <span className="text-6xl">💳</span>
            Pay with Card
            <span className="text-base font-normal text-white/70">Mercado Pago terminal</span>
          </button>
          <button
            onClick={() => navigate('/done')}
            className="aspect-[4/3] bg-neutral-800 active:bg-neutral-700 rounded-3xl text-3xl font-bold touch-manipulation flex flex-col items-center justify-center gap-3"
          >
            <span className="text-6xl">💵</span>
            Pay with Cash
            <span className="text-base font-normal text-white/70">Pay at counter</span>
          </button>
        </div>
      </main>
    </div>
  );
};

export default KioskPaymentScreen;
