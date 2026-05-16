import React, { useState } from 'react';
import { ArrowLeft, Banknote, CreditCard, Loader2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useKioskBinding } from '../context/KioskBindingContext';
import { useKioskCart } from '../context/KioskCartContext';
import { useIdleTimer } from '../hooks/useIdleTimer';
import { createKioskOrder, fetchKioskOrderStatus, sendKioskOrderToTerminal } from '../lib/kioskApi';

const money = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });
const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

const KioskPaymentScreen: React.FC = () => {
  const navigate = useNavigate();
  const { tenantId, kioskToken } = useKioskBinding();
  const { lines, total, clearCart, setLastOrder } = useKioskCart();
  const [busy, setBusy] = useState<'cash' | 'card' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useIdleTimer(() => navigate('/'), busy ? 180_000 : 60_000);

  const auth = tenantId && kioskToken ? { tenantId, kioskToken } : null;

  const orderPayload = lines.map((line) => ({
    menu_item_id: line.menu_item_id,
    quantity: line.quantity,
  }));

  const handleCash = async () => {
    if (!auth || lines.length === 0) return;
    setBusy('cash');
    setError(null);
    try {
      const order = await createKioskOrder(auth, orderPayload, 'counter_cash');
      setLastOrder({
        id: order.id,
        order_number: order.order_number,
        total: Number(order.total),
        payment_status: order.payment_status,
        payment_choice: 'counter_cash',
      });
      clearCart();
      navigate('/done');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo crear la orden');
      setBusy(null);
    }
  };

  const handleCard = async () => {
    if (!auth || lines.length === 0) return;
    setBusy('card');
    setError(null);
    try {
      setMessage('Enviando al terminal...');
      const order = await createKioskOrder(auth, orderPayload, 'terminal_card');
      await sendKioskOrderToTerminal(auth, order.id);
      setMessage('Paga en el terminal');

      for (let i = 0; i < 60; i += 1) {
        await wait(2500);
        const status = await fetchKioskOrderStatus(auth, order.id);
        if (status.payment_status === 'paid') {
          setLastOrder({
            id: order.id,
            order_number: status.order_number,
            total: Number(status.total),
            payment_status: 'paid',
            payment_choice: 'terminal_card',
          });
          clearCart();
          navigate('/done');
          return;
        }
        if (status.payment_status === 'failed') {
          throw new Error('El pago no paso. Intenta de nuevo o paga en caja.');
        }
      }
      throw new Error('El terminal tardo demasiado. Pide ayuda en caja.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo cobrar en terminal');
      setMessage(null);
      setBusy(null);
    }
  };

  return (
    <div className="h-full w-full bg-neutral-950 text-white flex flex-col">
      <header className="px-8 py-5 border-b border-neutral-800 flex items-center justify-between">
        <button
          disabled={!!busy}
          onClick={() => navigate('/cart')}
          className="h-14 px-5 rounded-lg bg-neutral-800 active:bg-neutral-700 disabled:opacity-50 text-base font-bold touch-manipulation inline-flex items-center gap-2"
        >
          <ArrowLeft className="h-5 w-5" />
          Orden
        </button>
        <h1 className="text-4xl font-black">Pagar</h1>
        <div className="w-28" />
      </header>

      <main className="flex-1 p-8 flex flex-col items-center justify-center gap-8">
        <div className="text-center">
          <p className="text-neutral-400 text-xl font-bold">Total</p>
          <p className="text-7xl font-black mt-2">{money.format(total)}</p>
        </div>

        {message && (
          <div className="h-16 px-6 rounded-lg bg-amber-500 text-neutral-950 flex items-center gap-3 text-xl font-black">
            <Loader2 className="h-7 w-7 animate-spin" />
            {message}
          </div>
        )}
        {error && (
          <div className="max-w-3xl rounded-lg bg-red-950 border border-red-700 px-6 py-4 text-xl font-bold text-red-100 text-center">
            {error}
          </div>
        )}

        <div className="grid grid-cols-2 gap-6 w-full max-w-4xl">
          <button
            disabled={!!busy || lines.length === 0}
            onClick={handleCard}
            className="aspect-[4/3] bg-brand-600 active:bg-brand-700 disabled:opacity-50 rounded-lg text-3xl font-black touch-manipulation flex flex-col items-center justify-center gap-4"
          >
            {busy === 'card' ? <Loader2 className="h-20 w-20 animate-spin" /> : <CreditCard className="h-20 w-20" />}
            Tarjeta
            <span className="text-lg font-bold text-white/75">Mercado Pago</span>
          </button>
          <button
            disabled={!!busy || lines.length === 0}
            onClick={handleCash}
            className="aspect-[4/3] bg-neutral-800 active:bg-neutral-700 disabled:opacity-50 rounded-lg text-3xl font-black touch-manipulation flex flex-col items-center justify-center gap-4"
          >
            {busy === 'cash' ? <Loader2 className="h-20 w-20 animate-spin" /> : <Banknote className="h-20 w-20" />}
            Caja
            <span className="text-lg font-bold text-white/70">Efectivo o ayuda</span>
          </button>
        </div>
      </main>
    </div>
  );
};

export default KioskPaymentScreen;
