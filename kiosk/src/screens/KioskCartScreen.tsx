import React from 'react';
import { ArrowLeft, Minus, Plus, Trash2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useKioskCart } from '../context/KioskCartContext';
import { useIdleTimer } from '../hooks/useIdleTimer';

const money = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });

const KioskCartScreen: React.FC = () => {
  const navigate = useNavigate();
  const { lines, count, total, addItem, decrementItem, removeItem } = useKioskCart();
  useIdleTimer(() => navigate('/'), 60_000);

  return (
    <div className="h-full w-full bg-neutral-950 text-white flex flex-col">
      <header className="px-8 py-5 border-b border-neutral-800 flex items-center justify-between">
        <button
          onClick={() => navigate('/menu')}
          className="h-14 px-5 rounded-lg bg-neutral-800 active:bg-neutral-700 text-base font-bold touch-manipulation inline-flex items-center gap-2"
        >
          <ArrowLeft className="h-5 w-5" />
          Menu
        </button>
        <h1 className="text-4xl font-black">Tu orden</h1>
        <div className="w-28" />
      </header>

      <main className="flex-1 min-h-0 p-6 overflow-y-auto">
        {lines.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center gap-6 text-neutral-400">
            <p className="text-3xl font-black">Tu orden esta vacia</p>
            <button
              onClick={() => navigate('/menu')}
              className="h-16 px-8 rounded-lg bg-brand-600 text-white text-xl font-black"
            >
              Ver menu
            </button>
          </div>
        ) : (
          <div className="max-w-5xl mx-auto space-y-4">
            {lines.map((line) => (
              <div key={line.menu_item_id} className="rounded-lg bg-neutral-900 border border-neutral-800 p-5 grid grid-cols-[1fr_auto] gap-4 items-center">
                <div>
                  <h2 className="text-3xl font-black leading-tight">{line.name}</h2>
                  <p className="text-xl text-neutral-400 mt-1">{money.format(line.price)} c/u</p>
                </div>
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => decrementItem(line.menu_item_id)}
                    className="h-14 w-14 rounded-lg bg-neutral-800 active:bg-neutral-700 flex items-center justify-center"
                    aria-label="Menos"
                  >
                    <Minus className="h-7 w-7" />
                  </button>
                  <div className="h-14 w-16 rounded-lg bg-neutral-950 flex items-center justify-center text-2xl font-black">
                    {line.quantity}
                  </div>
                  <button
                    onClick={() => addItem({
                      id: line.menu_item_id,
                      name: line.name,
                      price: line.price,
                      description: null,
                      image_url: null,
                      category_id: 0,
                      active: true,
                    })}
                    className="h-14 w-14 rounded-lg bg-neutral-800 active:bg-neutral-700 flex items-center justify-center"
                    aria-label="Mas"
                  >
                    <Plus className="h-7 w-7" />
                  </button>
                  <button
                    onClick={() => removeItem(line.menu_item_id)}
                    className="h-14 w-14 rounded-lg bg-red-900/70 active:bg-red-800 flex items-center justify-center"
                    aria-label="Quitar"
                  >
                    <Trash2 className="h-6 w-6" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      <footer className="p-5 border-t border-neutral-800 bg-neutral-950">
        <button
          disabled={count === 0}
          onClick={() => navigate('/pay')}
          className="w-full bg-brand-600 active:bg-brand-700 disabled:bg-neutral-800 disabled:text-neutral-500 rounded-lg py-5 px-6 text-2xl font-black touch-manipulation flex items-center justify-between"
        >
          <span>Continuar</span>
          <span>{money.format(total)}</span>
        </button>
      </footer>
    </div>
  );
};

export default KioskCartScreen;
