import React, { useEffect, useState } from 'react';
import { CheckCircle2, Gift, Plus, Store, Utensils, Wallet } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useKioskCart } from '../context/KioskCartContext';
import { useKioskCustomer } from '../context/KioskCustomerContext';
import { useKioskBinding } from '../context/KioskBindingContext';
import { fetchLoyaltyJoinUrl, fetchWalletEnroll } from '../lib/kioskApi';

type ConfirmMode = 'hold' | 'kitchen' | 'appended' | 'paid' | 'cash-counter';

interface HoldState {
  mode?: ConfirmMode;
  orderId?: number;
  orderNumber: string | number;
  total: number;
  firstName?: string;
  /** Only set for the 'appended' mode — how many units we just added. */
  addedCount?: number;
}

const money = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });
// Dine-in / appended / paid clears faster so the tablet rolls to the next customer.
// Takeaway hold lingers because the cashier needs time to walk over.
const COUNTDOWN_BY_MODE: Record<ConfirmMode, number> = {
  hold: 30,
  kitchen: 12,
  appended: 10,
  paid: 12,
  'cash-counter': 15,
};

const KioskHoldConfirmationScreen: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();
  const { clearCart } = useKioskCart();
  const { session, clearSession } = useKioskCustomer();
  const { tenantId, tenantName, kioskToken } = useKioskBinding();
  const [walletUrl, setWalletUrl] = useState<string | null>(null);
  const [joinUrl, setJoinUrl] = useState<string | null>(null);

  const state = (location.state as HoldState | null) || null;
  const validModes = new Set<ConfirmMode>(['hold', 'kitchen', 'appended', 'paid', 'cash-counter']);
  const mode: ConfirmMode = validModes.has(state?.mode as ConfirmMode)
    ? (state!.mode as ConfirmMode)
    : 'hold';
  const [seconds, setSeconds] = useState(COUNTDOWN_BY_MODE[mode]);

  useEffect(() => {
    if (!state) {
      navigate('/', { replace: true });
    }
  }, [state, navigate]);

  // Identified customer → offer their Apple Wallet stamp card. Best-effort:
  // any failure (or a card already on a device) just hides the panel.
  useEffect(() => {
    if (!state || !session?.customerToken || !tenantId || !kioskToken) return;
    let cancelled = false;
    fetchWalletEnroll({ tenantId, kioskToken }, session.customerToken)
      .then((r) => {
        if (cancelled || !r.available || r.registered || !r.enroll_url) return;
        setWalletUrl(r.enroll_url);
        setSeconds((s) => Math.max(s, 40));
      })
      .catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Un-identified customer with a paid order → offer the loyalty-join QR.
  // The public page handles both "already enrolled" (link + credit) and "new"
  // (enroll + credit) in one form, so we don't need to know upfront.
  useEffect(() => {
    if (!state?.orderId) return;
    if (session?.customerToken) return; // identified path already offers wallet QR
    if (mode !== 'paid' && mode !== 'kitchen' && mode !== 'cash-counter') return;
    if (!tenantId || !kioskToken) return;
    let cancelled = false;
    fetchLoyaltyJoinUrl({ tenantId, kioskToken }, state.orderId)
      .then((url) => {
        if (cancelled || !url) return;
        setJoinUrl(url);
        setSeconds((s) => Math.max(s, 45));
      })
      .catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!state) return;
    const id = setInterval(() => {
      setSeconds((s) => {
        if (s <= 1) {
          clearInterval(id);
          clearCart();
          clearSession();
          navigate('/', { replace: true });
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [state, navigate, clearCart, clearSession]);

  if (!state) return null;

  const handleAddMore = () => {
    // Hold mode: cart + session stay intact so the next "Llamar a la caja"
    // supersedes the existing held draft on the server (same draft updates).
    // Kitchen mode: the order is already fired and unchangeable from the kiosk
    // here — to add more, the customer goes back through "Agregar a mi orden"
    // on Welcome, which uses the append-items endpoint. We just send them
    // back to Welcome.
    if (mode === 'kitchen') {
      clearCart();
      clearSession();
      navigate('/', { replace: true });
      return;
    }
    navigate('/menu', { replace: true });
  };

  const handleDone = () => {
    clearCart();
    clearSession();
    navigate('/', { replace: true });
  };

  const isKitchen = mode === 'kitchen';
  const isAppended = mode === 'appended';
  const isPaid = mode === 'paid';
  const isCashCounter = mode === 'cash-counter';
  const showsBigOrderCard = !isAppended;

  let heading: string;
  if (isPaid) {
    heading = state.firstName ? t('confirm.thanksName', { name: state.firstName }) : t('confirm.thanks');
  } else if (isCashCounter) {
    heading = state.firstName ? t('confirm.goToCashierName', { name: state.firstName }) : t('confirm.goToCashier');
  } else if (isAppended) {
    heading = state.firstName ? t('confirm.addedHeadingName', { name: state.firstName }) : t('confirm.addedHeading');
  } else {
    heading = state.firstName ? t('confirm.readyName', { name: state.firstName }) : t('confirm.ready');
  }

  let subheading: string;
  if (isPaid) {
    subheading = t('confirm.paidSub');
  } else if (isCashCounter) {
    subheading = t('confirm.cashSub', { total: money.format(state.total) });
  } else if (isAppended) {
    subheading = typeof state.addedCount === 'number'
      ? t('confirm.appendedSub', { count: state.addedCount, total: money.format(state.total) })
      : t('confirm.appendedSubUnknown', { total: money.format(state.total) });
  } else if (isKitchen) {
    subheading = t('confirm.kitchenSub');
  } else {
    subheading = t('confirm.holdSub');
  }

  return (
    <div className="h-full w-full bg-neutral-950 text-white flex flex-col items-center justify-center p-10 text-center">
      {isKitchen || isAppended ? (
        <Utensils className="h-28 w-28 text-cockpit-in-text mb-6" />
      ) : (
        <CheckCircle2 className="h-28 w-28 text-cockpit-in-text mb-6" />
      )}
      <h1 className="text-5xl font-black leading-tight">{heading}</h1>
      <p className="text-2xl text-neutral-300 font-bold mt-4 max-w-2xl">{subheading}</p>

      {showsBigOrderCard && (
        <div className="mt-10 grid grid-cols-2 gap-6 max-w-xl w-full">
          <div className="rounded-2xl bg-neutral-900 border border-neutral-800 p-6 min-w-0">
            <p className="text-sm text-neutral-500 font-bold uppercase tracking-wider">{t('confirm.order')}</p>
            <p className="text-4xl font-black text-brand-300 mt-1 tabular-nums truncate">#{state.orderNumber}</p>
          </div>
          <div className="rounded-2xl bg-neutral-900 border border-neutral-800 p-6 min-w-0">
            <p className="text-sm text-neutral-500 font-bold uppercase tracking-wider">{t('common.total')}</p>
            <p className="text-4xl font-black mt-1 tabular-nums truncate">{money.format(state.total)}</p>
          </div>
        </div>
      )}

      {walletUrl && (
        <div className="mt-8 rounded-2xl bg-neutral-900 border border-neutral-800 p-6 max-w-2xl w-full flex items-center gap-6 text-left">
          <div className="bg-white rounded-xl p-3 shrink-0">
            <QRCodeSVG value={walletUrl} size={240} level="M" />
          </div>
          <div className="min-w-0">
            <p className="text-xl font-black inline-flex items-center gap-2">
              <Wallet className="h-6 w-6 text-brand-300 shrink-0" />
              {t('confirm.walletTitle')}
            </p>
            <p className="text-neutral-300 font-bold mt-2">
              {t('confirm.walletScan')}
              {session?.stamp
                ? ` ${t('confirm.walletStamps', { earned: session.stamp.earned, required: session.stamp.required })}`
                : ''}
            </p>
            <p className="text-neutral-500 text-sm font-bold mt-2">
              {t('confirm.walletAuto')}
            </p>
          </div>
        </div>
      )}

      {joinUrl && !walletUrl && (
        <div className="mt-8 rounded-2xl bg-neutral-900 border border-neutral-800 p-6 max-w-2xl w-full flex items-center gap-6 text-left">
          <div className="bg-white rounded-xl p-3 shrink-0">
            <QRCodeSVG value={joinUrl} size={240} level="M" />
          </div>
          <div className="min-w-0">
            <p className="text-xl font-black inline-flex items-center gap-2">
              <Gift className="h-6 w-6 text-brand-300 shrink-0" />
              {tenantName ? t('confirm.joinTitleTenant', { tenant: tenantName }) : t('confirm.joinTitle')}
            </p>
            <p className="text-neutral-300 font-bold mt-2">
              {t('confirm.joinScan')}
            </p>
            <p className="text-neutral-500 text-sm font-bold mt-2">
              {t('confirm.joinAnyone')}
            </p>
          </div>
        </div>
      )}

      {isKitchen || isAppended || isPaid || isCashCounter ? (
        // Single big "Listo" for any flow where the customer's task is done.
        // Adding more requires going back through Agregar a mi orden from
        // Welcome, so we don't expose a misleading "Agregar más" here that
        // would silently create a separate order.
        <div className="mt-10 w-full max-w-xl">
          <button
            onClick={handleDone}
            className="w-full h-20 rounded-2xl bg-brand-600 active:bg-brand-700 text-2xl font-black touch-manipulation inline-flex items-center justify-center gap-3"
          >
            <Store className="h-7 w-7" />
            {t('confirm.done')} · {seconds}s
          </button>
        </div>
      ) : (
        <div className="mt-10 grid grid-cols-1 sm:grid-cols-2 gap-4 w-full max-w-xl">
          <button
            onClick={handleAddMore}
            className="h-20 rounded-2xl bg-brand-600 active:bg-brand-700 text-2xl font-black touch-manipulation inline-flex items-center justify-center gap-3"
          >
            <Plus className="h-7 w-7" />
            {t('confirm.addMore')}
          </button>
          <button
            onClick={handleDone}
            className="h-20 rounded-2xl bg-neutral-800 active:bg-neutral-700 text-2xl font-black touch-manipulation inline-flex items-center justify-center gap-3"
          >
            <Store className="h-7 w-7" />
            {t('confirm.done')} · {seconds}s
          </button>
        </div>
      )}

      <p className="mt-6 text-sm text-neutral-500 font-bold">
        {t('confirm.autoClose', { seconds })}
      </p>
    </div>
  );
};

export default KioskHoldConfirmationScreen;
