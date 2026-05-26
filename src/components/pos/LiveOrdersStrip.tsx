import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Clock,
  Check,
  CreditCard,
  Bike,
  Smartphone,
  QrCode,
  Utensils,
  ShoppingBag,
  User,
  ChevronRight,
} from 'lucide-react';
import { getKitchenOrders, updateOrderStatus } from '../../api';
import { Order } from '../../types';
import { getTimeTier, isPaid, type TimeTier } from '../../lib/orderUrgency';

interface LiveOrdersStripProps {
  /** Opens the full slide-over with all details + history. */
  onViewAll: () => void;
  /** Opens the existing Cobrar flow for an unpaid order. */
  onCharge: (order: Order) => void;
  /** External signal to refetch (e.g. after a new order is rung up). */
  refreshKey?: number;
}

const STATUS_RANK: Record<string, number> = {
  pending: 0,
  confirmed: 1,
  preparing: 2,
  ready: 3,
};

const TIER_ACCENT: Record<TimeTier, string> = {
  fresh: 'border-l-cockpit-green',
  warning: 'border-l-cockpit-yellow',
  critical: 'border-l-cockpit-red',
};

const TIER_TIME_TEXT: Record<TimeTier, string> = {
  fresh: 'text-cockpit-in-text',
  warning: 'text-cockpit-attention-text',
  critical: 'text-cockpit-out-text',
};

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function nextStatus(status: string): { next: string; labelKey: string } | null {
  switch (status) {
    case 'pending':
    case 'confirmed':
      return { next: 'preparing', labelKey: 'liveStrip.start' };
    case 'preparing':
      return { next: 'ready', labelKey: 'liveStrip.markReady' };
    case 'ready':
      return { next: 'completed', labelKey: 'liveStrip.complete' };
    default:
      return null;
  }
}

// Where the order came from, in a way the cashier reads instantly.
// Returns { icon, label, accent } — accent is a Tailwind text class.
function describeChannel(order: Order, t: (k: string, opts?: any) => string) {
  // Third-party delivery first — easiest to recognize by brand.
  if (order.source === 'uber_eats') {
    return { Icon: Bike, label: t('liveStrip.uberEats'), accent: 'text-green-400' };
  }
  if (order.source === 'rappi') {
    return { Icon: Bike, label: t('liveStrip.rappi'), accent: 'text-pink-400' };
  }
  if (order.source === 'didi_food') {
    return { Icon: Bike, label: t('liveStrip.didiFood'), accent: 'text-orange-400' };
  }
  if (order.delivery_platform) {
    return { Icon: Bike, label: order.delivery_platform, accent: 'text-cockpit-attention-text' };
  }
  if (order.source === 'customer_kiosk') {
    return { Icon: Smartphone, label: t('liveStrip.kiosk'), accent: 'text-brand-300' };
  }
  if (order.source === 'qr_order') {
    return { Icon: QrCode, label: t('liveStrip.qr'), accent: 'text-cockpit-blue' };
  }
  // POS register: dine-in vs to-go is the real signal.
  if (order.table_number) {
    return { Icon: Utensils, label: t('liveStrip.tableShort', { n: order.table_number }), accent: 'text-cockpit-blue' };
  }
  if (order.order_fulfillment_type === 'for_here') {
    return { Icon: Utensils, label: t('liveStrip.forHereShort'), accent: 'text-cockpit-blue' };
  }
  return { Icon: ShoppingBag, label: t('liveStrip.toGoShort'), accent: 'text-neutral-300' };
}

