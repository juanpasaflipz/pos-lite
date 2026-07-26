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
  ChevronDown,
  ScanLine,
  Printer,
} from 'lucide-react';
import {
  getKitchenOrders,
  getOrders,
  getOrder,
  getPaymentStatus,
  lookupOrders,
  updateOrderStatus,
} from '../api';
import { Order } from '../types';
import { formatPrice, TAX_LABEL } from '../utils/currency';
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
  // Debounced copy of historySearch — the typed value is used for the input
  // (responsive feel) while the debounced value drives the server lookup, so
  // we don't fire a request on every keystroke.
  const [debouncedHistorySearch, setDebouncedHistorySearch] = useState('');

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Pull every in-flight + ready order in one shot (with items + modifiers).
  // Splits client-side into Active / Ready buckets.
  const fetchKitchen = useCallback(async () => {
    try {
      const data = await getKitchenOrders({ includeReady: true });
      const active: Order[] = [];
      const ready: Order[] = [];
      for (const o of data) {
        if (o.status === 'ready') ready.push(o);
        else if (IN_FLIGHT.has(o.status)) active.push(o);
      }
      // Oldest-first inside each lane — the manager's eye should land on the
      // order that's been waiting the longest, not the newest one.
      const byAge = (a: Order, b: Order) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      active.sort(byAge);
      ready.sort(byAge);
      setActiveOrders(active);
      setReadyOrders(ready);
    } catch {
      // non-blocking — keep last good data, retry on next poll
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Unpaid lane uses /api/orders?payment_status=unpaid (not the kitchen feed),
  // because kiosk Para Aquí orders can reach status='completed' while still
  // unpaid — those are invisible to /kitchen/active. Mirrors POSScreen's
  // "Pedidos por cobrar" filter so the cashier strip and admin lane match.
  const fetchUnpaid = useCallback(async () => {
    try {
      const data = await getOrders({ payment_status: 'unpaid' });
      const relevant = data.filter(
        (o) =>
          o.status !== 'cancelled' &&
          (o.status === 'ready' ||
            o.status === 'completed' ||
            o.source === 'qr_order' ||
            o.source === 'customer_kiosk' ||
            IN_FLIGHT.has(o.status)),
      );
      relevant.sort(
        (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
      );
      setUnpaidOrders(relevant);
    } catch {
      // non-blocking
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
      // With a search query, hit the tenant-wide lookup endpoint so the
      // cashier can find orders that have fallen off the 100-row paid history
      // — e.g. an unpaid two-day-old kiosk order, or one in 'cancelled'.
      // Date filter is intentionally ignored while searching; the user is
      // hunting a specific order, not browsing a day.
      if (debouncedHistorySearch.trim()) {
        const data = await lookupOrders(debouncedHistorySearch.trim());
        setHistoryOrders(data);
        return;
      }
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
  }, [historyDate, debouncedHistorySearch]);

  // Live lanes share one polling source (kitchen feed). Cancelled has its own.
  // History is on-demand. Polling cadence matches the KDS (8s) so the manager's
  // board and the cook's board never drift apart during a rush. Unpaid lane
  // runs in parallel with kitchen feed so its badge count stays accurate even
  // when the manager is on Active / Ready.
  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    setLoading(true);

    // Per-lane refetch: history is on-demand (no poll); cancelled polls slowly;
    // the live lanes poll the kitchen + unpaid feeds together.
    let run: (() => void) | null = null;
    let delay = 0;
    if (lane === 'cancelled') {
      run = fetchCancelled;
      delay = 30_000;
      run();
    } else if (lane === 'history') {
      fetchHistory();
    } else {
      run = () => {
        fetchKitchen();
        fetchUnpaid();
      };
      delay = 8_000;
      run();
    }

    const start = () => { if (run && !pollRef.current) pollRef.current = setInterval(run, delay); };
    const stop = () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
    // Only poll while the tab is visible; catch up with one refetch on return.
    const onVisibility = () => {
      if (document.hidden) stop();
      else if (run) { run(); start(); }
    };
    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      stop();
    };
  }, [lane, fetchKitchen, fetchUnpaid, fetchCancelled, fetchHistory]);

  // Live tick for elapsed-time labels on live lanes.
  useEffect(() => {
    if (lane === 'history' || lane === 'cancelled') return;
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(tick);
  }, [lane]);

  // Debounce typing in the Historial search box so we hit the lookup endpoint
  // ~300ms after the cashier stops typing.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedHistorySearch(historySearch), 300);
    return () => clearTimeout(t);
  }, [historySearch]);

  const handleRefresh = () => {
    setRefreshing(true);
    if (lane === 'cancelled') fetchCancelled();
    else if (lane === 'history') fetchHistory();
    else {
      fetchKitchen();
      fetchUnpaid();
    }
  };

  const handleAdvance = async (order: Order) => {
    const step = nextStatus(order.status);
    if (!step) return;
    setActionId(order.id);
    try {
      await updateOrderStatus(order.id, step.next);
      await Promise.all([fetchKitchen(), fetchUnpaid()]);
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
      await Promise.all([fetchKitchen(), fetchUnpaid()]);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Failed to cancel order');
    } finally {
      setActionId(null);
    }
  };

  // Charging happens inside POSScreen because that's where the full payment
  // flow lives (MP terminal, cash drawer, etc.). We pass the order id
  // via router state — POSScreen reads it on mount.
  const handleCharge = (order: Order) => {
    navigate('/pos', { state: { chargeOrderId: order.id } });
  };

  // Manual rescue for terminal-paid-but-DB-unpaid orders. /api/payments/:id
  // live-pulls MP / Clip when the row is pending_terminal with a payment id
  // attached, and updates the DB if the processor says paid. Use this when
  // the cashier swears the terminal showed OK but our UI still says SIN PAGAR.
  const handleRecheckTerminal = async (order: Order) => {
    setActionId(order.id);
    try {
      await getPaymentStatus(order.id);
      await fetchUnpaid();
    } catch {
      // non-blocking; cashier can retap
    } finally {
      setActionId(null);
    }
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

  // When a search is active, historyOrders is already the server-filtered
  // lookup result (which spans all statuses + all dates). When idle, we still
  // do a light client-side filter so typing into the box feels instant before
  // the 300ms debounce fires.
  const filteredHistory = useMemo(() => {
    const typed = historySearch.trim().toLowerCase();
    const debounced = debouncedHistorySearch.trim().toLowerCase();
    if (debounced) return historyOrders;
    if (!typed) return historyOrders;
    return historyOrders.filter((o) => {
      const orderNum = String(o.order_number ?? '').toLowerCase();
      const name = (o.customer_name || '').toLowerCase();
      return orderNum.includes(typed) || name.includes(typed);
    });
  }, [historyOrders, historySearch, debouncedHistorySearch]);

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
                onRecheckTerminal={handleRecheckTerminal}
                onOpenReceipt={handleOpenReceipt}
                openingReceiptId={openingReceiptId}
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
        onChanged={() => { fetchKitchen(); fetchUnpaid(); }}
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
  onRecheckTerminal: (o: Order) => void;
  onOpenReceipt: (id: number) => void;
  openingReceiptId: number | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: any;
}

