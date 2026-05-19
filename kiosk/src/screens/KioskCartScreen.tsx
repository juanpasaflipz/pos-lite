import React, { useState } from 'react';
import { ArrowLeft, Minus, Plus, Store, Trash2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useKioskBinding } from '../context/KioskBindingContext';
import { useKioskCart } from '../context/KioskCartContext';
import { useKioskCustomer } from '../context/KioskCustomerContext';
import { useIdleTimer } from '../hooks/useIdleTimer';
import { holdKioskOrder } from '../lib/kioskApi';

const money = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });

const KioskCartScreen: React.FC = () => {
  const navigate = useNavigate();
  const { tenantId, kioskToken } = useKioskBinding();
  const { session } = useKioskCustomer();
  const { lines, count, total, addItem, decrementItem, removeItem } = useKioskCart();
  const [holding, setHolding] = useState(false);
  const [holdError, setHoldError] = useState<string | null>(null);
  useIdleTimer(() => navigate('/'), 60_000);

  const sendToRegister = async () => {
    if (!session || !tenantId || !kioskToken || lines.length === 0 || holding) return;
    setHolding(true);
    setHoldError(null);
    try {
      const order = await holdKioskOrder(
        { tenantId, kioskToken },
        lines.map((line) => ({ menu_item_id: line.menu_item_id, quantity: line.quantity })),
        session.customerToken,
      );
      navigate('/hold-confirmed', {
        replace: true,
        state: {
          orderNumber: order.order_number,
          total: order.total,
          firstName: session.firstName,
        },
      });
    } catch (err) {
      setHoldError(err instanceof Error ? err.message : 'No se pudo enviar a la caja');
      setHolding(false);
    }
  };

  return (
    <div className="h-full w-full bg-neutral-950 text-white flex flex-col">
      <header className="px-6 py-4 border-b border-neutral-800 grid grid-cols-[auto_1fr_auto] items-center gap-4">
        <button
          onClick={() => navigate('/menu')}
          className="h-16 px-5 rounded-lg bg-neutral-800 active:bg-neutral-700 text-lg font-bold touch-manipulation inline-flex items-center gap-2"
        >
          <ArrowLeft className="h-6 w-6" />
          Menu
        </button>
        <h1 className="text-4xl font-black text-center leading-none">Tu orden</h1>
        <div className="text-right">
          <p className="text-sm text-neutral-500 font-bold uppercase">Total</p>
          <p className="text-2xl font-black text-brand-300">{money.format(total)}</p>
        </div>
      </header>

      <main className="flex-1 min-h-0 p-5 overflow-y-auto">
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
          <div className="space-y-4">
            {lines.map((line) => (
              <div key={line.menu_item_id} className="rounded-lg bg-neutral-900 border border-neutral-800 p-5 grid grid-cols-[1fr_256px] gap-4 items-center">
                <div className="min-w-0">
                  <h2 className="text-[32px] font-black leading-[1.05]">{line.name}</h2>
                  <p className="text-xl text-neutral-400 mt-2">
                    {money.format(line.price)} c/u · {money.format(line.price * line.quantity)}
                  </p>
                </div>
                <div className="grid grid-cols-[64px_72px_64px] gap-3 justify-end">
                  <button
                    onClick={() => decrementItem(line.menu_item_id)}
                    className="h-16 w-16 rounded-lg bg-neutral-800 active:bg-neutral-700 flex items-center justify-center"
                    aria-label="Menos"
                  >
                    <Minus className="h-8 w-8" />
                  </button>
                  <div className="h-16 w-[72px] rounded-lg bg-neutral-950 flex items-center justify-center text-3xl font-black">
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
                    className="h-16 w-16 rounded-lg bg-neutral-800 active:bg-neutral-700 flex items-center justify-center"
                    aria-label="Mas"
                  >
                    <Plus className="h-8 w-8" />
                  </button>
                  <button
                    onClick={() => removeItem(line.menu_item_id)}
                    className="col-span-3 h-14 rounded-lg bg-red-900/70 active:bg-red-800 flex items-center justify-center gap-2 text-lg font-black"
                    aria-label="Quitar"
                  >
                    <Trash2 className="h-6 w-6" />
                    Quitar
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      <footer className="p-4 border-t border-neutral-800 bg-neutral-950 space-y-3">
        {holdError && (
          <p className="text-red-400 text-base font-bold text-center">{holdError}</p>
        )}
        <button
          disabled={count === 0 || holding}
          onClick={() => navigate('/pay')}
          className="w-full min-h-20 bg-brand-600 active:bg-brand-700 disabled:bg-neutral-800 disabled:text-neutral-500 rounded-lg py-4 px-6 text-3xl font-black touch-manipulation flex items-center justify-between gap-4"
        >
          <span>Continuar</span>
          <span>{money.format(total)}</span>
        </button>
        {session && (
          <button
            disabled={count === 0 || holding}
            onClick={sendToRegister}
            className="w-full h-16 rounded-lg bg-neutral-800 active:bg-neutral-700 disabled:opacity-40 text-xl font-black touch-manipulation flex items-center justify-center gap-3"
          >
            <Store className="h-6 w-6" />
            {holding ? 'Enviando…' : 'Enviar a caja y pagar después'}
          </button>
        )}
      </footer>
    </div>
  );
};

export default KioskCartScreen;
