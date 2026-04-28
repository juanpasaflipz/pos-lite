import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useIdleTimer } from '../hooks/useIdleTimer';

const KioskMenuScreen: React.FC = () => {
  const navigate = useNavigate();
  useIdleTimer(() => navigate('/'), 60_000);

  return (
    <div className="h-full w-full bg-neutral-950 text-white flex flex-col">
      <header className="px-8 py-6 border-b border-neutral-800 flex items-center justify-between">
        <h1 className="text-3xl font-bold">Menu</h1>
        <button
          onClick={() => navigate('/')}
          className="px-6 py-3 rounded-xl bg-neutral-800 active:bg-neutral-700 text-base font-semibold touch-manipulation"
        >
          Cancel
        </button>
      </header>
      <main className="flex-1 p-8 flex items-center justify-center">
        <div className="text-center text-neutral-500">
          <p className="text-2xl mb-2">Menu screen</p>
          <p className="text-base">Coming next commit (categories + photo cards + modifiers)</p>
        </div>
      </main>
      <footer className="p-6 border-t border-neutral-800">
        <button
          onClick={() => navigate('/cart')}
          className="w-full bg-brand-600 active:bg-brand-700 rounded-2xl py-6 text-2xl font-bold touch-manipulation"
        >
          Go to Cart →
        </button>
      </footer>
    </div>
  );
};

export default KioskMenuScreen;
