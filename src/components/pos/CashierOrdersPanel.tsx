import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { X, RefreshCw, Clock, Check, Pencil, Search, Receipt } from 'lucide-react';
import { getKitchenOrders, getOrders, getOrder, updateOrderStatus } from '../../api';
import { Order } from '../../types';
import { formatPrice } from '../../utils/currency';
import { formatTime } from '../../utils/dateFormat';
import { getTimeTier, isPaid, type TimeTier } from '../../lib/orderUrgency';
import OrderEditModal from './OrderEditModal';
import ReceiptModal from './ReceiptModal';

interface CashierOrdersPanelProps {
  isOpen: boolean;
  onClose: () => void;
  /** Opens the existing payment (Cobrar) flow for an unpaid order. */
  onCharge: (order: Order) => void;
  /** Opens the refund modal for a paid order. */
  onRefund?: (orderId: number) => void;
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

// What the cashier's "advance" button does for each status. Post-collapse
// 'active' is the canonical in-flight name; legacy values accepted too.
function nextStatus(status: string): { next: string; labelKey: string } | null {
  switch (status) {
    case 'pending':
    case 'confirmed':
    case 'active':
      return { next: 'ready', labelKey: 'ordersPanel.markReady' };
    case 'preparing':
      return { next: 'ready', labelKey: 'ordersPanel.markReady' };
    case 'ready':
      return { next: 'completed', labelKey: 'ordersPanel.complete' };
    default:
      return null;
  }
}

export default function CashierOrdersPanel({ isOpen, onClose, onCharge, onRefund }: CashierOrdersPanelProps) {
  const { t } = useTranslation('pos');
  const [mode, setMode] = useState<'active' | 'history'>('active');
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [actionId, setActionId] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [editingOrder, setEditingOrder] = useState<Order | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // History tab state. Paid orders don't move, so we don't poll — just refresh.
  const [historyOrders, setHistoryOrders] = useState<Order[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyDate, setHistoryDate] = useState<string>('');
  const [historySearch, setHistorySearch] = useState('');
  const [receiptOrder, setReceiptOrder] = useState<Order | null>(null);
  const [openingReceiptId, setOpeningReceiptId] = useState<number | null>(null);

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

  // Poll active orders only while the panel is open and showing the Active tab.
  useEffect(() => {
    if (!isOpen || mode !== 'active') return;
    setLoading(true);
    fetchOrders();
    pollRef.current = setInterval(fetchOrders, 8_000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [isOpen, mode, fetchOrders]);

  // Live elapsed-time tick while open on the Active tab.
  useEffect(() => {
    if (!isOpen || mode !== 'active') return;
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(tick);
  }, [isOpen, mode]);

  const fetchHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const filters: { payment_status: string; date?: string } = { payment_status: 'paid' };
      if (historyDate) filters.date = historyDate;
      const data = await getOrders(filters);
      setHistoryOrders(data);
    } catch {
      // non-blocking — refresh button will retry
    } finally {
      setHistoryLoading(false);
    }
  }, [historyDate]);

  useEffect(() => {
    if (!isOpen || mode !== 'history') return;
    fetchHistory();
  }, [isOpen, mode, fetchHistory]);

  const filteredHistory = useMemo(() => {
    const q = historySearch.trim().toLowerCase();
    if (!q) return historyOrders;
    return historyOrders.filter((o) => {
      const orderNum = String(o.order_number ?? '').toLowerCase();
      const name = (o.customer_name || '').toLowerCase();
      return orderNum.includes(q) || name.includes(q);
    });
  }, [historyOrders, historySearch]);

  const handleRefresh = () => {
    if (mode === 'history') {
      fetchHistory();
      return;
    }
    setRefreshing(true);
    fetchOrders();
  };