const LiveGrid: React.FC<LiveGridProps> = ({ orders, now, actionId, lane, onEdit, onCharge, onAdvance, onCancel, onRecheckTerminal, onOpenReceipt, openingReceiptId, t }) => {
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
        const printing = openingReceiptId === order.id;

        return (
          <div
            key={order.id}
            className={`bg-neutral-900 rounded-lg border border-neutral-800 border-l-4 ${TIER_ACCENT[tier]} ${
              tier === 'critical' ? 'ring-1 ring-cockpit-red/40' : ''
            }`}
          >
            <div className="flex items-start justify-between gap-2 px-3 pt-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2 min-w-0">
                  <span className="text-xl font-black text-white truncate">
                    {order.customer_name?.trim() || `#${order.order_number}`}
                  </span>
                  {order.customer_name?.trim() && (
                    <span className="text-sm font-bold text-neutral-500 shrink-0">#{order.order_number}</span>
                  )}
                </div>
                <div className="flex items-center gap-2 flex-wrap mt-1.5">
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
              </div>
              <div className="flex items-start gap-1.5 shrink-0">
                <div className={`flex items-center gap-1 text-sm font-bold ${TIER_TIME_TEXT[tier]} ${tier === 'critical' ? 'animate-pulse' : ''}`}>
                  <Clock className="w-4 h-4" />
                  {formatElapsed(elapsed)}
                </div>
                <button
                  onClick={() => onOpenReceipt(order.id)}
                  disabled={printing}
                  className="p-1 bg-neutral-800 hover:bg-brand-600 disabled:opacity-50 text-neutral-300 hover:text-white rounded-md transition-colors min-h-[28px] min-w-[28px] inline-flex items-center justify-center"
                  title={t('pos:ordersPanel.openReceipt', 'Ver recibo / imprimir')}
                  aria-label={t('pos:ordersPanel.openReceipt', 'Ver recibo / imprimir')}
                >
                  <Printer size={13} />
                </button>
              </div>
            </div>

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
                {!paid && lane === 'unpaid' && (
                  <button
                    onClick={() => onRecheckTerminal(order)}
                    disabled={busy}
                    className="px-2 py-2 bg-neutral-800 hover:bg-neutral-700 disabled:opacity-50 text-neutral-200 text-xs font-bold rounded-lg transition-colors min-h-[40px] inline-flex items-center gap-1"
                    title={t('pos:ordersPanel.recheckTerminalHint', 'Re-check terminal payment status')}
                    aria-label={t('pos:ordersPanel.recheckTerminal', 'Re-check terminal')}
                  >
                    <ScanLine size={12} />
                    {t('pos:ordersPanel.recheckTerminal', 'Verificar terminal')}
                  </button>
                )}
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
  const { t } = useTranslation(['pos', 'common']);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [detailsCache, setDetailsCache] = useState<Record<number, Order>>({});
  const [loadingDetailsId, setLoadingDetailsId] = useState<number | null>(null);

  const toggleExpand = useCallback(async (o: Order) => {
    if (expandedId === o.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(o.id);
    if (detailsCache[o.id]) return;
    setLoadingDetailsId(o.id);
    try {
      const full = await getOrder(o.id);
      setDetailsCache((prev) => ({ ...prev, [o.id]: full }));
    } catch {
      // leave cache untouched — header summary still renders; user can retap
    } finally {
      setLoadingDetailsId(null);
    }
  }, [expandedId, detailsCache]);

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
        const paid = isPaid(o);
        const showStatusPill = !paid || o.status === 'cancelled' || o.status !== 'completed';
        const expanded = expandedId === o.id;
        const detail = detailsCache[o.id];
        const loading = loadingDetailsId === o.id;
        const opening = openingId === o.id;
        const tip = Number(o.tip) || 0;
        return (
          <div
            key={o.id}
            className="bg-neutral-900 rounded-lg border border-neutral-800 hover:border-neutral-600 transition-colors"
          >
            <div
              role="button"
              tabIndex={0}
              onClick={() => toggleExpand(o)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleExpand(o); }
              }}
              aria-expanded={expanded}
              className="w-full text-left p-3 min-h-[40px] hover:bg-neutral-800/60 rounded-lg transition-colors cursor-pointer"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-baseline gap-2 min-w-0">
                  <span className="text-base font-black text-white truncate">
                    {o.customer_name?.trim() || `#${o.order_number}`}
                  </span>
                  {o.customer_name?.trim() && (
                    <span className="text-xs font-bold text-neutral-500 shrink-0">#{o.order_number}</span>
                  )}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <span className="text-sm font-bold text-brand-500 whitespace-nowrap">
                    {formatPrice(Number(o.total))}
                  </span>
                  <button
                    onClick={(e) => { e.stopPropagation(); onOpen(o.id); }}
                    disabled={opening}
                    className="p-1 bg-neutral-800 hover:bg-brand-600 disabled:opacity-50 text-neutral-300 hover:text-white rounded-md transition-colors min-h-[28px] min-w-[28px] inline-flex items-center justify-center"
                    title={t('ordersPanel.openReceipt', 'Ver recibo / imprimir')}
                    aria-label={t('ordersPanel.openReceipt', 'Ver recibo / imprimir')}
                  >
                    <Printer size={13} />
                  </button>
                  {expanded ? (
                    <ChevronDown size={14} className="text-neutral-500" />
                  ) : (
                    <ChevronRight size={14} className="text-neutral-500" />
                  )}
                </div>
              </div>
              <div className="flex items-center justify-between gap-2 mt-1">
                <span className="text-xs text-neutral-500">
                  {formatTime(new Date(o.created_at))}
                </span>
                <div className="flex items-center gap-1.5 flex-wrap justify-end">
                  {showStatusPill && (
                    <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wide ${STATUS_BADGE[o.status] || 'bg-neutral-700 text-neutral-200'}`}>
                      {t(`common:orderStatus.${o.status}`, o.status)}
                    </span>
                  )}
                  {!paid && (
                    <span className="bg-cockpit-yellow text-neutral-900 px-1.5 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wide">
                      {t('ordersPanel.unpaid')}
                    </span>
                  )}
                  <span className="inline-flex items-center gap-1 text-[10px] uppercase text-neutral-400 font-bold tracking-wide">
                    <Receipt size={12} />
                    {o.payment_method || (paid ? t('ordersPanel.paid') : '—')}
                  </span>
                </div>
              </div>
            </div>

            {expanded && (
              <div className="border-t border-neutral-800 px-3 py-3 text-sm">
                {loading && !detail ? (
                  <div className="py-6 flex items-center justify-center text-neutral-500">
                    <Clock className="w-4 h-4 animate-spin mr-2" />
                    <span className="text-xs">{t('common:loading', 'Cargando...')}</span>
                  </div>
                ) : (
                  <>
                    <ul className="space-y-1.5 mb-3">
                      {(detail?.items || []).map((item, idx) => (
                        <li key={item.id ?? `${item.menu_item_id}-${idx}`} className="flex justify-between gap-3 text-neutral-200">
                          <div className="min-w-0 flex-1">
                            <p className="font-semibold leading-tight">
                              <span className="tabular-nums text-white">{item.quantity}×</span>{' '}
                              {item.item_name}
                            </p>
                            {item.modifiers && item.modifiers.length > 0 && (
                              <ul className="mt-0.5 ml-4 space-y-0.5">
                                {item.modifiers.map((m) => (
                                  <li key={m.id} className="text-xs text-neutral-400">
                                    + {m.modifier_name}
                                    {Number(m.price_adjustment) > 0 && (
                                      <span className="text-neutral-500"> ({formatPrice(Number(m.price_adjustment))})</span>
                                    )}
                                  </li>
                                ))}
                              </ul>
                            )}
                            {item.notes && (
                              <p className="text-xs text-neutral-500 italic mt-0.5">{item.notes}</p>
                            )}
                          </div>
                          <span className="text-neutral-300 whitespace-nowrap tabular-nums">
                            {formatPrice(Number(item.unit_price) * Number(item.quantity))}
                          </span>
                        </li>
                      ))}
                      {detail && (detail.items?.length ?? 0) === 0 && (
                        <li className="text-xs text-neutral-500 italic">
                          {t('ordersPanel.noItems', 'Sin partidas')}
                        </li>
                      )}
                    </ul>

                    <div className="space-y-1 border-t border-neutral-800 pt-2 text-xs">
                      <div className="flex justify-between text-neutral-400">
                        <span>{t('receipt.subtotalBeforeTax')}</span>
                        <span className="tabular-nums">{formatPrice(Number(o.subtotal))}</span>
                      </div>
                      <div className="flex justify-between text-neutral-400">
                        <span>{t('receipt.taxIncluded', { label: TAX_LABEL })}</span>
                        <span className="tabular-nums">{formatPrice(Number(o.tax))}</span>
                      </div>
                      {tip > 0 && (
                        <div className="flex justify-between text-neutral-200">
                          <span>{t('receipt.tip')}</span>
                          <span className="tabular-nums font-semibold">{formatPrice(tip)}</span>
                        </div>
                      )}
                      <div className="flex justify-between text-white text-sm font-bold pt-1">
                        <span>{tip > 0
                          ? t('ordersPanel.totalWithTipLabel')
                          : t('totals.total')}</span>
                        <span className="tabular-nums">{formatPrice(Number(o.total) + tip)}</span>
                      </div>
                    </div>

                    <div className="pt-3 flex justify-end">
                      <button
                        onClick={(e) => { e.stopPropagation(); onOpen(o.id); }}
                        disabled={opening}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 disabled:opacity-60 text-neutral-200 text-xs font-bold rounded-md min-h-[32px]"
                      >
                        <Receipt size={12} />
                        {t('ordersPanel.openReceipt', 'Ver recibo / imprimir')}
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
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
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2 min-w-0">
                  <span className="text-base font-black text-white truncate">
                    {o.customer_name?.trim() || `#${o.order_number}`}
                  </span>
                  {o.customer_name?.trim() && (
                    <span className="text-xs font-bold text-neutral-500 shrink-0">#{o.order_number}</span>
                  )}
                </div>
                <span className="inline-block bg-cockpit-red text-white px-2 py-0.5 rounded-full text-[10px] font-bold uppercase mt-1">
                  {t('common:orderStatus.cancelled', { defaultValue: 'Cancelled' })}
                </span>
              </div>
              <span className="text-sm font-bold text-neutral-400 whitespace-nowrap shrink-0">
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