export default function LiveOrdersStrip({ onViewAll, onCharge, refreshKey }: LiveOrdersStripProps) {
  const { t } = useTranslation('pos');
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionId, setActionId] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchOrders = useCallback(async () => {
    try {
      const data = await getKitchenOrders({ includeReady: true });
      data.sort((a, b) => {
        // Critical (oldest) first, then by pipeline stage, then by age.
        const aSec = Math.floor((Date.now() - new Date(a.created_at).getTime()) / 1000);
        const bSec = Math.floor((Date.now() - new Date(b.created_at).getTime()) / 1000);
        const aTier = getTimeTier(aSec);
        const bTier = getTimeTier(bSec);
        const tierWeight = (x: TimeTier) => (x === 'critical' ? 0 : x === 'warning' ? 1 : 2);
        const tierDiff = tierWeight(aTier) - tierWeight(bTier);
        if (tierDiff !== 0) return tierDiff;
        const rank = (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9);
        if (rank !== 0) return rank;
        return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      });
      setOrders(data);
    } catch {
      // non-blocking — keep last good snapshot, retry on next poll
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    fetchOrders();
    pollRef.current = setInterval(fetchOrders, 8_000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [fetchOrders, refreshKey]);

  // Tick once per second so elapsed times animate in real time without re-polling.
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(tick);
  }, []);

  const counts = useMemo(() => {
    let preparing = 0;
    let ready = 0;
    let unpaid = 0;
    for (const o of orders) {
      if (o.status === 'pending' || o.status === 'confirmed' || o.status === 'preparing') preparing += 1;
      if (o.status === 'ready') ready += 1;
      if (!isPaid(o)) unpaid += 1;
    }
    return { preparing, ready, unpaid };
  }, [orders]);

  const handleAdvance = async (order: Order) => {
    const step = nextStatus(order.status);
    if (!step) return;
    setActionId(order.id);
    try {
      await updateOrderStatus(order.id, step.next);
      // Optimistic: drop completed orders immediately so the cashier sees flow.
      if (step.next === 'completed') {
        setOrders((prev) => prev.filter((o) => o.id !== order.id));
      } else {
        setOrders((prev) => prev.map((o) => (o.id === order.id ? { ...o, status: step.next as Order['status'] } : o)));
      }
      // Authoritative refresh in the background.
      void fetchOrders();
    } catch {
      // Will be surfaced by the next poll.
    } finally {
      setActionId(null);
    }
  };

  // Calm empty state — minimal height so the menu grid stays the focus.
  if (!loading && orders.length === 0) {
    return (
      <div className="border-b border-neutral-800/60 bg-neutral-950 px-5 py-3 lg:px-6 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-neutral-500 text-sm">
          <Clock className="w-4 h-4" />
          <span className="font-semibold">{t('liveStrip.empty')}</span>
          <span className="hidden sm:inline text-neutral-600">· {t('liveStrip.emptyHint')}</span>
        </div>
        <button
          onClick={onViewAll}
          className="text-xs font-bold text-neutral-400 hover:text-white transition-colors flex items-center gap-1"
        >
          {t('liveStrip.viewAll')}
          <ChevronRight className="w-3 h-3" />
        </button>
      </div>
    );
  }

  return (
    <div className="border-b border-neutral-800/60 bg-neutral-950">
      {/* Counter row */}
      <div className="flex items-center justify-between gap-2 px-5 lg:px-6 pt-3 pb-2">
        <div className="flex items-center gap-3 flex-wrap text-xs font-bold uppercase tracking-wider">
          <span className="inline-flex items-center gap-1.5 text-cockpit-attention-text">
            <span className="w-2 h-2 rounded-full bg-cockpit-yellow" />
            <span>{counts.preparing}</span>
            <span className="text-neutral-400 font-semibold normal-case tracking-normal">{t('liveStrip.preparing')}</span>
          </span>
          <span className="inline-flex items-center gap-1.5 text-cockpit-in-text">
            <span className="w-2 h-2 rounded-full bg-cockpit-green" />
            <span>{counts.ready}</span>
            <span className="text-neutral-400 font-semibold normal-case tracking-normal">{t('liveStrip.readyCount')}</span>
          </span>
          {counts.unpaid > 0 && (
            <span className="inline-flex items-center gap-1.5 text-brand-300">
              <CreditCard className="w-3 h-3" />
              <span>{counts.unpaid}</span>
              <span className="text-neutral-400 font-semibold normal-case tracking-normal">{t('liveStrip.unpaid')}</span>
            </span>
          )}
        </div>
        <button
          onClick={onViewAll}
          className="text-xs font-bold text-neutral-300 hover:text-white transition-colors flex items-center gap-1 px-2 py-1 rounded-md hover:bg-neutral-800"
        >
          {t('liveStrip.viewAll')}
          <ChevronRight className="w-3 h-3" />
        </button>
      </div>

      {/* Card strip */}
      <div className="px-5 lg:px-6 pb-3">
        <div className="flex gap-2.5 overflow-x-auto scrollbar-hide -mx-1 px-1">
          {orders.map((order) => {
            const elapsed = Math.max(0, Math.floor((now - new Date(order.created_at).getTime()) / 1000));
            const tier = getTimeTier(elapsed);
            const paid = isPaid(order);
            const step = nextStatus(order.status);
            const busy = actionId === order.id;
            const channel = describeChannel(order, t);
            const isReady = order.status === 'ready';
            const itemCount = (order.items || []).reduce((sum, it) => sum + (it.quantity || 0), 0);

            return (
              <div
                key={order.id}
                className={`flex-shrink-0 w-56 bg-neutral-900 rounded-lg border border-neutral-800 border-l-4 ${TIER_ACCENT[tier]} ${
                  tier === 'critical' ? 'ring-1 ring-cockpit-red/40' : ''
                } flex flex-col`}
              >
                {/* Top: order # + elapsed/ready */}
                <div className="flex items-center justify-between px-2.5 pt-2">
                  <span className="text-base font-black text-white leading-none">#{order.order_number}</span>
                  {isReady ? (
                    <span className="inline-flex items-center gap-1 bg-cockpit-green text-neutral-900 px-1.5 py-0.5 rounded-full text-[10px] font-black uppercase">
                      <Check size={10} strokeWidth={3} />
                      <span>{t('liveStrip.readyBadge')}</span>
                    </span>
                  ) : (
                    <span className={`inline-flex items-center gap-1 text-xs font-bold ${TIER_TIME_TEXT[tier]} ${tier === 'critical' ? 'animate-pulse' : ''}`}>
                      <Clock className="w-3 h-3" />
                      {formatElapsed(elapsed)}
                    </span>
                  )}
                </div>

                {/* Channel + customer */}
                <div className="px-2.5 pt-1.5 space-y-0.5">
                  <div className={`flex items-center gap-1.5 text-xs font-bold ${channel.accent}`}>
                    <channel.Icon className="w-3.5 h-3.5 flex-shrink-0" />
                    <span className="truncate">{channel.label}</span>
                  </div>
                  <div className="flex items-center gap-1.5 text-xs text-neutral-300 min-h-[16px]">
                    {order.customer_name ? (
                      <>
                        <User className="w-3 h-3 text-neutral-500 flex-shrink-0" />
                        <span className="truncate font-semibold">{order.customer_name}</span>
                      </>
                    ) : (
                      <span className="text-neutral-600 italic text-[11px]">{t('liveStrip.noName')}</span>
                    )}
                  </div>
                  <div className="text-[11px] text-neutral-500 font-semibold">
                    {t('liveStrip.itemCount', { count: itemCount })}
                  </div>
                </div>

                {/* Status / payment badges */}
                <div className="px-2.5 pt-1.5 flex items-center gap-1 flex-wrap">
                  {!paid && (
                    <span className="bg-cockpit-yellow text-neutral-900 px-1.5 py-0.5 rounded-full text-[10px] font-black uppercase">
                      {t('ordersPanel.unpaid')}
                    </span>
                  )}
                </div>

                {/* Actions */}
                <div className="px-2.5 py-2 mt-auto flex items-center gap-1.5">
                  {!paid && (
                    <button
                      onClick={() => onCharge(order)}
                      className="flex-1 px-2 py-2 bg-brand-600 hover:bg-brand-700 text-white text-xs font-black rounded-md transition-colors min-h-[36px] uppercase tracking-wide"
                    >
                      {t('liveStrip.charge')}
                    </button>
                  )}
                  {step && (
                    <button
                      onClick={() => handleAdvance(order)}
                      disabled={busy}
                      className={`flex-1 px-2 py-2 ${
                        isReady
                          ? 'bg-cockpit-green text-neutral-900 hover:brightness-110'
                          : 'bg-neutral-700 text-white hover:bg-neutral-600'
                      } disabled:opacity-50 text-xs font-black rounded-md transition-colors min-h-[36px] uppercase tracking-wide`}
                    >
                      {busy ? '…' : t(step.labelKey)}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
