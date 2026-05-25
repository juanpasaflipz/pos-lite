import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { getKitchenOrders, updateOrderStatus, getCategoryRoles } from '../api';
import { useAuth } from '../context/AuthContext';
import { Order, OrderItem, CategoryRole } from '../types';
import { getTimeTier, isPaid, type TimeTier } from '../lib/orderUrgency';
import { formatTime, formatDate } from '../utils/dateFormat';
import LanguageSwitcher from '../components/LanguageSwitcher';
import BrandLogo from '../components/BrandLogo';
import StatusPill from '../components/ui/StatusPill';
import {
  Clock,
  ArrowLeft,
  Volume2,
  Maximize,
  Wine,
  ChefHat,
  WifiOff,
  Check,
} from 'lucide-react';

interface OrderWithElapsed extends Order {
  elapsedSeconds: number;
}

// Show the stale banner if no successful fetch in this long. Polling
// interval is 5s, so 15s gives us two missed polls before warning.
const STALE_THRESHOLD_MS = 15_000;

const TIER_CARD_CLASS: Record<TimeTier, string> = {
  fresh: 'border-cockpit-green/50',
  warning: 'border-cockpit-yellow',
  critical: 'border-cockpit-red bg-cockpit-red/15',
};

const TIER_TIME_TEXT_CLASS: Record<TimeTier, string> = {
  fresh: 'text-cockpit-in-text',
  warning: 'text-cockpit-attention-text',
  critical: 'text-cockpit-out-text',
};