  const handleOpenReceipt = async (id: number) => {
    setOpeningReceiptId(id);
    try {
      const full = await getOrder(id);
      setReceiptOrder(full);
    } catch {
      // silent — user can retap
    } finally {
      setOpeningReceiptId(null);
    }
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
            <h2 className="text-lg font-black text-white tracking-tight">
              {mode === 'active' ? t('ordersPanel.title') : t('ordersPanel.tabHistory')}
            </h2>
            {mode === 'active' && orders.length > 0 && (
              <span className="bg-brand-600 text-white text-xs font-bold px-2 py-0.5 rounded-full">
                {orders.length}
              </span>
            )}
            {mode === 'history' && filteredHistory.length > 0 && (
              <span className="bg-brand-600 text-white text-xs font-bold px-2 py-0.5 rounded-full">
                {filteredHistory.length}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={handleRefresh}
              disabled={refreshing || historyLoading}
              className="p-2 text-neutral-400 hover:text-white transition-colors"
              title={t('ordersPanel.title')}
            >
              <RefreshCw className={`w-5 h-5 ${refreshing || historyLoading ? 'animate-spin' : ''}`} />
            </button>
            <button
              onClick={onClose}
              className="p-2 text-neutral-400 hover:text-white transition-colors"
            >
              <X className="w-6 h-6" />
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-neutral-800 bg-neutral-900">
          <button
            onClick={() => setMode('active')}
            className={`flex-1 py-3 text-sm font-bold transition-colors min-h-[40px] ${
              mode === 'active'
                ? 'text-white border-b-2 border-brand-500'
                : 'text-neutral-400 hover:text-neutral-200 border-b-2 border-transparent'
            }`}
          >
            {t('ordersPanel.tabActive')}
          </button>
          <button
            onClick={() => setMode('history')}
            className={`flex-1 py-3 text-sm font-bold transition-colors min-h-[40px] ${
              mode === 'history'
                ? 'text-white border-b-2 border-brand-500'
                : 'text-neutral-400 hover:text-neutral-200 border-b-2 border-transparent'
            }`}
          >
            {t('ordersPanel.tabHistory')}
          </button>
        </div>

        {/* History filters */}
        {mode === 'history' && (
          <div className="px-3 pt-3 pb-2 border-b border-neutral-800 bg-neutral-900/50 space-y-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-500" />
              <input
                type="text"
                value={historySearch}
                onChange={(e) => setHistorySearch(e.target.value)}
                placeholder={t('ordersPanel.historySearchPlaceholder')}
                className="w-full pl-8 pr-2 py-2 bg-neutral-800 border border-neutral-700 text-white text-sm rounded-lg focus:outline-none focus:border-brand-500 min-h-[40px]"
              />
            </div>
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={historyDate}
                onChange={(e) => setHistoryDate(e.target.value)}
                className="flex-1 px-2 py-1.5 bg-neutral-800 border border-neutral-700 text-white text-sm rounded-lg focus:outline-none focus:border-brand-500 min-h-[40px]"
              />
              {historyDate && (
                <button
                  onClick={() => setHistoryDate('')}
                  className="px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-200 text-xs font-bold rounded-lg min-h-[40px]"
                >
                  {t('ordersPanel.clearDate')}
                </button>
              )}
            </div>
          </div>
        )}

        {/* List */}
        {mode === 'active' && (
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
                      {order.items.map((item, i) => {
                        const isVoided = !!item.voided_at;
                        const isAdded = !!item.added_at && !isVoided;
                        const isQtyChanged = item.original_quantity != null && item.original_quantity !== item.quantity && !isVoided;
                        return (
                          <div
                            key={i}
                            className={`rounded-md px-2.5 py-1.5 border ${
                              isVoided
                                ? 'bg-cockpit-red/10 border-cockpit-red/40'
                                : isAdded
                                  ? 'bg-cockpit-yellow/10 border-cockpit-yellow/40'
                                  : 'bg-neutral-800/50 border-neutral-700/60'
                            }`}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                                <span className={`text-sm font-semibold ${isVoided ? 'line-through text-neutral-400' : 'text-white'}`}>
                                  {item.item_name}
                                </span>
                                {isAdded && (
                                  <span className="text-[9px] font-black uppercase bg-cockpit-yellow text-neutral-900 px-1 py-0.5 rounded">NUEVO</span>
                                )}
                                {isVoided && (
                                  <span className="text-[9px] font-black uppercase bg-cockpit-red text-white px-1 py-0.5 rounded">VOID</span>
                                )}
                              </div>
                              <span className="bg-neutral-700 text-neutral-200 px-2 py-0.5 rounded-full font-bold text-xs">
                                x{item.quantity}
                                {isQtyChanged && (
                                  <span className="ml-1 text-cockpit-blue">(was {item.original_quantity})</span>
                                )}
                              </span>
                            </div>
                            {item.modifiers && item.modifiers.length > 0 && (
                              <div className="mt-0.5">
                                {item.modifiers.map((mod, j) => (
                                  <p key={j} className={`text-xs ${isVoided ? 'line-through text-brand-400/60' : 'text-brand-400'}`}>
                                    + {mod.modifier_name}
                                  </p>
                                ))}
                              </div>
                            )}
                            {item.notes && (
                              <p className={`text-xs italic mt-0.5 border-l-2 pl-2 ${isVoided ? 'border-cockpit-red text-brand-300/60' : 'border-brand-500 text-brand-300'}`}>
                                {item.notes}
                              </p>
                            )}
                            {isVoided && item.void_reason && (
                              <p className="text-[10px] text-cockpit-red font-semibold mt-0.5">↳ {item.void_reason}</p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Footer: total + actions */}
                  <div className="flex items-center justify-between gap-2 px-3 py-3">
                    <span className="text-sm font-bold text-brand-500">{formatPrice(Number(order.total))}</span>
                    <div className="flex items-center gap-2">
                      {/* Editar lets the cashier add/qty/void on a sent order.
                          On a paid order, the modal prompts manager approval. */}
                      <button
                        onClick={() => setEditingOrder(order)}
                        className="px-3 py-2 bg-neutral-800 hover:bg-neutral-700 text-neutral-200 text-sm font-bold rounded-lg transition-colors min-h-[40px] inline-flex items-center gap-1.5"
                        aria-label={t('ordersPanel.edit')}
                      >
                        <Pencil size={14} />
                        {t('ordersPanel.edit')}
                      </button>
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
        )}

        {/* History list */}
        {mode === 'history' && (
          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {historyLoading && historyOrders.length === 0 ? (
              <div className="flex items-center justify-center py-20">
                <Clock className="w-7 h-7 text-brand-500 animate-spin" />
              </div>
            ) : filteredHistory.length === 0 ? (
              <div className="text-center py-20">
                <p className="text-neutral-500">{t('ordersPanel.historyEmpty')}</p>
              </div>
            ) : (
              filteredHistory.map((o) => {
                const opening = openingReceiptId === o.id;
                return (
                  <button
                    key={o.id}
                    onClick={() => handleOpenReceipt(o.id)}
                    disabled={opening}
                    className="w-full text-left bg-neutral-900 rounded-lg border border-neutral-800 hover:border-neutral-600 hover:bg-neutral-800/60 transition-colors p-3 min-h-[40px] disabled:opacity-60"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0 flex-wrap">
                        <span className="text-base font-black text-white">#{o.order_number}</span>
                        {o.customer_name && (
                          <span className="text-xs text-neutral-400 truncate">{o.customer_name}</span>
                        )}
                      </div>
                      <span className="text-sm font-bold text-brand-500 whitespace-nowrap">
                        {formatPrice(Number(o.total))}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2 mt-1">
                      <span className="text-xs text-neutral-500">
                        {formatTime(new Date(o.created_at))}
                      </span>
                      <span className="inline-flex items-center gap-1 text-[10px] uppercase text-neutral-400 font-bold tracking-wide">
                        <Receipt size={12} />
                        {o.payment_method || t('ordersPanel.paid')}
                      </span>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        )}
      </div>

      <OrderEditModal
        isOpen={editingOrder !== null}
        order={editingOrder}
        onClose={() => setEditingOrder(null)}
        onChanged={fetchOrders}
        onRefund={onRefund}
      />

      {receiptOrder && (
        <ReceiptModal
          order={receiptOrder}
          onClose={() => setReceiptOrder(null)}
          onPrint={() => { window.print(); }}
        />
      )}
    </div>
  );
}
