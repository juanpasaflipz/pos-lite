import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  RefreshCw,
  Clock,
  Check,
  Pencil,
  Search,
  Receipt,
  X as XIcon,
  Bell,
  CreditCard,
  Ban,
  ChevronRight,
} from 'lucide-react';
import {
  getKitchenOrders,
  getOrders,
  getOrder,
  updateOrderStatus,
} from '../api';
import { Order } from '../types';
import { formatPrice } from '../utils/currency';
import { formatTime } from '../utils/dateFormat';
import { getTimeTier, isPaid, type TimeTier } from '../lib/orderUrgency';
import BrandLogo from '../components/BrandLogo';
import OrderEditModal from '../components/pos/OrderEditModal';
import ReceiptModal from '../components/pos/ReceiptModal';
import RefundModal from '../components/RefundModal';

type Lane = 'active' | 'ready' | 'unpaid' | 'cancelled' | 'history';

const VALID_LANES: Lane[] = ['active', 'ready', 'unpaid', 'cancelled', 'history'];

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

const STATUS_BADGE: Record<string, string> = {
  pending: 'bg-cockpit-blue text-white',
  confirmed: 'bg-cockpit-blue text-white',
  preparing: 'bg-cockpit-yellow text-neutral-900',
  active: 'bg-cockpit-blue text-white',
  ready: 'bg-cockpit-green text-neutral-900',
  completed: 'bg-neutral-700 text-neutral-200',
  cancelled: 'bg-cockpit-red text-white',
};

// Pre-collapse legacy statuses still surface in the data; all in-flight values
// land in the Active lane during rollout.
const IN_FLIGHT = new Set(['active', 'pending', 'confirmed', 'preparing']);

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function elapsedSeconds(order: Order, now: number): number {
  return Math.max(0, Math.floor((now - new Date(order.created_at).getTime()) / 1000));
}

// Cashier's next-step button for an in-flight order. Returns null when there's
// nothing forward to do (e.g. completed/cancelled).
function nextStatus(status: string): { next: string; labelKey: string } | null {
  if (IN_FLIGHT.has(status)) return { next: 'ready', labelKey: 'ordersPanel.markReady' };
  if (status === 'ready') return { next: 'completed', labelKey: 'ordersPanel.complete' };
  return null;
}