export default function KitchenDisplay() {
  const navigate = useNavigate();
  const { t } = useTranslation('kitchen');
  const { currentEmployee } = useAuth();
  const [orders, setOrders] = useState<OrderWithElapsed[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(new Date());
  const [lastSuccessAt, setLastSuccessAt] = useState<number | null>(null);
  const [displayFilter, setDisplayFilter] = useState<'all' | 'kitchen' | 'bar'>(
    currentEmployee?.role === 'bar' ? 'bar' : 'all'
  );
  const [categoryRoles, setCategoryRoles] = useState<CategoryRole[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const timeIntervalRef = useRef<NodeJS.Timeout | null>(null);
  // Track which pending order ids we've already chimed for, so each new
  // order beeps exactly once — instead of using a count comparison that
  // misses concurrent transitions and false-fires on initial load.
  const chimedOrderIdsRef = useRef<Set<number>>(new Set());
  const isFirstFetchRef = useRef<boolean>(true);

  // Load category roles for filtering
  useEffect(() => {
    getCategoryRoles().then(setCategoryRoles).catch(() => {});
  }, []);

  const calculateElapsedSeconds = useCallback((createdAt: string): number => {
    const created = new Date(createdAt);
    const now = new Date();
    return Math.floor((now.getTime() - created.getTime()) / 1000);
  }, []);

  const playAudioAlert = useCallback(() => {
    try {
      if (!audioContextRef.current) {
        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      }

      const audioContext = audioContextRef.current;
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();

      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);

      oscillator.frequency.value = 800;
      oscillator.type = 'sine';

      gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.5);

      oscillator.start(audioContext.currentTime);
      oscillator.stop(audioContext.currentTime + 0.5);
    } catch (err) {
      console.error('Failed to play audio alert:', err);
    }
  }, []);

  const fetchOrders = useCallback(async () => {
    try {
      const data = await getKitchenOrders();

      const activeOrders = data
        .filter((order) => order.status !== 'completed' && order.status !== 'cancelled')
        .map((order) => ({
          ...order,
          elapsedSeconds: calculateElapsedSeconds(order.created_at),
        }));

      const sortedOrders = activeOrders.sort((a, b) => {
        const statusOrder = { pending: 0, preparing: 1 };
        const aStatusRank = statusOrder[a.status as keyof typeof statusOrder] ?? 2;
        const bStatusRank = statusOrder[b.status as keyof typeof statusOrder] ?? 2;

        if (aStatusRank !== bStatusRank) {
          return aStatusRank - bStatusRank;
        }

        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      });

      setOrders(sortedOrders);

      // Chime per genuinely new pending order id. Seed the set on the first
      // fetch so existing tickets at mount don't beep.
      const pendingIds = sortedOrders.filter((o) => o.status === 'pending').map((o) => o.id);
      if (isFirstFetchRef.current) {
        chimedOrderIdsRef.current = new Set(pendingIds);
        isFirstFetchRef.current = false;
      } else {
        let newCount = 0;
        for (const id of pendingIds) {
          if (!chimedOrderIdsRef.current.has(id)) {
            chimedOrderIdsRef.current.add(id);
            newCount++;
          }
        }
        if (newCount > 0) playAudioAlert();
      }

      setLastSuccessAt(Date.now());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.fetchFailed'));
      console.error('Error fetching kitchen orders:', err);
    } finally {
      setLoading(false);
    }
  }, [calculateElapsedSeconds, playAudioAlert, t]);

  useEffect(() => {
    fetchOrders();
    pollIntervalRef.current = setInterval(fetchOrders, 5000);

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, [fetchOrders]);

  useEffect(() => {
    timeIntervalRef.current = setInterval(() => {
      setCurrentTime(new Date());
    }, 1000);

    return () => {
      if (timeIntervalRef.current) {
        clearInterval(timeIntervalRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const updateElapsed = setInterval(() => {
      setOrders((prevOrders) =>
        prevOrders.map((order) => ({
          ...order,
          elapsedSeconds: calculateElapsedSeconds(order.created_at),
        }))
      );
    }, 1000);

    return () => clearInterval(updateElapsed);
  }, [calculateElapsedSeconds]);

  // Single-tap "Ready" — auto-transitions pending → preparing → ready
  // so the KDS doesn't need a separate Start button. (Backend rejects
  // pending → ready directly, so we walk it through preparing first.)
  const handleReadyOrder = async (orderId: number, currentStatus: string) => {
    try {
      if (currentStatus === 'pending') {
        await updateOrderStatus(orderId, 'preparing');
      }
      await updateOrderStatus(orderId, 'ready');
      fetchOrders();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.readyFailed'));
    }
  };

  const handleFullscreen = async () => {
    try {
      const element = document.documentElement;
      if (element.requestFullscreen) {
        await element.requestFullscreen();
      } else if ((element as any).webkitRequestFullscreen) {
        await (element as any).webkitRequestFullscreen();
      }
    } catch (err) {
      console.error('Fullscreen request failed:', err);
    }
  };

  const formatElapsedTime = (seconds: number): string => {
    if (seconds < 60) {
      return t('time.secondsAgo', { count: seconds });
    }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
      return minutes > 1
        ? t('time.minutesAgo', { count: minutes })
        : t('time.minuteAgo', { count: minutes });
    }
    const hours = Math.floor(minutes / 60);
    return t('time.hoursMinutesAgo', { hours, minutes: minutes % 60 });
  };

  const pendingCount = orders.filter((o) => o.status === 'pending').length;
  // Re-evaluated each tick of currentTime (1s interval) so the banner
  // appears within ~1s of crossing the staleness threshold.
  const staleSinceMs = lastSuccessAt ? currentTime.getTime() - lastSuccessAt : 0;
  const isStale = lastSuccessAt !== null && staleSinceMs > STALE_THRESHOLD_MS;

  return (
    <div className="min-h-screen bg-neutral-950 text-white">
      {/* Header */}
      <div className="bg-neutral-900 border-b border-neutral-800 px-6 py-4 flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-6">
          {/* Hide back-to-POS on TVs (no signed-in employee). Wall displays
              shouldn't expose POS navigation to anyone walking by. */}
          {currentEmployee && (
            <button
              onClick={() => navigate('/pos')}
              className="flex items-center gap-2 hover:bg-neutral-800 px-4 py-2 rounded-lg transition-colors text-lg font-semibold"
              title={t('header.back')}
            >
              <ArrowLeft size={32} />
              <span className="hidden sm:inline">{t('header.back')}</span>
            </button>
          )}
          <h1 className="text-3xl font-black tracking-tighter">{t('header.title')}</h1>
          <div className="flex gap-1 ml-4">
            <button
              onClick={() => setDisplayFilter('all')}
              className={`px-3 py-1.5 rounded-lg text-sm font-bold transition-colors ${displayFilter === 'all' ? 'bg-brand-600 text-white' : 'bg-neutral-800 text-neutral-400 hover:bg-neutral-700'}`}
            >
              {t('header.all')}
            </button>
            <button
              onClick={() => setDisplayFilter('kitchen')}
              className={`px-3 py-1.5 rounded-lg text-sm font-bold transition-colors flex items-center gap-1 ${displayFilter === 'kitchen' ? 'bg-brand-600 text-white' : 'bg-neutral-800 text-neutral-400 hover:bg-neutral-700'}`}
            >
              <ChefHat size={14} /> {t('header.kitchen')}
            </button>
            <button
              onClick={() => setDisplayFilter('bar')}
              className={`px-3 py-1.5 rounded-lg text-sm font-bold transition-colors flex items-center gap-1 ${displayFilter === 'bar' ? 'bg-brand-600 text-white' : 'bg-neutral-800 text-neutral-400 hover:bg-neutral-700'}`}
            >
              <Wine size={14} /> {t('header.bar')}
            </button>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <LanguageSwitcher variant="nav" />
          <div className="text-center">
            <div className="text-3xl font-bold">{formatTime(currentTime)}</div>
            <div className="text-xs text-neutral-500">
              {formatDate(currentTime, {
                weekday: 'short',
                month: 'short',
                day: 'numeric',
              })}
            </div>
          </div>

          {pendingCount > 0 && (
            <div className="bg-brand-600 text-white rounded-full w-16 h-16 flex items-center justify-center font-bold text-2xl">
              {pendingCount}
            </div>
          )}

          <button
            onClick={handleFullscreen}
            className="bg-neutral-800 hover:bg-neutral-700 p-3 rounded-lg transition-colors border border-neutral-700"
            title={t('header.fullscreen')}
          >
            <Maximize size={28} />
          </button>
          <BrandLogo className="h-10" />
        </div>
      </div>

      {/* Error Banner */}
      {error && (
        <div className="bg-brand-900/50 border-b border-brand-800 px-6 py-3 text-brand-200 flex items-center gap-3">
          <Volume2 size={20} />
          <span>{error}</span>
        </div>
      )}

      {/* Stale banner — we haven't successfully polled in a while. Stays up
          until the next successful fetch, regardless of whether the latest
          attempt errored or just hung. */}
      {isStale && (
        <div className="bg-cockpit-yellow/20 border-b border-cockpit-yellow/60 px-6 py-3 text-cockpit-attention-text flex items-center gap-3 font-semibold">
          <WifiOff size={20} />
          <span>
            {t('errors.stale', { seconds: Math.round(staleSinceMs / 1000) })}
          </span>
        </div>
      )}

      {/* Orders Grid */}
      <div className="p-6">
        {loading && orders.length === 0 ? (
          <div className="flex items-center justify-center min-h-[400px]">
            <div className="text-center">
              <div className="animate-spin mb-4">
                <Clock size={64} className="text-brand-500" />
              </div>
              <p className="text-xl text-neutral-400">{t('orders.loadingOrders')}</p>
            </div>
          </div>
        ) : orders.length === 0 ? (
          <div className="flex items-center justify-center min-h-[400px]">
            <div className="text-center">
              <p className="text-3xl font-bold text-cockpit-in-text mb-2">{t('orders.allClear')}</p>
              <p className="text-xl text-neutral-500">{t('orders.noPending')}</p>
            </div>
          </div>
        ) : (
          // Auto-fill: density scales with screen width. ~340px min card
          // → ~3 cols on 1080p, ~5 on 4K, collapses on tablets/phones.
          <div
            className="grid gap-3 auto-rows-max"
            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))' }}
          >
            {orders.map((order) => (
              <OrderCard
                key={order.id}
                order={order}
                onReady={handleReadyOrder}
                formatTime={formatElapsedTime}
                isTvMode={!currentEmployee}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

interface OrderCardProps {
  order: OrderWithElapsed;
  onReady: (orderId: number, currentStatus: string) => void;
  formatTime: (seconds: number) => string;
  isTvMode?: boolean;
}

function OrderCard({
  order,
  onReady,
  formatTime,
  isTvMode = false,
}: OrderCardProps) {
  const { t } = useTranslation('kitchen');
  const [isLoading, setIsLoading] = useState(false);
  const tier = getTimeTier(order.elapsedSeconds);
  const paid = isPaid(order);

  const handleReady = async () => {
    setIsLoading(true);
    try {
      await onReady(order.id, order.status);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div
      className={`relative ${TIER_CARD_CLASS[tier]} bg-neutral-900 rounded-lg p-6 shadow-lg flex flex-col h-full transition-all duration-300 border-2`}
    >
      {/* Blinking red ring for the critical tier (8+ min) */}
      {tier === 'critical' && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-lg ring-4 ring-inset ring-cockpit-red/80 animate-pulse"
        />
      )}

      {/* Order Header */}
      <div className="flex items-start justify-between mb-4 border-b border-neutral-800 pb-4">
        <div>
          <h2 className="text-5xl font-black tracking-tighter text-white mb-1">#{order.order_number}</h2>
          <p className="text-sm text-neutral-500">{t('orders.orderId', { id: String(order.id).slice(0, 8) })}</p>
        </div>
        <div className="flex items-center gap-2">
          {order.source === 'qr_order' && (
            <span className="bg-cockpit-blue text-white px-2.5 py-1.5 rounded-full font-bold text-xs whitespace-nowrap">
              QR
            </span>
          )}
          {order.source === 'customer_kiosk' && (
            <span className="bg-cockpit-blue text-white px-2.5 py-1.5 rounded-full font-bold text-xs whitespace-nowrap">
              KIOSK
            </span>
          )}
          {order.source === 'customer_kiosk' && order.order_fulfillment_type && (
            <span className="bg-cockpit-yellow text-neutral-950 px-2.5 py-1.5 rounded-full font-black text-xs whitespace-nowrap">
              {order.order_fulfillment_type === 'for_here' ? t('orders.forHere') : t('orders.toGo')}
            </span>
          )}
          {order.table_number && (
            <span className="bg-cockpit-blue text-white px-2.5 py-1.5 rounded-full font-bold text-xs whitespace-nowrap">
              Table {order.table_number}
            </span>
          )}
          {paid ? (
            <span className="bg-cockpit-green text-neutral-900 px-2.5 py-1.5 rounded-full font-bold text-xs whitespace-nowrap flex items-center gap-1">
              <Check size={14} strokeWidth={3} /> {t('status.paid')}
            </span>
          ) : (
            <span className="bg-cockpit-yellow text-neutral-900 px-2.5 py-1.5 rounded-full font-bold text-xs whitespace-nowrap">
              {t('status.unpaid')}
            </span>
          )}
          <StatusPill status={order.status} size="lg" />
        </div>
      </div>

      {/* Time Elapsed */}
      <div className={`flex items-center gap-2 mb-4 text-lg font-semibold ${TIER_TIME_TEXT_CLASS[tier]}`}>
        <Clock size={24} />
        <span>{formatTime(order.elapsedSeconds)}</span>
        {tier === 'critical' && (
          <span className="ml-1 bg-cockpit-red text-white px-2 py-0.5 rounded text-sm font-black uppercase tracking-wide animate-pulse">
            {t('status.urgent')}
          </span>
        )}
      </div>

      {/* Items List */}
      <div className="flex-1 mb-6 space-y-3">
        {order.items && order.items.length > 0 ? (
          (() => {
            // Group combo items together
            const comboGroups: Record<string, OrderItem[]> = {};
            const regularItems: OrderItem[] = [];
            for (const item of order.items) {
              if (item.combo_instance_id) {
                if (!comboGroups[item.combo_instance_id]) comboGroups[item.combo_instance_id] = [];
                comboGroups[item.combo_instance_id].push(item);
              } else {
                regularItems.push(item);
              }
            }
            return (
              <>
                {regularItems.map((item, index) => (
                  <ItemDisplay key={`reg-${index}`} item={item} />
                ))}
                {Object.entries(comboGroups).map(([comboId, items]) => (
                  <div key={comboId} className="border border-cockpit-yellow/40 rounded-lg p-2 bg-cockpit-yellow/5">
                    <p className="text-xs font-bold text-cockpit-attention-text uppercase mb-2">{t('orders.combo')}</p>
                    {items.map((item, index) => (
                      <ItemDisplay key={`combo-${index}`} item={item} />
                    ))}
                  </div>
                ))}
              </>
            );
          })()
        ) : (
          <p className="text-neutral-500 italic">{t('orders.noItems')}</p>
        )}
      </div>

      {/* Single Ready action — being on the KDS implies the order is in
          the works; cooks shouldn't have to tap Start first. handleReady
          walks pending → preparing → ready under the hood. */}
      <button
        onClick={handleReady}
        disabled={isLoading}
        className="mt-auto bg-cockpit-green hover:bg-cockpit-green/90 disabled:bg-cockpit-green/50 disabled:opacity-50 text-white font-bold py-4 px-4 rounded-lg transition-colors text-xl min-h-[56px] flex items-center justify-center"
      >
        {isLoading ? (
          <span className="animate-pulse">{t('actions.markingReady')}</span>
        ) : (
          <span>{t('actions.readyForPickup')}</span>
        )}
      </button>
    </div>
  );
}

interface ItemDisplayProps {
  item: OrderItem;
}

function ItemDisplay({ item }: ItemDisplayProps) {
  const hasNotes = item.notes && item.notes.trim().length > 0;
  const hasModifiers = item.modifiers && item.modifiers.length > 0;

  return (
    <div className="bg-neutral-800/50 rounded-lg p-3 border border-neutral-700">
      <div className="flex items-start justify-between gap-3 mb-1">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          {item.brand_color && (
            <span
              className="w-3 h-3 rounded-full flex-shrink-0"
              style={{ backgroundColor: item.brand_color }}
              title={item.brand_name || ''}
            />
          )}
          <span className="text-lg font-semibold text-white">{item.item_name}</span>
        </div>
        <span className="bg-neutral-700 text-neutral-200 px-3 py-1 rounded-full font-bold text-base min-w-fit">
          x{item.quantity}
        </span>
      </div>
      {item.brand_name && (
        <p className="text-xs font-bold uppercase tracking-wider mb-1" style={{ color: item.brand_color || '#888' }}>
          {item.brand_name}
        </p>
      )}

      {hasModifiers && (
        <div className="mt-1 space-y-0.5">
          {item.modifiers!.map((mod, i) => (
            <p key={i} className="text-brand-400 font-semibold text-sm bg-brand-900/20 px-2 py-0.5 rounded">
              + {mod.modifier_name}
            </p>
          ))}
        </div>
      )}

      {hasNotes && (
        <p className="text-brand-300 italic text-base bg-brand-900/20 px-2 py-1 rounded mt-2 border-l-2 border-brand-500">
          {item.notes}
        </p>
      )}
    </div>
  );
}
