import React, { useState } from 'react';
import { ArrowLeft, Minus, Plus, Trash2, Truck, Utensils } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useKioskBinding } from '../context/KioskBindingContext';
import { useKioskCart } from '../context/KioskCartContext';
import { useKioskCustomer } from '../context/KioskCustomerContext';
import { useIdleTimer } from '../hooks/useIdleTimer';
import {
  sendKioskDeliveryOrder,
  sendKioskOrderToKitchen,
  type KioskOpenOrder,
} from '../lib/kioskApi';
import CartUpsellStrip from '../components/CartUpsellStrip';
import KioskCallNameModal from '../components/KioskCallNameModal';

const money = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });

const KioskCartScreen: React.FC = () => {
  const navigate = useNavigate();
  const { tenantId, kioskToken } = useKioskBinding();
  const { session } = useKioskCustomer();
  const { lines, count, total, callName, fulfillmentType, delivery, incrementLine, decrementLine, removeLine, setCallName } = useKioskCart();
  const [holding, setHolding] = useState(false);
  const [holdError, setHoldError] = useState<string | null>(null);
  const [askingName, setAskingName] = useState(false);
  useIdleTimer(() => navigate('/'), 60_000);

  // Two submit modes — both pay-when-ordering:
  //   - Delivery:  customer chose "A domicilio" — a draft was captured on the
  //                address screen. Submit creates the order AND dispatches an
  //                Uber Direct courier in one server call, then pay at terminal.
  //   - Dine-in / Takeout: fire to kitchen, then route to /pay-existing. Para
  //                Aquí and Para Llevar share the same submit + UI path.
  const isDelivery = fulfillmentType === 'delivery';

  const submitOrder = async (resolvedCallName: string | null) => {
    if (!tenantId || !kioskToken || lines.length === 0 || holding) return;
    setHolding(true);
    setHoldError(null);
    try {
      const apiItems = lines.map((line) => ({
        menu_item_id: line.menu_item_id,
        quantity: line.quantity,
        modifier_ids: line.modifiers.map((m) => m.id),
      }));

      if (isDelivery) {
        if (!delivery) {
          setHoldError('Faltan los datos de envío. Regresa a "A domicilio".');
          setHolding(false);
          return;
        }
        const result = await sendKioskDeliveryOrder({ tenantId, kioskToken }, apiItems, {
          customerToken: session?.customerToken ?? null,
          customerCallName: resolvedCallName || delivery.recipientName,
          dropoffAddress: delivery.address,
          dropoffPhoneNumber: delivery.phone,
          dropoffName: delivery.recipientName,
          dropoffNotes: delivery.notes,
          quoteId: delivery.quoteId,
        });
        const openOrder = {
          id: result.id,
          order_number: result.order_number,
          subtotal: result.subtotal,
          tax: result.tax,
          total: result.total,
          status: result.status,
          payment_status: result.payment_status,
          customer_call_name: result.customer_call_name,
          order_fulfillment_type: result.order_fulfillment_type,
          created_at: new Date().toISOString(),
          items: lines.map((line, idx) => ({
            order_item_id: idx + 1,
            menu_item_id: line.menu_item_id,
            item_name: line.name,
            quantity: line.quantity,
            unit_price: line.price,
            modifiers: line.modifiers,
          })),
        };
        navigate('/pay-existing', {
          replace: true,
          state: { order: openOrder, delivery: result.delivery, deliveryError: result.delivery_error },
        });
        return;
      }

      const opts = {
        customerToken: session?.customerToken ?? null,
        customerCallName: resolvedCallName,
        fulfillmentType,
      };
      const order = await sendKioskOrderToKitchen({ tenantId, kioskToken }, apiItems, opts);
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
        items: lines.map((line, idx) => ({
          order_item_id: idx + 1,
          menu_item_id: line.menu_item_id,
          item_name: line.name,
          quantity: line.quantity,
          unit_price: line.price,
          modifiers: line.modifiers,
        })),
      };
      navigate('/pay-existing', { replace: true, state: { order: openOrder } });
    } catch (err) {
      setHoldError(
        err instanceof Error
          ? err.message
          : 'No se pudo enviar a la cocina'
      );
      setHolding(false);
    }
  };

  const handlePrimary = () => {
    if (count === 0 || holding) return;
    // Delivery captured the recipient name on the address screen — skip the
    // call-name modal entirely.
    if (isDelivery) {
      submitOrder(callName || delivery?.recipientName || null);
      return;
    }
    if (session) {
      submitOrder(null);
      return;
    }
    if (callName) {
      submitOrder(callName);
      return;
    }
    setAskingName(true);
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
              <div key={line.line_key} className="rounded-lg bg-neutral-900 border border-neutral-800 p-5 grid grid-cols-[1fr_256px] gap-4 items-center">
                <div className="min-w-0">
                  <h2 className="text-[32px] font-black leading-[1.05]">{line.name}</h2>
                  {line.modifiers.length > 0 && (
                    <p className="text-base text-neutral-400 mt-1">
                      {line.modifiers.map((m) => m.name).join(' · ')}
                    </p>
                  )}
                  <p className="text-xl text-neutral-400 mt-2">
                    {money.format(line.price)} c/u · {money.format(line.price * line.quantity)}
                  </p>
                </div>
                <div className="grid grid-cols-[64px_72px_64px] gap-3 justify-end">
                  <button
                    onClick={() => decrementLine(line.line_key)}
                    className="h-16 w-16 rounded-lg bg-neutral-800 active:bg-neutral-700 flex items-center justify-center"
                    aria-label="Menos"
                  >
                    <Minus className="h-8 w-8" />
                  </button>
                  <div className="h-16 w-[72px] rounded-lg bg-neutral-950 flex items-center justify-center text-3xl font-black">
                    {line.quantity}
                  </div>
                  <button
                    onClick={() => incrementLine(line.line_key)}
                    className="h-16 w-16 rounded-lg bg-neutral-800 active:bg-neutral-700 flex items-center justify-center"
                    aria-label="Mas"
                  >
                    <Plus className="h-8 w-8" />
                  </button>
                  <button
                    onClick={() => removeLine(line.line_key)}
                    className="col-span-3 h-14 rounded-lg bg-cockpit-red/30 active:bg-cockpit-red/50 flex items-center justify-center gap-2 text-lg font-black"
                    aria-label="Quitar"
                  >
                    <Trash2 className="h-6 w-6" />
                    Quitar
                  </button>
                </div>
              </div>
            ))}
            <CartUpsellStrip />
          </div>
        )}
      </main>

      <footer className="p-4 border-t border-neutral-800 bg-neutral-950 space-y-3">
        {holdError && (
          <p className="text-cockpit-out-text text-base font-bold text-center">{holdError}</p>
        )}
        {isDelivery && delivery && (
          <div className="rounded-lg bg-cockpit-green/15 border border-cockpit-green/40 px-4 py-3 grid grid-cols-[auto_1fr_auto] items-center gap-3">
            <Truck className="h-6 w-6 text-cockpit-in-text" />
            <div className="min-w-0">
              <p className="text-sm text-neutral-400 font-bold uppercase">Envío a domicilio</p>
              <p className="text-base font-bold truncate">{delivery.address}</p>
            </div>
            <p className="text-xl font-black text-cockpit-in-text">{money.format(delivery.quoteFee || 0)}</p>
          </div>
        )}
        <button
          disabled={count === 0 || holding}
          onClick={handlePrimary}
          className="w-full min-h-20 bg-brand-600 active:bg-brand-700 disabled:bg-neutral-800 disabled:text-neutral-500 rounded-lg py-4 px-6 text-3xl font-black touch-manipulation flex items-center justify-between gap-4"
        >
          <span className="inline-flex items-center gap-3">
            {isDelivery ? <Truck className="h-7 w-7" /> : <Utensils className="h-7 w-7" />}
            {holding
              ? (isDelivery ? 'Pidiendo repartidor…' : 'Enviando a la cocina…')
              : (isDelivery ? 'Pedir y pagar' : 'Enviar a la cocina')}
          </span>
          <span>{money.format(total + (isDelivery ? (delivery?.quoteFee || 0) : 0))}</span>
        </button>
        <p className="text-center text-sm text-neutral-500 font-bold">
          {isDelivery
            ? 'Cobramos en la terminal. Llega un repartidor de Uber con tu pedido.'
            : 'Te llamamos por tu nombre cuando esté lista. Pagas en la terminal.'}
        </p>
      </footer>

      {askingName && (
        <KioskCallNameModal
          required
          title="¿A nombre de quién?"
          subtitle="Usamos tu nombre para llamarte cuando esté lista."
          onSkip={() => setAskingName(false)}
          onConfirm={(name) => {
            setCallName(name);
            setAskingName(false);
            submitOrder(name);
          }}
        />
      )}
    </div>
  );
};

export default KioskCartScreen;