export default function OrdersScreen() {
  const { t } = useTranslation(['pos', 'common']);
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = (searchParams.get('lane') || '').toLowerCase();
  const initialLane: Lane = (VALID_LANES as string[]).includes(requested) ? (requested as Lane) : 'active';

  const [lane, setLaneState] = useState<Lane>(initialLane);
  const setLane = (next: Lane) => {
    setLaneState(next);
    const params = new URLSearchParams(searchParams);
    if (next === 'active') params.delete('lane');
    else params.set('lane', next);
    setSearchParams(params, { replace: true });
  };

  // Per-lane datasets. Kept separate so the count badges in the tab row stay
  // accurate without re-fetching everything when the manager switches lanes.
  const [activeOrders, setActiveOrders] = useState<Order[]>([]);
  const [readyOrders, setReadyOrders] = useState<Order[]>([]);
  const [unpaidOrders, setUnpaidOrders] = useState<Order[]>([]);
  const [cancelledOrders, setCancelledOrders] = useState<Order[]>([]);
  const [historyOrders, setHistoryOrders] = useState<Order[]>([]);

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [actionId, setActionId] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Modal state — viewing/editing/refunding a specific order.
  const [editingOrder, setEditingOrder] = useState<Order | null>(null);
  const [receiptOrder, setReceiptOrder] = useState<Order | null>(null);
  const [openingReceiptId, setOpeningReceiptId] = useState<number | null>(null);
  const [refundOrderId, setRefundOrderId] = useState<number | null>(null);

  // History filters
  const [historyDate, setHistoryDate] = useState<string>('');
  const [historySearch, setHistorySearch] = useState('');

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Pull every in-flight + ready order in one shot (with items + modifiers).
  // Splits client-side into Active / Ready buckets and surfaces unpaid ones in
  // the Needs Payment lane so a missed Cobrar isn't hiding inside another tab.
  const fetchKitchen = useCallback(async () => {
    try {
      const data = await getKitchenOrders({ includeReady: true });
      const active: Order[] = [];
      const ready: Order[] = [];
      const unpaidInFlight: Order[] = [];
      for (const o of data) {
        if (o.status === 'ready') ready.push(o);
        else if (IN_FLIGHT.has(o.status)) active.push(o);
        if (!isPaid(o) && o.status !== 'cancelled') unpaidInFlight.push(o);
      }
      // Oldest-first inside each lane — the manager's eye should land on the
      // order that's been waiting the longest, not the newest one.
      const byAge = (a: Order, b: Order) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      active.sort(byAge);
      ready.sort(byAge);
      unpaidInFlight.sort(byAge);
      setActiveOrders(active);
      setReadyOrders(ready);
      setUnpaidOrders(unpaidInFlight);
    } catch {
      // non-blocking — keep last good data, retry on next poll
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const fetchCancelled = useCallback(async () => {
    try {
      const today = new Date();
      const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      const data = await getOrders({ status: 'cancelled', date: ymd });
      setCancelledOrders(data);
    } catch {
      // non-blocking
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const fetchHistory = useCallback(async () => {
    try {
      const filters: { payment_status: string; date?: string } = { payment_status: 'paid' };
      if (historyDate) filters.date = historyDate;
      const data = await getOrders(filters);
      setHistoryOrders(data);
    } catch {
      // non-blocking
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [historyDate]);

  // Live lanes share one polling source (kitchen feed). Cancelled has its own.
  // History is on-demand. Polling cadence matches the KDS (8s) so the manager's
  // board and the cook's board never drift apart during a rush.
  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    setLoading(true);

    if (lane === 'cancelled') {
      fetchCancelled();
      pollRef.current = setInterval(fetchCancelled, 30_000);
    } else if (lane === 'history') {
      fetchHistory();
    } else {
      fetchKitchen();
      pollRef.current = setInterval(fetchKitchen, 8_000);
    }

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [lane, fetchKitchen, fetchCancelled, fetchHistory]);

  // Live tick for elapsed-time labels on live lanes.
  useEffect(() => {
    if (lane === 'history' || lane === 'cancelled') return;
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(tick);
  }, [lane]);

  const handleRefresh = () => {
    setRefreshing(true);
    if (lane === 'cancelled') fetchCancelled();
    else if (lane === 'history') fetchHistory();
    else fetchKitchen();
  };

  const handleAdvance = async (order: Order) => {
    const step = nextStatus(order.status);
    if (!step) return;
    setActionId(order.id);
    try {
      await updateOrderStatus(order.id, step.next);
      await fetchKitchen();
    } catch {
      // surfaced by next poll
    } finally {
      setActionId(null);
    }
  };

  const handleCancel = async (order: Order) => {
    if (!window.confirm(t('common:confirm.cancelOrder', 'Cancel this order? This cannot be undone.'))) return;
    setActionId(order.id);
    try {
      await updateOrderStatus(order.id, 'cancelled');
      await fetchKitchen();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Failed to cancel order');
    } finally {
      setActionId(null);
    }
  };

  // Charging happens inside POSScreen because that's where the full payment
  // flow lives (Conekta, MP terminal, cash drawer, etc.). We pass the order id
  // via router state — POSScreen reads it on mount.
  const handleCharge = (order: Order) => {
    navigate('/pos', { state: { chargeOrderId: order.id } });
  };

  const handleRefund = (orderId: number) => {
    setRefundOrderId(orderId);
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

  const filteredHistory = useMemo(() => {
    const q = historySearch.trim().toLowerCase();
    if (!q) return historyOrders;
    return historyOrders.filter((o) => {
      const orderNum = String(o.order_number ?? '').toLowerCase();
      const name = (o.customer_name || '').toLowerCase();
      return orderNum.includes(q) || name.includes(q);
    });
  }, [historyOrders, historySearch]);

  const counts = {
    active: activeOrders.length,
    ready: readyOrders.length,
    unpaid: unpaidOrders.length,
    cancelled: cancelledOrders.length,
    history: filteredHistory.length,
  };

  return (
    <div className="min-h-screen bg-neutral-950 flex flex-col">
      {/* Header */}
      <div className="bg-neutral-900 text-white px-4 py-3 border-b border-neutral-800">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <Link to="/admin/cockpit" className="p-2 hover:bg-neutral-800 rounded-lg transition-colors shrink-0">
              <ArrowLeft size={22} />
            </Link>
            <div className="min-w-0">
              <h1 className="text-2xl font-black tracking-tighter">{t('pos:ordersScreen.title', 'Orders')}</h1>
              <p className="text-neutral-400 text-xs">{t('pos:ordersScreen.subtitle', 'Track every order from kitchen to receipt.')}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              className="p-2 text-neutral-400 hover:text-white transition-colors"
              title={t('pos:ordersPanel.title')}
            >
              <RefreshCw className={`w-5 h-5 ${refreshing ? 'animate-spin' : ''}`} />
            </button>
            <BrandLogo className="h-8 hidden sm:block" />
          </div>
        </div>
      </div>

      {/* Lane tabs */}
      <div className="bg-neutral-900 border-b border-neutral-800 overflow-x-auto">
        <div className="flex min-w-max">
          <LaneTab tone="blue" active={lane === 'active'} onClick={() => setLane('active')}
            icon={<Clock size={16} />} label={t('pos:ordersScreen.laneActive', 'In Kitchen')} count={counts.active} />
          <LaneTab tone="green" active={lane === 'ready'} onClick={() => setLane('ready')}
            icon={<Bell size={16} />} label={t('pos:ordersScreen.laneReady', 'Ready')} count={counts.ready} />
          <LaneTab tone="yellow" active={lane === 'unpaid'} onClick={() => setLane('unpaid')}
            icon={<CreditCard size={16} />} label={t('pos:ordersScreen.laneUnpaid', 'Needs Payment')} count={counts.unpaid} />
          <LaneTab tone="red" active={lane === 'cancelled'} onClick={() => setLane('cancelled')}
            icon={<Ban size={16} />} label={t('pos:ordersScreen.laneCancelled', 'Cancelled')} count={counts.cancelled} />
          <LaneTab tone="neutral" active={lane === 'history'} onClick={() => setLane('history')}
            icon={<Receipt size={16} />} label={t('pos:ordersScreen.laneHistory', 'History')} count={counts.history} />
        </div>
      </div>

      {/* History filter bar */}
      {lane === 'history' && (
        <div className="px-4 py-3 border-b border-neutral-800 bg-neutral-900/60 flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-500" />
            <input
              type="text"
              value={historySearch}
              onChange={(e) => setHistorySearch(e.target.value)}
              placeholder={t('pos:ordersPanel.historySearchPlaceholder')}
              className="w-full pl-8 pr-2 py-2 bg-neutral-800 border border-neutral-700 text-white text-sm rounded-lg focus:outline-none focus:border-brand-500 min-h-[40px]"
            />
          </div>
          <input
            type="date"
            value={historyDate}
            onChange={(e) => setHistoryDate(e.target.value)}
            className="px-2 py-1.5 bg-neutral-800 border border-neutral-700 text-white text-sm rounded-lg focus:outline-none focus:border-brand-500 min-h-[40px]"
          />
          {historyDate && (
            <button
              onClick={() => setHistoryDate('')}
              className="px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-200 text-xs font-bold rounded-lg min-h-[40px]"
            >
              {t('pos:ordersPanel.clearDate')}
            </button>
          )}
        </div>
      )}

      {/* List body */}
      <div className="flex-1 overflow-y-auto p-4">
        {loading && currentLaneOrders(lane, { activeOrders, readyOrders, unpaidOrders, cancelledOrders, historyOrders: filteredHistory }).length === 0 ? (
          <div className="flex items-center justify-center py-20">
            <Clock className="w-7 h-7 text-brand-500 animate-spin" />
          </div>
        ) : (
          <div className="max-w-7xl mx-auto">
            {lane === 'history' ? (
              <HistoryGrid
                orders={filteredHistory}
                openingId={openingReceiptId}
                onOpen={handleOpenReceipt}
              />
            ) : lane === 'cancelled' ? (
              <CancelledGrid orders={cancelledOrders} onOpen={handleOpenReceipt} openingId={openingReceiptId} />
            ) : (
              <LiveGrid
                orders={currentLaneOrders(lane, { activeOrders, readyOrders, unpaidOrders, cancelledOrders, historyOrders: filteredHistory })}
                now={now}
                actionId={actionId}
                lane={lane}
                onEdit={setEditingOrder}
                onCharge={handleCharge}
                onAdvance={handleAdvance}
                onCancel={handleCancel}
                t={t}
              />
            )}
          </div>
        )}
      </div>

      {/* Edit / Receipt / Refund modals — managers act on a row without
          leaving the screen. Charge is the only action that hops to POS. */}
      <OrderEditModal
        isOpen={editingOrder !== null}
        order={editingOrder}
        onClose={() => setEditingOrder(null)}
        onChanged={fetchKitchen}
        onRefund={handleRefund}
      />

      {receiptOrder && (
        <ReceiptModal
          order={receiptOrder}
          onClose={() => setReceiptOrder(null)}
          onPrint={() => { window.print(); }}
        />
      )}

      {refundOrderId !== null && (
        <RefundModal
          orderId={refundOrderId}
          onClose={() => setRefundOrderId(null)}
          onRefunded={() => {
            setRefundOrderId(null);
            fetchKitchen();
            if (lane === 'history') fetchHistory();
          }}
        />
      )}
    </div>
  );
}

/* ==================== Sub-components ==================== */

type LaneTone = 'blue' | 'green' | 'yellow' | 'red' | 'neutral';

const TAB_TONE: Record<LaneTone, { active: string; badge: string }> = {
  blue:    { active: 'border-cockpit-blue text-cockpit-system-text',  badge: 'bg-cockpit-blue text-white' },
  green:   { active: 'border-cockpit-green text-cockpit-in-text',     badge: 'bg-cockpit-green text-neutral-900' },
  yellow:  { active: 'border-cockpit-yellow text-cockpit-attention-text', badge: 'bg-cockpit-yellow text-neutral-900' },
  red:     { active: 'border-cockpit-red text-cockpit-out-text',      badge: 'bg-cockpit-red text-white' },
  neutral: { active: 'border-neutral-300 text-white',                 badge: 'bg-neutral-700 text-neutral-200' },
};

const LaneTab: React.FC<{
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  count: number;
  tone: LaneTone;
}> = ({ active, onClick, icon, label, count, tone }) => {
  const styles = TAB_TONE[tone];
  return (
    <button
      onClick={onClick}
      className={`px-4 py-3 text-sm font-bold transition-colors min-h-[44px] border-b-2 inline-flex items-center gap-2 whitespace-nowrap ${
        active
          ? styles.active
          : 'border-transparent text-neutral-400 hover:text-neutral-200'
      }`}
    >
      {icon}
      {label}
      {count > 0 && (
        <span className={`px-2 py-0.5 rounded-full text-xs font-black ${styles.badge}`}>{count}</span>
      )}
    </button>
  );
};

function currentLaneOrders(
  lane: Lane,
  data: { activeOrders: Order[]; readyOrders: Order[]; unpaidOrders: Order[]; cancelledOrders: Order[]; historyOrders: Order[] },
): Order[] {
  switch (lane) {
    case 'active': return data.activeOrders;
    case 'ready': return data.readyOrders;
    case 'unpaid': return data.unpaidOrders;
    case 'cancelled': return data.cancelledOrders;
    case 'history': return data.historyOrders;
  }
}

interface LiveGridProps {
  orders: Order[];
  now: number;
  actionId: number | null;
  lane: Lane;
  onEdit: (o: Order) => void;
  onCharge: (o: Order) => void;
  onAdvance: (o: Order) => void;
  onCancel: (o: Order) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: any;
}

const LiveGrid: React.FC<LiveGridProps> = ({ orders, now, actionId, lane, onEdit, onCharge, onAdvance, onCancel, t }) => {
  if (orders.length === 0) {
    return (
      <div className="text-center py-20 text-neutral-500">
        {t('pos:ordersPanel.empty')}
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
      {orders.map((order) => {
        const elapsed = elapsedSeconds(order, now);
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
            <div className="flex items-center justify-between gap-2 px-3 pt-3 flex-wrap">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xl font-black text-white">#{order.order_number}</span>
                <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${STATUS_BADGE[order.status] || 'bg-neutral-600 text-white'}`}>
                  {t(`common:orderStatus.${order.status}`, order.status)}
                </span>
                {paid ? (
                  <span className="bg-cockpit-green text-neutral-900 px-2 py-0.5 rounded-full text-xs font-bold inline-flex items-center gap-1">
                    <Check size={12} strokeWidth={3} /> {t('pos:ordersPanel.paid')}
                  </span>
                ) : (
                  <span className="bg-cockpit-yellow text-neutral-900 px-2 py-0.5 rounded-full text-xs font-bold">
                    {t('pos:ordersPanel.unpaid')}
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

            {order.customer_name && (
              <div className="px-3 pt-1 text-xs text-neutral-400 truncate">{order.customer_name}</div>
            )}

            {order.items && order.items.length > 0 && (
              <div className="px-3 pt-2 space-y-1">
                {order.items.slice(0, 4).map((item, i) => (
                  <div key={i} className="flex items-center justify-between text-sm">
                    <span className={`truncate ${item.voided_at ? 'line-through text-neutral-500' : 'text-neutral-200'}`}>
                      {item.item_name}
                    </span>
                    <span className="text-neutral-500 ml-2 shrink-0">×{item.quantity}</span>
                  </div>
                ))}
                {order.items.length > 4 && (
                  <div className="text-xs text-neutral-500">+{order.items.length - 4} more</div>
                )}
              </div>
            )}

            <div className="flex items-center justify-between gap-2 px-3 py-3 mt-2 flex-wrap">
              <span className="text-sm font-bold text-brand-500">{formatPrice(Number(order.total))}</span>
              <div className="flex items-center gap-1.5 flex-wrap">
                <button
                  onClick={() => onEdit(order)}
                  className="px-2.5 py-2 bg-neutral-800 hover:bg-neutral-700 text-neutral-200 text-xs font-bold rounded-lg transition-colors min-h-[40px] inline-flex items-center gap-1"
                  aria-label={t('pos:ordersPanel.edit')}
                >
                  <Pencil size={12} />
                  {t('pos:ordersPanel.edit')}
                </button>
                {!paid && (
                  <button
                    onClick={() => onCharge(order)}
                    className="px-2.5 py-2 bg-brand-600 hover:bg-brand-700 text-white text-xs font-bold rounded-lg transition-colors min-h-[40px]"
                  >
                    {t('pos:ordersPanel.charge')}
                  </button>
                )}
                {step && lane !== 'unpaid' && (
                  <button
                    onClick={() => onAdvance(order)}
                    disabled={busy}
                    className="px-2.5 py-2 bg-neutral-700 hover:bg-neutral-600 disabled:opacity-50 text-white text-xs font-bold rounded-lg transition-colors min-h-[40px]"
                  >
                    {busy ? '…' : t(step.labelKey)}
                  </button>
                )}
                <button
                  onClick={() => onCancel(order)}
                  disabled={busy}
                  className="px-2 py-2 bg-neutral-800 hover:bg-cockpit-red/30 text-neutral-400 hover:text-cockpit-out-text text-xs font-bold rounded-lg transition-colors min-h-[40px]"
                  title={t('pos:ordersScreen.cancelOrder', 'Cancel order')}
                  aria-label={t('pos:ordersScreen.cancelOrder', 'Cancel order')}
                >
                  <XIcon size={14} />
                </button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};

const HistoryGrid: React.FC<{
  orders: Order[];
  openingId: number | null;
  onOpen: (id: number) => void;
}> = ({ orders, openingId, onOpen }) => {
  const { t } = useTranslation('pos');
  if (orders.length === 0) {
    return (
      <div className="text-center py-20 text-neutral-500">
        {t('ordersPanel.historyEmpty')}
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
      {orders.map((o) => {
        const opening = openingId === o.id;
        return (
          <button
            key={o.id}
            onClick={() => onOpen(o.id)}
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
      })}
    </div>
  );
};

const CancelledGrid: React.FC<{
  orders: Order[];
  openingId: number | null;
  onOpen: (id: number) => void;
}> = ({ orders, openingId, onOpen }) => {
  const { t } = useTranslation('pos');
  if (orders.length === 0) {
    return (
      <div className="text-center py-20 text-neutral-500">
        {t('ordersScreen.cancelledEmpty', 'No cancelled orders today.')}
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
      {orders.map((o) => {
        const opening = openingId === o.id;
        return (
          <button
            key={o.id}
            onClick={() => onOpen(o.id)}
            disabled={opening}
            className="w-full text-left bg-neutral-900 rounded-lg border border-cockpit-red/30 hover:border-cockpit-red/60 hover:bg-neutral-800/60 transition-colors p-3 min-h-[40px] disabled:opacity-60"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0 flex-wrap">
                <span className="text-base font-black text-white">#{o.order_number}</span>
                <span className="bg-cockpit-red text-white px-2 py-0.5 rounded-full text-[10px] font-bold uppercase">
                  {t('common:orderStatus.cancelled', { defaultValue: 'Cancelled' })}
                </span>
                {o.customer_name && (
                  <span className="text-xs text-neutral-400 truncate">{o.customer_name}</span>
                )}
              </div>
              <span className="text-sm font-bold text-neutral-400 whitespace-nowrap">
                {formatPrice(Number(o.total))}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2 mt-1">
              <span className="text-xs text-neutral-500">
                {formatTime(new Date(o.created_at))}
              </span>
              <ChevronRight size={14} className="text-neutral-600" />
            </div>
          </button>
        );
      })}
    </div>
  );
};
