import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useIdleTimer } from '../hooks/useIdleTimer';

const KioskDoneScreen: React.FC = () => {
  const navigate = useNavigate();
  useIdleTimer(() => navigate('/'), 5_000);

  return (
    <div className="h-full w-full bg-gradient-to-br from-emerald-700 via-emerald-600 to-emerald-800 text-white flex flex-col items-center justify-center p-8">
      <div className="text-9xl mb-6">✓</div>
      <h1 className="text-5xl md:text-6xl font-black tracking-tight mb-4">Order Placed</h1>
      <p className="text-2xl text-white/80 mb-12 text-center max-w-2xl">
        Your order is on its way to the kitchen. Show this screen at the counter if asked.
      </p>
      <div className="text-base text-white/60">Returning to home in 5s…</div>
    </div>
  );
};

export default KioskDoneScreen;
