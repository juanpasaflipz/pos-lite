import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Banknote, CreditCard, Loader2, MapPin, Truck } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useKioskBinding } from '../context/KioskBindingContext';
import { useKioskCart } from '../context/KioskCartContext';
import { useKioskCustomer } from '../context/KioskCustomerContext';
import { useIdleTimer } from '../hooks/useIdleTimer';
import {
  chargeExistingKioskOrderOnTerminal,
  fetchKioskOrderStatus,
  type KioskOpenOrder,
} from '../lib/kioskApi';

import { mxn as money } from '../lib/format';
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
  const { t } = useTranslation();
  const { tenantId, kioskToken, terminalId } = useKioskBinding();
  const { clearCart } = useKioskCart();
  const { clearSession, session } = useKioskCustomer();

  const state = (location.state as LocationState | null) || null;
  const order = state?.order || null;
  const isDelivery = order?.order_fulfillment_type === 'delivery';

  const [busy, setBusy] = useState<'cash' | 'card' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Delivery dispatch result. Seeded from the (now legacy) navigation state;
  // updated from the status poll once the courier is actually booked. In the
  // pay-first flow the seed is always null and the value lands during polling.
  const [deliveryInfo, setDeliveryInfo] = useState(state?.delivery ?? null);
  const [deliveryError, setDeliveryError] = useState<string | null>(state?.deliveryError ?? null);
  const cancelledRef = useRef(false);

  // Stretch idle timeout while a terminal charge is in flight — customer is
  // standing there with their card, not idle.
  const { warning } = useIdleTimer(() => navigate('/'), busy ? 300_000 : 120_000);

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

  // Cash path: purely client-side — the customer walks to the cashier, who
  // finds the order in /api/orders/kiosk-held and collects. What the cashier
  // does with it depends on how the order was born: a draft gets claimed into
  // their cart, while an order already fired to the kitchen gets charged where
  // it stands. Either way we just acknowledge here and clear the tablet.
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
    setMessage(t('pay.sendingToTerminal'));
    try {
      await chargeExistingKioskOrderOnTerminal(auth, order.id, terminalId);
      setMessage(t('pay.payAtTerminal'));

      for (let i = 0; i < POLL_MAX_ITERATIONS; i += 1) {
        if (cancelledRef.current) return;
        await wait(POLL_INTERVAL_MS);
        const status = await fetchKioskOrderStatus(auth, order.id);
        if (status.delivery) setDeliveryInfo(status.delivery);
        if (status.delivery_error) setDeliveryError(status.delivery_error);
        if (status.payment_status === 'paid') {
          // Delivery + dispatch failed: payment cleared but no courier was
          // booked. The cashier needs to rebook from the POS — don't whisk
          // the customer to the happy-path success screen.
          if (isDelivery && status.delivery_error) {
            setError(t('pay.paidNoCourier', { error: status.delivery_error }));
            setMessage(null);
            setBusy(null);
            return;
          }
          clearCart();
          clearSession();
          onPaidSuccess();
          return;
        }
        if (status.payment_status === 'failed') {
          throw new Error(t('pay.paymentFailed'));
        }
      }
      throw new Error(t('pay.terminalTimeout'));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('pay.chargeFailed'));
      setMessage(null);
      setBusy(null);
    }
  };

  return (
    <div className="h-full w-full bg-neutral-950 text-white flex flex-col">
      <header className="px-4 sm:px-6 py-3 sm:py-4 border-b border-neutral-800 flex items-center justify-between pt-safe">
        <button
          disabled={!!busy}
          onClick={() => navigate('/')}
          className="h-11 sm:h-16 px-3 sm:px-5 rounded-lg bg-neutral-800 active:bg-neutral-700 disabled:opacity-50 text-sm sm:text-lg font-bold touch-manipulation inline-flex items-center gap-2"
        >
          <ArrowLeft className="h-4 w-4 sm:h-6 sm:w-6" />
          {t('common.home')}
        </button>
        <h1 className="text-xl sm:text-4xl font-black leading-none">{t('pay.yourTab')}</h1>
        <div className="w-16 sm:w-32" />
      </header>

      {/* Fixed 460px second column only fits a tablet: a fixed grid track
          doesn't shrink, so on a phone it forced the whole layout wider than
          the viewport. Stack order-list-over-payment below lg (1024px), where
          the whole main needs to scroll as one column instead of two
          independently-scrolling panes. */}
      <main className="flex-1 grid grid-cols-1 lg:grid-cols-[1fr_460px] gap-4 sm:gap-6 p-3 sm:p-6 pb-safe min-h-0 overflow-y-auto lg:overflow-hidden">
        <section className="rounded-lg bg-neutral-900 border border-neutral-800 p-4 sm:p-6 lg:overflow-y-auto">
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
          <div className="text-center mb-4 sm:mb-6">
            <p className="text-neutral-400 text-base sm:text-xl font-bold uppercase tracking-wider">{t('common.total')}</p>
            <p className="text-4xl sm:text-[64px] font-black leading-none mt-2">{money.format(Number(order.total))}</p>
            <p className="text-sm text-neutral-500 mt-2 font-bold">
              {t('pay.includesTax', { subtotal: money.format(Number(order.subtotal)) })}
            </p>
          </div>

          {isDelivery && !deliveryInfo && !deliveryError && (
            <div className="mb-4 rounded-lg bg-neutral-900 border border-neutral-800 px-5 py-4 flex items-center gap-3">
              <Truck className="h-6 w-6 text-neutral-400 shrink-0" />
              <p className="text-sm font-bold text-neutral-300">
                {t('pay.courierAfterPay')}
              </p>
            </div>
          )}
          {deliveryInfo && (
            <div className="mb-4 rounded-lg bg-cockpit-green/15 border border-cockpit-green/40 px-5 py-4 space-y-3">
              <div className="flex items-center gap-3">
                <Truck className="h-7 w-7 text-cockpit-in-text shrink-0" />
                <div>
                  <p className="text-lg font-black text-cockpit-in-text">{t('pay.courierOnWay')}</p>
                  <p className="text-sm text-neutral-300">{t('pay.deliveryFee', { fee: money.format(deliveryInfo.fee) })}</p>
                </div>
              </div>
              {deliveryInfo.tracking_url && (
                <a
                  href={deliveryInfo.tracking_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="w-full inline-flex items-center justify-center gap-2 py-3 rounded-lg bg-cockpit-green text-white text-lg font-black"
                >
                  <MapPin className="h-5 w-5" />
                  {t('pay.trackCourier')}
                </a>
              )}
            </div>
          )}
          {deliveryError && (
            <div className="mb-4 rounded-lg bg-cockpit-red/20 border border-cockpit-red/50 px-5 py-3 text-base font-bold text-white">
              {t('pay.dispatchFailed', { error: deliveryError })}
              <p className="text-sm font-normal text-neutral-300 mt-1">{t('pay.posRetry')}</p>
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

          <div className="space-y-3 sm:space-y-4 mt-auto">
            <button
              disabled={!!busy}
              onClick={handleCard}
              className="w-full min-h-[100px] sm:min-h-[160px] bg-brand-600 active:bg-brand-700 disabled:opacity-50 rounded-lg text-xl sm:text-3xl font-black touch-manipulation flex flex-col items-center justify-center gap-1 sm:gap-2"
            >
              {busy === 'card' ? <Loader2 className="h-9 w-9 sm:h-16 sm:w-16 animate-spin" /> : <CreditCard className="h-9 w-9 sm:h-16 sm:w-16" />}
              {t('pay.payWithCard')}
              <span className="text-sm sm:text-base font-bold text-white/75">{t('pay.atTerminal')}</span>
            </button>
            {!isDelivery && (
              <button
                disabled={!!busy}
                onClick={handleCash}
                className="w-full min-h-[80px] sm:min-h-[120px] bg-neutral-800 active:bg-neutral-700 disabled:opacity-50 rounded-lg text-lg sm:text-2xl font-black touch-manipulation flex flex-col items-center justify-center gap-1"
              >
                <Banknote className="h-7 w-7 sm:h-12 sm:w-12" />
                {t('pay.payCash')}
                <span className="text-sm font-bold text-neutral-400">{t('pay.atCounter')}</span>
              </button>
            )}
          </div>
        </aside>
      </main>
      {warning}
    </div>
  );
};

export default KioskPayExistingScreen;
