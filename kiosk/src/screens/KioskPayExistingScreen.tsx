import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Banknote, CreditCard, Loader2, MapPin, Truck } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useKioskBinding } from '../context/KioskBindingContext';
import { useKioskCart } from '../context/KioskCartContext';
import { useKioskCustomer } from '../context/KioskCustomerContext';
import { useIdleTimer } from '../hooks/useIdleTimer';
import {
  chargeExistingKioskOrderOnTerminal,
  fetchKioskOrderStatus,
  type KioskOpenOrder,
} from '../lib/kioskApi';

const money = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });
const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));
const POLL_INTERVAL_MS = 2_500;
const POLL_MAX_ITERATIONS = 60; // 2.5s * 60 = ~2.5 minutes

interface LocationState {
  order: KioskOpenOrder;
  delivery?: {
    delivery_order_id: number;
    external_id: string;
    tracking_url: string | null;
    status: string;
    fee: number;
    dropoff_eta: string | null;
  } | null;
  deliveryError?: string | null;
}

const KioskPayExistingScreen: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { tenantId, kioskToken } = useKioskBinding();
  const { clearCart } = useKioskCart();
  const { clearSession, session } = useKioskCustomer();

  const state = (location.state as LocationState | null) || null;
  const order = state?.order || null;

  const [busy, setBusy] = useState<'cash' | 'card' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  // Stretch idle timeout while a terminal charge is in flight — customer is
  // standing there with their card, not idle.
  useIdleTimer(() => navigate('/'), busy ? 180_000 : 60_000);

  useEffect(() => {
    if (!state) {
      navigate('/', { replace: true });
    }
    return () => {
      cancelledRef.current = true;
    };
  }, [state, navigate]);

  if (!order || !tenantId || !kioskToken) return null;

  const auth = { tenantId, kioskToken };
  const customerName =
    order.customer_call_name || session?.firstName || null;

  const onPaidSuccess = () => {
    navigate('/hold-confirmed', {
      replace: true,
      state: {
        mode: 'paid',
        orderId: order.id,
        orderNumber: order.order_number,
        total: order.total,
        firstName: customerName || undefined,
      },
    });
  };

  // Cash path: order stays as draft_kiosk on the server. Customer walks to the
  // cashier, who finds it in /api/orders/kiosk-held, collects cash, and claims
  // it (promotes status → 'active'). The kitchen ticket only appears at that
  // moment. We just acknowledge here and clear the tablet.
  const handleCash = () => {
    if (busy) return;
    setBusy('cash');
    setError(null);
    navigate('/hold-confirmed', {
      replace: true,
      state: {
        mode: 'cash-counter',
        orderId: order.id,
        orderNumber: order.order_number,
        total: order.total,
        firstName: customerName || undefined,
      },
    });
  };

  const handleCard = async () => {
    if (busy) return;
    setBusy('card');
    setError(null);
    setMessage('Enviando al terminal…');
    try {
      await chargeExistingKioskOrderOnTerminal(auth, order.id);
      setMessage('Paga en el terminal');

      for (let i = 0; i < POLL_MAX_ITERATIONS; i += 1) {
        if (cancelledRef.current) return;
        await wait(POLL_INTERVAL_MS);
        const status = await fetchKioskOrderStatus(auth, order.id);
        if (status.payment_status === 'paid') {
          clearCart();
          clearSession();
          onPaidSuccess();
          return;
        }
        if (status.payment_status === 'failed') {
          throw new Error('El pago no pasó. Intenta de nuevo o ve a la caja.');
        }
      }
      throw new Error('El terminal tardó demasiado. Pide ayuda en caja.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo cobrar en terminal');
      setMessage(null);
      setBusy(null);
    }
  };

  return (
    <div className="h-full w-full bg-neutral-950 text-white flex flex-col">
      <header className="px-6 py-4 border-b border-neutral-800 flex items-center justify-between">
        <button
          disabled={!!busy}
          onClick={() => navigate('/home')}
          className="h-16 px-5 rounded-lg bg-neutral-800 active:bg-neutral-700 disabled:opacity-50 text-lg font-bold touch-manipulation inline-flex items-center gap-2"
        >
          <ArrowLeft className="h-6 w-6" />
          Inicio
        </button>
        <h1 className="text-4xl font-black leading-none">Tu cuenta</h1>
        <div className="w-32" />
      </header>

      <main className="flex-1 grid grid-cols-[1fr_460px] gap-6 p-6 min-h-0">
        <section className="rounded-lg bg-neutral-900 border border-neutral-800 p-6 overflow-y-auto">
          <div className="flex items-baseline justify-between mb-4">
            <p className="text-2xl font-black">#{order.order_number}</p>
            {customerName && (
              <p className="text-lg text-neutral-400 font-bold">{customerName}</p>
            )}
          </div>
          <div className="space-y-3">
            {order.items.map((item) => (
              <div
                key={item.order_item_id}
                className="rounded-lg bg-neutral-950 border border-neutral-800 p-4"
              >
                <div className="flex justify-between items-baseline gap-3">
                  <p className="text-xl font-black truncate">
                    {item.quantity}× {item.item_name}
                  </p>
                  <p className="text-xl font-black text-neutral-300 shrink-0">
                    {money.format(Number(item.unit_price) * item.quantity)}
                  </p>
                </div>
                {item.modifiers.length > 0 && (
                  <p className="text-base text-neutral-500 mt-1">
                    {item.modifiers.map((m) => m.name).join(' · ')}
                  </p>
                )}
              </div>
            ))}
          </div>
        </section>

        <aside className="flex flex-col">
          <div className="text-center mb-6">
            <p className="text-neutral-400 text-xl font-bold uppercase tracking-wider">Total</p>
            <p className="text-[64px] font-black leading-none mt-2">{money.format(Number(order.total))}</p>
            <p className="text-sm text-neutral-500 mt-2 font-bold">
              Incluye IVA · Subtotal {money.format(Number(order.subtotal))}
            </p>
          </div>

          {state?.delivery && (
            <div className="mb-4 rounded-lg bg-cockpit-green/15 border border-cockpit-green/40 px-5 py-4 space-y-3">
              <div className="flex items-center gap-3">
                <Truck className="h-7 w-7 text-cockpit-in-text shrink-0" />
                <div>
                  <p className="text-lg font-black text-cockpit-in-text">Repartidor en camino</p>
                  <p className="text-sm text-neutral-300">Envío {money.format(state.delivery.fee)}</p>
                </div>
              </div>
              {state.delivery.tracking_url && (
                <a
                  href={state.delivery.tracking_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="w-full inline-flex items-center justify-center gap-2 py-3 rounded-lg bg-cockpit-green text-white text-lg font-black"
                >
                  <MapPin className="h-5 w-5" />
                  Rastrear repartidor
                </a>
              )}
            </div>
          )}
          {state?.deliveryError && (
            <div className="mb-4 rounded-lg bg-cockpit-red/20 border border-cockpit-red/50 px-5 py-3 text-base font-bold text-white">
              No se pudo despachar al repartidor: {state.deliveryError}
              <p className="text-sm font-normal text-neutral-300 mt-1">El operador podrá reintentar desde el POS.</p>
            </div>
          )}

          {message && (
            <div className="min-h-20 px-6 mb-4 rounded-lg bg-cockpit-yellow text-neutral-950 flex items-center gap-3 text-2xl font-black">
              <Loader2 className="h-8 w-8 animate-spin shrink-0" />
              {message}
            </div>
          )}
          {error && (
            <div className="w-full rounded-lg bg-cockpit-red/20 border border-cockpit-red/60 px-5 py-4 mb-4 text-lg font-bold text-white text-center">
              {error}
            </div>
          )}

          <div className="space-y-4 mt-auto">
            <button
              disabled={!!busy}
              onClick={handleCard}
              className="w-full min-h-[160px] bg-brand-600 active:bg-brand-700 disabled:opacity-50 rounded-lg text-3xl font-black touch-manipulation flex flex-col items-center justify-center gap-2"
            >
              {busy === 'card' ? <Loader2 className="h-16 w-16 animate-spin" /> : <CreditCard className="h-16 w-16" />}
              Pagar con tarjeta
              <span className="text-base font-bold text-white/75">En el terminal</span>
            </button>
            <button
              disabled={!!busy}
              onClick={handleCash}
              className="w-full min-h-[120px] bg-neutral-800 active:bg-neutral-700 disabled:opacity-50 rounded-lg text-2xl font-black touch-manipulation flex flex-col items-center justify-center gap-1"
            >
              <Banknote className="h-12 w-12" />
              Pagar en efectivo
              <span className="text-sm font-bold text-neutral-400">En la caja</span>
            </button>
          </div>
        </aside>
      </main>
    </div>
  );
};

export default KioskPayExistingScreen;
