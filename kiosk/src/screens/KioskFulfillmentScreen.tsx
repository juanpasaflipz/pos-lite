// "¿Para aquí o para llevar?" — and the moment the order becomes real.
//
// Asked at the END of the flow, after the cart. It used to come first, before
// the guest had seen a single item.
//
// The answer FIRES the kitchen ticket rather than merely being recorded on the
// way to one. Two reasons it happens on this tap and not the cart's:
//   - The kitchen starts a screen earlier than it would if we waited for the
//     name, which is the slowest step in the flow (on-screen keyboard).
//   - The ticket carries its packaging instruction from the first frame the
//     line ever sees it. Firing from the cart would mean a window where the
//     order is being cooked with "para aquí / para llevar" still unknown, and
//     a wrong guess there is an error nobody downstream can detect.
// The call-out name is the only thing left deferred, because a nameless ticket
// is a state the KDS has always rendered honestly (it shows the order number).
//
// So this screen is the point of no return, and it is deliberately the LAST one
// that offers a way back to the cart.
import React, { useState } from 'react';
import { ChevronLeft, ShoppingBag, Utensils } from 'lucide-react';
import { useLocation, useNavigate, Navigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useKioskBinding } from '../context/KioskBindingContext';
import { useKioskCart, type KioskFulfillmentType } from '../context/KioskCartContext';
import { useKioskCustomer } from '../context/KioskCustomerContext';
import { useIdleTimer } from '../hooks/useIdleTimer';
import LanguageToggle from '../components/LanguageToggle';
import { identifyKioskOrder, type KioskOpenOrder } from '../lib/kioskApi';
import { fireKioskOrder } from '../lib/placeOrder';

const KioskFulfillmentScreen: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();
  const { tenantId, kioskToken } = useKioskBinding();
  const { lines, setFulfillmentType } = useKioskCart();
  const { session } = useKioskCustomer();

  // Present only when the guest came BACK here from the name screen to change
  // their answer. The ticket already exists in that case, so the tap patches it
  // instead of firing a second one.
  const placed = (location.state as { order?: KioskOpenOrder } | null)?.order || null;

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Stretched while the ticket is in flight — the guest is waiting on us.
  const { warning } = useIdleTimer(() => navigate('/'), busy ? 300_000 : 60_000);

  const choose = async (type: KioskFulfillmentType) => {
    if (busy || !tenantId || !kioskToken) return;
    setFulfillmentType(type);
    setBusy(true);
    setError(null);
    try {
      if (placed) {
        const patched = await identifyKioskOrder({ tenantId, kioskToken }, placed.id, {
          fulfillmentType: type,
        });
        navigate('/name', {
          state: { order: { ...placed, order_fulfillment_type: patched.order_fulfillment_type } },
        });
        return;
      }
      const order = await fireKioskOrder({ tenantId, kioskToken }, lines, session, type);
      navigate('/name', { state: { order } });
    } catch (err) {
      setError(err instanceof Error ? err.message : t('cart.sendFailed'));
      setBusy(false);
    }
  };

  // No ticket and no cart — a reload wiped the local cart, so there is nothing
  // to order. Back to the attract loop.
  if (!placed && lines.length === 0) return <Navigate to="/" replace />;

  return (
    <div className="h-full w-full bg-neutral-950 text-white flex flex-col">
      {/* This screen used to open the flow and so had nowhere to go back to.
          Sitting after the cart — and being the last screen before the ticket
          exists — it needs a way out that isn't waiting for the idle timer. */}
      <header className="px-4 sm:px-6 py-3 pt-safe flex-shrink-0">
        {!placed && (
          <button
            onClick={() => navigate('/cart')}
            disabled={busy}
            className="h-11 sm:h-14 px-3 sm:px-5 rounded-lg bg-neutral-800 active:bg-neutral-700 disabled:text-neutral-500 text-sm sm:text-lg font-bold touch-manipulation inline-flex items-center gap-2"
          >
            <ChevronLeft className="h-4 w-4 sm:h-6 sm:w-6" />
            {t('common.back')}
          </button>
        )}
      </header>

      <main className="flex-1 px-5 pb-6 sm:px-10 sm:pb-10 flex flex-col items-center justify-center pb-safe">
        <h1 className="text-3xl sm:text-5xl xl:text-6xl font-black text-center leading-tight sm:leading-none mb-6 sm:mb-10">
          {t('fulfillment.howDoYouWantIt')}
        </h1>

        {/* Two side-by-side 360px-tall boxes were designed for the tablet's
            wide viewport. On a phone, stack them so each still reads as a big
            tap target instead of squeezing two into ~150px each. */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6 w-full max-w-4xl">
          <button
            onClick={() => choose('for_here')}
            disabled={busy}
            className="min-h-[140px] sm:min-h-[360px] rounded-lg bg-brand-600 active:bg-brand-700 disabled:opacity-50 text-white touch-manipulation flex flex-col items-center justify-center gap-3 sm:gap-7 px-6"
          >
            <Utensils className="h-10 w-10 sm:h-24 sm:w-24" />
            <span className="text-2xl sm:text-4xl xl:text-5xl font-black leading-none text-center">{t('fulfillment.forHere')}</span>
          </button>

          <button
            onClick={() => choose('to_go')}
            disabled={busy}
            className="min-h-[140px] sm:min-h-[360px] rounded-lg bg-neutral-800 active:bg-neutral-700 disabled:opacity-50 text-white touch-manipulation flex flex-col items-center justify-center gap-3 sm:gap-7 px-6"
          >
            <ShoppingBag className="h-10 w-10 sm:h-24 sm:w-24" />
            <span className="text-2xl sm:text-4xl xl:text-5xl font-black leading-none text-center">{t('fulfillment.toGo')}</span>
          </button>
        </div>

        {busy && (
          <p className="text-center text-neutral-400 font-bold text-lg mt-8">{t('fulfillment.sending')}</p>
        )}
        {error && (
          <p className="text-center text-cockpit-out-text font-bold text-lg mt-8">{error}</p>
        )}
      </main>
      {warning}
    </div>
  );
};

export default KioskFulfillmentScreen;
