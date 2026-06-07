import React from 'react';
import { Banknote, Utensils } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useKioskBinding } from '../context/KioskBindingContext';
import { useKioskCart } from '../context/KioskCartContext';
import { useKioskCustomer } from '../context/KioskCustomerContext';
import { useIdleTimer } from '../hooks/useIdleTimer';
import type { KioskOpenOrder, KioskSendToKitchenResponse } from '../lib/kioskApi';

const money = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });

interface ChoiceState {
  order: KioskSendToKitchenResponse;
  firstName?: string;
}

// Shown after a dine-in order fires to the kitchen. Customer picks
// "Pagar ahora" (route into the existing pay-existing flow with a synthesized
// KioskOpenOrder built from cart lines) or "Guardar cuenta" (the original
// "Tu comida está en camino" confirmation — pay later at the kiosk).
const KioskPostOrderChoiceScreen: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { tenantId, kioskToken } = useKioskBinding();
  const { lines, clearCart } = useKioskCart();
  const { session, clearSession } = useKioskCustomer();
  useIdleTimer(() => navigate('/'), 90_000);

  const state = (location.state as ChoiceState | null) || null;
  React.useEffect(() => {
    if (!state || !tenantId || !kioskToken) {
      navigate('/', { replace: true });
    }
  }, [state, tenantId, kioskToken, navigate]);

  if (!state) return null;
  const order = state.order;
  const firstName = state.firstName || session?.firstName || order.customer_call_name || null;

  const handleSaveTab = () => {
    navigate('/hold-confirmed', {
      replace: true,
      state: {
        mode: 'kitchen',
        orderId: order.id,
        orderNumber: order.order_number,
        total: order.total,
        firstName: firstName || undefined,
      },
    });
  };

  const handlePayNow = () => {
    // Build a KioskOpenOrder shape from the kitchen response + cart lines,
    // so KioskPayExistingScreen can render the receipt without a re-fetch.
    const items: KioskOpenOrder['items'] = lines.map((line, idx) => ({
      order_item_id: idx + 1,
      menu_item_id: line.menu_item_id,
      item_name: line.name,
      quantity: line.quantity,
      unit_price: line.price,
      modifiers: line.modifiers,
    }));
    const openOrder: KioskOpenOrder = {
      id: order.id,
      order_number: order.order_number,
      subtotal: order.subtotal,
      tax: order.tax,
      total: order.total,
      status: order.status,
      payment_status: order.payment_status,
      customer_call_name: order.customer_call_name,
      order_fulfillment_type: order.order_fulfillment_type,
      created_at: new Date().toISOString(),
      items,
    };
    // We keep the cart and session intact — KioskPayExistingScreen clears them
    // on a successful payment, matching the existing Pagar mi cuenta behavior.
    navigate('/pay-existing', { replace: true, state: { order: openOrder } });
  };

  // Defensive: if cart was cleared (e.g., navigated here directly), block
  // Pagar ahora since we can't render the receipt items.
  const canPayNow = lines.length > 0;

  return (
    <div className="h-full w-full bg-neutral-950 text-white flex flex-col items-center justify-center p-10 text-center">
      <Utensils className="h-24 w-24 text-cockpit-in-text mb-6" />
      <h1 className="text-5xl font-black leading-tight">
        {firstName ? `¡Listo, ${firstName}!` : '¡Listo!'}
      </h1>
      <p className="text-2xl text-neutral-300 font-bold mt-4 max-w-2xl">
        Tu orden ya está con la cocina. ¿Cómo quieres pagar?
      </p>

      <div className="mt-10 grid grid-cols-2 gap-6 max-w-xl w-full">
        <div className="rounded-2xl bg-neutral-900 border border-neutral-800 p-6">
          <p className="text-sm text-neutral-500 font-bold uppercase tracking-wider">Orden</p>
          <p className="text-5xl font-black text-brand-300 mt-1">#{order.order_number}</p>
        </div>
        <div className="rounded-2xl bg-neutral-900 border border-neutral-800 p-6">
          <p className="text-sm text-neutral-500 font-bold uppercase tracking-wider">Total</p>
          <p className="text-5xl font-black mt-1">{money.format(Number(order.total))}</p>
        </div>
      </div>

      <div className="mt-10 grid grid-cols-1 sm:grid-cols-2 gap-4 w-full max-w-2xl">
        <button
          onClick={handleSaveTab}
          className="h-28 rounded-2xl bg-brand-600 active:bg-brand-700 text-2xl font-black touch-manipulation inline-flex flex-col items-center justify-center gap-1 px-6"
        >
          <span className="inline-flex items-center gap-3">
            <Utensils className="h-7 w-7" />
            Guardar cuenta
          </span>
          <span className="text-base font-bold text-white/75">Pago cuando termine</span>
        </button>
        <button
          onClick={handlePayNow}
          disabled={!canPayNow}
          className="h-28 rounded-2xl bg-neutral-800 active:bg-neutral-700 disabled:opacity-50 text-2xl font-black touch-manipulation inline-flex flex-col items-center justify-center gap-1 px-6"
        >
          <span className="inline-flex items-center gap-3">
            <Banknote className="h-7 w-7" />
            Pagar ahora
          </span>
          <span className="text-base font-bold text-neutral-400">Tarjeta o efectivo</span>
        </button>
      </div>

      <p className="mt-6 text-sm text-neutral-500 font-bold">
        Puedes regresar al kiosko en cualquier momento para pagar o agregar más.
      </p>
    </div>
  );
};

export default KioskPostOrderChoiceScreen;
