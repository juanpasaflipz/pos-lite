import React, { useState } from 'react';
import { ArrowLeft, Minus, Plus, Trash2, Truck, Utensils } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useKioskBinding } from '../context/KioskBindingContext';
import { useKioskCart } from '../context/KioskCartContext';
import { useKioskCustomer } from '../context/KioskCustomerContext';
import { useIdleTimer } from '../hooks/useIdleTimer';
import {
  sendKioskDeliveryOrder,
  logSuggestionEvents,
  type KioskOpenOrder,
} from '../lib/kioskApi';
import { orderedSuggestionEvents } from '../lib/suggestionTelemetry';
import CartUpsellStrip from '../components/CartUpsellStrip';

import { mxn as money } from '../lib/format';

const KioskCartScreen: React.FC = () => {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { tenantId, kioskToken } = useKioskBinding();
  const { session } = useKioskCustomer();
  const { lines, count, total, callName, fulfillmentType, delivery, incrementLine, decrementLine, removeLine } = useKioskCart();
  const [holding, setHolding] = useState(false);
  const [holdError, setHoldError] = useState<string | null>(null);
  const { warning } = useIdleTimer(() => navigate('/'), 120_000);

  // Two ways out of the cart:
  //   - Delivery:  customer chose "A domicilio" and the address screen already
  //                captured the recipient, so there's nothing left to ask.
  //                Submit here creates the order AND dispatches an Uber Direct
  //                courier in one server call, then pay at terminal.
  //   - Dine-in / Takeout: hand off to /fulfillment, which fires the kitchen
  //                ticket the moment the guest answers "¿para aquí o para
  //                llevar?" — one tap from here, and with the packaging
  //                instruction already on it. Nothing is on the server until
  //                then, so the cart stays editable right up to that answer.
  const isDelivery = fulfillmentType === 'delivery';

  const submitDeliveryOrder = async (resolvedCallName: string | null) => {
    if (!tenantId || !kioskToken || lines.length === 0 || holding) return;
    setHolding(true);
    setHoldError(null);
    try {
      const apiItems = lines.map((line) => ({
        menu_item_id: line.menu_item_id,
        quantity: line.quantity,
        modifier_ids: line.modifiers.map((m) => m.id),
      }));

      const logOrdered = () =>
        logSuggestionEvents(
          { tenantId, kioskToken },
          session?.customerToken ?? null,
          orderedSuggestionEvents(session, lines),
        );

      if (!delivery) {
        setHoldError(t('cart.deliveryDataMissing'));
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
      logOrdered();
      const openOrder: KioskOpenOrder = {
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
    } catch (err) {
      setHoldError(
        err instanceof Error
          ? err.message
          : t('cart.sendFailed')
      );
      setHolding(false);
    }
  };

  const handlePrimary = () => {
    if (count === 0 || holding) return;
    // Delivery is already fully specified by the address screen, so it submits
    // straight from here. Everything else goes on to answer "¿para aquí o para
    // llevar?", which is where the order gets created.
    if (isDelivery) {
      submitDeliveryOrder(callName || delivery?.recipientName || null);
      return;
    }
    navigate('/fulfillment');
  };

  return (
    <div className="h-full w-full bg-neutral-950 text-white flex flex-col">
      <header className="px-4 sm:px-6 py-3 sm:py-4 border-b border-neutral-800 grid grid-cols-[auto_1fr_auto] items-center gap-2 sm:gap-4 pt-safe">
        <button
          onClick={() => navigate('/menu')}
          className="h-11 sm:h-16 px-3 sm:px-5 rounded-lg bg-neutral-800 active:bg-neutral-700 text-sm sm:text-lg font-bold touch-manipulation inline-flex items-center gap-2"
        >
          <ArrowLeft className="h-4 w-4 sm:h-6 sm:w-6" />
          {t('common.menu')}
        </button>
        <h1 className="text-xl sm:text-4xl font-black text-center leading-none">{t('cart.title')}</h1>
        <div className="text-right">
          <p className="text-xs sm:text-sm text-neutral-500 font-bold uppercase">{t('common.total')}</p>
          <p className="text-lg sm:text-2xl font-black text-brand-300">{money.format(total)}</p>
        </div>
      </header>

      <main className="flex-1 min-h-0 p-3 sm:p-5 overflow-y-auto">
        {lines.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center gap-6 text-neutral-400">
            <p className="text-3xl font-black">{t('cart.empty')}</p>
            <button
              onClick={() => navigate('/menu')}
              className="h-16 px-8 rounded-lg bg-brand-600 text-white text-xl font-black"
            >
              {t('cart.viewMenu')}
            </button>
          </div>
        ) : (
          <div className="space-y-3 sm:space-y-4">
            {lines.map((line) => (
              // A fixed 256px control column was tablet-only — on a phone it
              // left almost no room for the item name. Stack name-over-controls
              // below sm (640px), restore the side-by-side layout above it.
              <div key={line.line_key} className="rounded-lg bg-neutral-900 border border-neutral-800 p-4 sm:p-5 flex flex-col gap-3 sm:grid sm:grid-cols-[1fr_256px] sm:gap-4 sm:items-center">
                <div className="min-w-0">
                  <h2 className="text-xl sm:text-[32px] font-black leading-tight sm:leading-[1.05]">{line.name}</h2>
                  {line.modifiers.length > 0 && (
                    <p className="text-sm sm:text-base text-neutral-400 mt-1">
                      {line.modifiers.map((m) => m.name).join(' · ')}
                    </p>
                  )}
                  <p className="text-base sm:text-xl text-neutral-400 mt-1 sm:mt-2">
                    {money.format(line.price)} {t('cart.perUnit')} · {money.format(line.price * line.quantity)}
                  </p>
                </div>
                <div className="grid grid-cols-[56px_64px_56px] sm:grid-cols-[64px_72px_64px] gap-2 sm:gap-3 justify-end">
                  <button
                    onClick={() => decrementLine(line.line_key)}
                    className="h-12 w-14 sm:h-16 sm:w-16 rounded-lg bg-neutral-800 active:bg-neutral-700 flex items-center justify-center"
                    aria-label={t('cart.less')}
                  >
                    <Minus className="h-5 w-5 sm:h-8 sm:w-8" />
                  </button>
                  <div className="h-12 w-16 sm:h-16 sm:w-[72px] rounded-lg bg-neutral-950 flex items-center justify-center text-xl sm:text-3xl font-black">
                    {line.quantity}
                  </div>
                  <button
                    onClick={() => incrementLine(line.line_key)}
                    className="h-12 w-14 sm:h-16 sm:w-16 rounded-lg bg-neutral-800 active:bg-neutral-700 flex items-center justify-center"
                    aria-label={t('cart.more')}
                  >
                    <Plus className="h-5 w-5 sm:h-8 sm:w-8" />
                  </button>
                  <button
                    onClick={() => removeLine(line.line_key)}
                    className="col-span-3 h-11 sm:h-14 rounded-lg bg-cockpit-red/30 active:bg-cockpit-red/50 flex items-center justify-center gap-2 text-base sm:text-lg font-black"
                    aria-label={t('cart.remove')}
                  >
                    <Trash2 className="h-5 w-5 sm:h-6 sm:w-6" />
                    {t('cart.remove')}
                  </button>
                </div>
              </div>
            ))}
            <CartUpsellStrip />
          </div>
        )}
      </main>

      <footer className="p-3 sm:p-4 border-t border-neutral-800 bg-neutral-950 space-y-3 pb-safe">
        {holdError && (
          <p className="text-cockpit-out-text text-base font-bold text-center">{holdError}</p>
        )}
        {isDelivery && delivery && (
          <div className="rounded-lg bg-cockpit-green/15 border border-cockpit-green/40 px-4 py-3 grid grid-cols-[auto_1fr_auto] items-center gap-3">
            <Truck className="h-6 w-6 text-cockpit-in-text" />
            <div className="min-w-0">
              <p className="text-sm text-neutral-400 font-bold uppercase">{t('cart.homeDelivery')}</p>
              <p className="text-base font-bold truncate">{delivery.address}</p>
            </div>
            <p className="text-xl font-black text-cockpit-in-text">{money.format(delivery.quoteFee || 0)}</p>
          </div>
        )}
        <button
          disabled={count === 0 || holding}
          onClick={handlePrimary}
          className="w-full min-h-16 sm:min-h-20 bg-brand-600 active:bg-brand-700 disabled:bg-neutral-800 disabled:text-neutral-500 rounded-lg py-3 sm:py-4 px-4 sm:px-6 text-xl sm:text-3xl font-black touch-manipulation flex items-center justify-between gap-4"
        >
          <span className="inline-flex items-center gap-3">
            {isDelivery ? <Truck className="h-5 w-5 sm:h-7 sm:w-7" /> : <Utensils className="h-5 w-5 sm:h-7 sm:w-7" />}
            {holding
              ? (isDelivery ? t('cart.requestingCourier') : t('cart.oneMoment'))
              : (isDelivery ? t('cart.orderAndPay') : t('cart.continueToPay'))}
          </span>
          <span>{money.format(total + (isDelivery ? (delivery?.quoteFee || 0) : 0))}</span>
        </button>
        <p className="text-center text-sm text-neutral-500 font-bold">
          {isDelivery ? t('cart.deliveryFootnote') : t('cart.payFootnote')}
        </p>
      </footer>

      {warning}
    </div>
  );
};

export default KioskCartScreen;
