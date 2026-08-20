// Call-out name capture.
//
// This sits at the very END of the flow: cart → ¿para aquí o para llevar? →
// this screen → payment. The kiosk used to ask for the name up front, before
// the guest had seen the menu. It is a
// full-screen on-screen keyboard rather than a modal because the kiosk has no
// hardware keyboard and the tablet's own IME covers half the screen on Android.
//
// The order already exists by the time this screen mounts — answering "¿para
// aquí o para llevar?" on the previous screen fired it to the kitchen, carrying
// its packaging instruction. The name is the one field left outstanding, and
// it's deferred precisely because it's the one the KDS can render honestly
// without: an unnamed ticket shows its order number.
//
// So this screen is downstream of the point of no return. "Atrás" returns to the
// fulfillment question — which patches, not re-fires — and there is no route
// back to the cart. (Delivery skips both screens; its address form already
// collected a recipient.)
import React, { useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import { useLocation, useNavigate, Navigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useKioskBinding } from '../context/KioskBindingContext';
import { useKioskCart } from '../context/KioskCartContext';
import { useIdleTimer } from '../hooks/useIdleTimer';
import LanguageToggle from '../components/LanguageToggle';
import { identifyKioskOrder, type KioskOpenOrder } from '../lib/kioskApi';
import { formatMoney } from '../lib/format';

const ROWS = ['QWERTYUIOP', 'ASDFGHJKLÑ', 'ZXCVBNM'];
const MAX_LEN = 18;
const BACKSPACE = '⌫';

const KioskCallNameScreen: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();
  const { tenantId, kioskToken } = useKioskBinding();
  const { setCallName } = useKioskCart();

  const placed = (location.state as { order?: KioskOpenOrder } | null)?.order || null;

  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Stretched while the patch is in flight — the guest is standing here waiting
  // on us, not idle.
  const { warning } = useIdleTimer(() => navigate('/'), busy ? 300_000 : 120_000);

  const press = (key: string) => {
    if (busy) return;
    if (key === BACKSPACE) {
      setName((n) => n.slice(0, -1));
      return;
    }
    setName((n) => (n.length < MAX_LEN ? n + key : n));
  };

  const ready = name.trim().length >= 2;

  const confirm = async () => {
    if (!ready || busy || !placed || !tenantId || !kioskToken) return;
    const callName = name.trim();
    setBusy(true);
    setError(null);
    setCallName(callName);
    try {
      const patched = await identifyKioskOrder({ tenantId, kioskToken }, placed.id, {
        customerCallName: callName,
      });
      const openOrder: KioskOpenOrder = {
        ...placed,
        status: patched.status,
        payment_status: patched.payment_status,
        customer_call_name: patched.customer_call_name,
        order_fulfillment_type: patched.order_fulfillment_type,
      };
      navigate('/pay-existing', { replace: true, state: { order: openOrder } });
    } catch (err) {
      setError(err instanceof Error ? err.message : t('cart.sendFailed'));
      setBusy(false);
    }
  };

  // Reached without a placed order — a reload wiped the router state along with
  // the cart. Nothing to name; back to the attract loop.
  if (!placed) return <Navigate to="/" replace />;

  return (
    <div className="h-full w-full bg-neutral-950 text-neutral-50 flex flex-col">
      <header className="flex items-center justify-between gap-3 px-4 py-3 pt-safe border-b border-neutral-800 flex-shrink-0">
        <div className="min-w-0">
          <p className="text-xs font-bold uppercase tracking-[0.12em] text-neutral-500 mb-0.5">
            {t('callName.kicker')}
          </p>
          <h1 className="text-[clamp(22px,4.5vw,40px)] font-black leading-[1.05] truncate">
            {t('callName.prompt')}
          </h1>
        </div>
        <div className="flex gap-2 flex-shrink-0">
          <LanguageToggle />
          <button
            onClick={() => navigate('/fulfillment', { replace: true, state: { order: placed } })}
            disabled={busy}
            className="h-11 px-3.5 rounded-[10px] bg-neutral-800 active:bg-neutral-700 disabled:text-neutral-500 text-sm font-extrabold inline-flex items-center gap-1.5"
          >
            <ChevronLeft className="h-4 w-4" />
            {t('common.back')}
          </button>
        </div>
      </header>

      <main className="flex-1 min-h-0 overflow-y-auto p-4">
        <div className="max-w-[640px] mx-auto flex flex-col gap-[18px]">
          <p className="text-center text-neutral-400 font-bold text-sm">{t('callName.hint')}</p>

          <div className="min-h-[76px] rounded-2xl bg-neutral-900 border-2 border-neutral-700 flex items-center justify-center px-[18px] py-3 text-[clamp(28px,6vw,44px)] font-black tracking-[0.04em]">
            {name}
            <span className="inline-block w-[3px] h-[1em] bg-brand-400 ml-1 motion-safe:animate-pulse" aria-hidden="true" />
          </div>

          <div className="flex flex-col gap-2">
            {ROWS.map((row) => (
              <div key={row} className="flex gap-1.5 justify-center">
                {[...row].map((k) => (
                  <button
                    key={k}
                    onClick={() => press(k)}
                    className="flex-1 max-w-16 min-h-[54px] rounded-[10px] bg-neutral-800 active:bg-brand-600 text-xl font-black touch-manipulation"
                  >
                    {k}
                  </button>
                ))}
              </div>
            ))}
            <div className="flex gap-1.5 justify-center">
              <button
                onClick={() => press(' ')}
                className="flex-[3] min-h-[54px] rounded-[10px] bg-neutral-800 active:bg-brand-600 text-sm font-black tracking-[0.1em] touch-manipulation"
              >
                {t('callName.space')}
              </button>
              <button
                onClick={() => press(BACKSPACE)}
                aria-label={t('common.back')}
                className="flex-1 max-w-16 min-h-[54px] rounded-[10px] bg-neutral-800 active:bg-brand-600 text-xl font-black touch-manipulation"
              >
                {BACKSPACE}
              </button>
            </div>
          </div>

          {error && <p className="text-center text-cockpit-out-text font-bold">{error}</p>}
        </div>
      </main>

      <footer className="flex flex-col gap-2.5 px-4 py-3 pb-safe border-t border-neutral-800 flex-shrink-0">
        <button
          onClick={confirm}
          disabled={!ready || busy}
          className="w-full min-h-[56px] rounded-[14px] px-5 py-3 text-[18px] font-black text-white bg-brand-600 active:bg-brand-700 disabled:bg-neutral-800 disabled:text-neutral-500 flex items-center justify-between gap-2.5 active:scale-[0.98] transition-transform"
        >
          <span>{busy ? t('callName.processing') : t('callName.pay')}</span>
          {/* From the placed order, not the local cart. The order is the
              authoritative total by now, and a reload mid-flow restores this
              screen's router state (history.state survives) while resetting the
              cart context — reading the cart here showed $0 against a real
              $190 ticket.

              Number() is load-bearing, not defensive: postgres.js hands back
              NUMERIC columns as strings, so `total` is "190.00" and the
              formatter would coerce it wrong.
              Every other read of these order fields wraps them the same way
              (see KioskPayExistingScreen). */}
          <small className="text-sm font-bold opacity-80">{formatMoney(Number(placed.total))}</small>
        </button>
      </footer>

      {warning}
    </div>
  );
};

export default KioskCallNameScreen;
