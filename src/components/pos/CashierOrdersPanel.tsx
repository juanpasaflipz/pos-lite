import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { X, RefreshCw, Clock, Check } from 'lucide-react';
import { getKitchenOrders, updateOrderStatus } from '../../api';
import { Order } from '../../types';
import { formatPrice } from '../../utils/currency';
import { getTimeTier, isPaid, type TimeTier } from '../../lib/orderUrgency';

interface CashierOrdersPanelProps {
  isOpen: boolean;
  onClose: () => void;
  /** Opens the existing payment (Cobrar) flow for an unpaid order. */
  onCharge: (order: Order) => void;
}

// Pipeline ordering: oldest, earliest-stage orders surface first.
const STATUS_RANK: Record<string, number> = {
  pending: 0,
  confirmed: 1,
  preparing: 2,
  ready: 3,
};

const STATUS_BADGE: Record<string, string> = {
  pending: 'bg-cockpit-blue text-white',
  confirmed: 'bg-cockpit-blue text-white',
  preparing: 'bg-cockpit-yellow text-neutral-900',
  ready: 'bg-cockpit-green text-neutral-900',
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

// What the cashier's "advance" button does for each status.
function nextStatus(status: string): { next: string; labelKey: string } | null {
  switch (status) {
    case 'pending':
    case 'confirmed':
      return { next: 'preparing', labelKey: 'ordersPanel.start' };
    case 'preparing':
      return { next: 'ready', labelKey: 'ordersPanel.markReady' };
    case 'ready':
      return { next: 'completed', labelKey: 'ordersPanel.complete' };
    default:
      return null;
  }
}

export default function CashierOrdersPanel({ isOpen, onClose, onCharge }: CashierOrdersPanelProps) {
  const { t } = useTranslation('pos');
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [actionId, setActionId] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchOrders = useCallback(async () => {
    try {
      const data = await getKitchenOrders({ includeReady: true });
      data.sort((a, b) => {
        const rank = (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9);
        return rank !== 0
          ? rank
          : new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      });
      setOrders(data);
    } catch {
      // non-blocking — keep last good data, retry on next poll
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Poll only while the panel is open.
  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    fetchOrders();
    pollRef.current = setInterval(fetchOrders, 8_000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [isOpen, fetchOrders]);

  // Live elapsed-time tick while open.
  useEffect(() => {
    if (!isOpen) return;
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(tick);
  }, [isOpen]);

  const handleRefresh = () => {
    setRefreshing(true);
    fetchOrders();
  };

  const handleAdvance = async (order: Order) => {
    const step = nextStatus(order.status);
    if (!step) return;
    setActionId(order.id);
    try {
      await updateOrderStatus(order.id, step.next);
      await fetchOrders();
    } catch {
      // surfaced by next poll; avoid blocking the cashier
    } finally {
      setActionId(null);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
        aria-hidden
      />

      {/* Panel */}
      <div className="relative w-full max-w-md bg-neutral-950 border-l border-neutral-800 h-full flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-800 bg-neutral-900">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-black text-white tracking-tight">{t('ordersPanel.title')}</h2>
            {orders.length > 0 && (
              <span className="bg-brand-600 text-white text-xs font-bold px-2 py-0.5 rounded-full">
                {orders.length}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              className="p-2 text-neutral-400 hover:text-white transition-colors"
              title={t('ordersPanel.title')}
            >
              <RefreshCw className={`w-5 h-5 ${refreshing ? 'animate-spin' : ''}`} />
            </button>
            <button
              onClick={onClose}
              className="p-2 text-neutral-400 hover:text-white transition-colors"
            >
              <X className="w-6 h-6" />
            </button>
          </div>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto p-3 space-y-3">
          {loading && orders.length === 0 ? (
            <div className="flex items-center justify-center py-20">
              <Clock className="w-7 h-7 text-brand-500 animate-spin" />
            </div>
          ) : orders.length === 0 ? (
            <div className="text-center py-20">
              <p className="text-neutral-500">{t('ordersPanel.empty')}</p>
            </div>
          ) : (
            orders.map((order) => {
              const elapsed = Math.max(0, Math.floor((now - new Date(order.created_at).getTime()) / 1000));
              const tier = getTimeTier(elapsed);
              const paid = isPaid(order);
              const step = nextStatus(order.status);
              const busy = actionId === order.id;

              return (
                <div
                  key={order.id}
                  className={`bg-neutral-900 rounded-lg border border-neutral-800 border-l-4 ${TIER_ACCENT[tier]} ${
                    tier === 'critical' ? 'ring-1 ring-cockpit-red/40' : ''
                  }`}
                >
                  {/* Header row */}
                  <div className="flex items-center justify-between gap-2 px-3 pt-3 flex-wrap">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xl font-black text-white">#{order.order_number}</span>
                      <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${STATUS_BADGE[order.status] || 'bg-neutral-600 text-white'}`}>
                        {t(`common:orderStatus.${order.status}`, order.status)}
                      </span>
                      {paid ? (
                        <span className="bg-cockpit-green text-neutral-900 px-2 py-0.5 rounded-full text-xs font-bold flex items-center gap-1">
                          <Check size={12} strokeWidth={3} /> {t('ordersPanel.paid')}
                        </span>
                      ) : (
                        <span className="bg-cockpit-yellow text-neutral-900 px-2 py-0.5 rounded-full text-xs font-bold">
                          {t('ordersPanel.unpaid')}
                        </span>
                      )}
                      {order.table_number && (
                        <span className="bg-cockpit-blue text-white px-2 py-0.5 rounded-full text-xs font-bold">
                          Table {order.table_number}
                        </span>
                      )}
                    </div>
                    <div className={`flex items-center gap-1 text-sm font-bold ${TIER_TIME_TEXT[tier]} ${tier === 'critical' ? 'animate-pulse' : ''}`}>
                      <Clock className="w-4 h-4" />
                      {formatElapsed(elapsed)}
                    </div>
                  </div>

                  {/* Items */}
                  {order.items && order.items.length > 0 && (
                    <div className="px-3 pt-2 space-y-1.5">
                      {order.items.map((item, i) => (
                        <div key={i} className="bg-neutral-800/50 rounded-md px-2.5 py-1.5 border border-neutral-700/60">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-sm font-semibold text-white">{item.item_name}</span>
                            <span className="bg-neutral-700 text-neutral-200 px-2 py-0.5 rounded-full font-bold text-xs">
                              x{item.quantity}
                            </span>
                          </div>
                          {item.modifiers && item.modifiers.length > 0 && (
                            <div className="mt-0.5">
                              {item.modifiers.map((mod, j) => (
                                <p key={j} className="text-xs text-brand-400">+ {mod.modifier_name}</p>
                              ))}
                            </div>
                          )}
                          {item.notes && (
                            <p className="text-xs text-brand-300 italic mt-0.5 border-l-2 border-brand-500 pl-2">{item.notes}</p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Footer: total + actions */}
                  <div className="flex items-center justify-between gap-2 px-3 py-3">
                    <span className="text-sm font-bold text-brand-500">{formatPrice(Number(order.total))}</span>
                    <div className="flex items-center gap-2">
                      {!paid && (
                        <button
                          onClick={() => onCharge(order)}
                          className="px-3 py-2 bg-brand-600 hover:bg-brand-700 text-white text-sm font-bold rounded-lg transition-colors min-h-[40px]"
                        >
                          {t('ordersPanel.charge')}
                        </button>
                      )}
                      {step && (
                        <button
                          onClick={() => handleAdvance(order)}
                          disabled={busy}
                          className="px-3 py-2 bg-neutral-700 hover:bg-neutral-600 disabled:opacity-50 text-white text-sm font-bold rounded-lg transition-colors min-h-[40px]"
                        >
                          {busy ? '…' : t(step.labelKey)}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
