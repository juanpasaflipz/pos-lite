import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { getKitchenOrders, updateOrderStatus, getCategoryRoles } from '../api';
import { useAuth } from '../context/AuthContext';
import { Order, OrderItem, CategoryRole } from '../types';
import { formatTime, formatDate } from '../utils/dateFormat';
import LanguageSwitcher from '../components/LanguageSwitcher';
import BrandLogo from '../components/BrandLogo';
import {
  Clock,
  ArrowLeft,
  Volume2,
  Maximize,
  Wine,
  ChefHat,
} from 'lucide-react';

interface OrderWithElapsed extends Order {
  elapsedSeconds: number;
}

export default function KitchenDisplay() {
  const navigate = useNavigate();
  const { t } = useTranslation('kitchen');
  const { currentEmployee } = useAuth();
  const [orders, setOrders] = useState<OrderWithElapsed[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(new Date());
  const [lastOrderCount, setLastOrderCount] = useState(0);
  const [displayFilter, setDisplayFilter] = useState<'all' | 'kitchen' | 'bar'>(
    currentEmployee?.role === 'bar' ? 'bar' : 'all'
  );
  const [categoryRoles, setCategoryRoles] = useState<CategoryRole[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const timeIntervalRef = useRef<NodeJS.Timeout | null>(null);

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

      const newOrderCount = sortedOrders.filter((o) => o.status === 'pending').length;
      if (newOrderCount > lastOrderCount) {
        playAudioAlert();
      }
      setLastOrderCount(newOrderCount);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.fetchFailed'));
      console.error('Error fetching kitchen orders:', err);
    } finally {
      setLoading(false);
    }
  }, [calculateElapsedSeconds, lastOrderCount, playAudioAlert]);

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

  const handleStartOrder = async (orderId: number) => {
    try {
      await updateOrderStatus(orderId, 'preparing');
      fetchOrders();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.startFailed'));
    }
  };

  const handleReadyOrder = async (orderId: number) => {
    try {
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

  const getStatusColor = (status: Order['status']): string => {
    switch (status) {
      case 'pending':
        return 'border-l-4 border-l-brand-500';
      case 'preparing':
        return 'border-l-4 border-l-amber-500';
      default:
        return 'border-l-4 border-l-neutral-600';
    }
  };

  const getStatusBgColor = (status: Order['status']): string => {
    return 'bg-neutral-900';
  };

  const getStatusBadgeColor = (status: Order['status']): string => {
    switch (status) {
      case 'pending':
        return 'bg-brand-600 text-white';
      case 'preparing':
        return 'bg-amber-500 text-neutral-900';
      default:
        return 'bg-neutral-600 text-neutral-200';
    }
  };

  const isUrgent = (elapsedSeconds: number): boolean => {
    return elapsedSeconds > 600;
  };

  const getUrgentColor = (elapsedSeconds: number, status: Order['status']): string => {
    if (isUrgent(elapsedSeconds) && status !== 'completed') {
      return 'border-l-4 border-l-brand-500';
    }
    return getStatusColor(status);
  };

  const pendingCount = orders.filter((o) => o.status === 'pending').length;

  return (
    <div className="min-h-screen bg-neutral-950 text-white">
      {/* Header */}
      <div className="bg-neutral-900 border-b border-neutral-800 px-6 py-4 flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-6">
          <button
            onClick={() => navigate('/pos')}
            className="flex items-center gap-2 hover:bg-neutral-800 px-4 py-2 rounded-lg transition-colors text-lg font-semibold"
            title={t('header.back')}
          >
            <ArrowLeft size={32} />
            <span className="hidden sm:inline">{t('header.back')}</span>
          </button>
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
              <p className="text-3xl font-bold text-green-400 mb-2">{t('orders.allClear')}</p>
              <p className="text-xl text-neutral-500">{t('orders.noPending')}</p>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 auto-rows-max">
            {orders.map((order) => (
              <OrderCard
                key={order.id}
                order={order}
                onStart={handleStartOrder}
                onReady={handleReadyOrder}
                formatTime={formatElapsedTime}
                getStatusColor={getUrgentColor}
                getStatusBgColor={getStatusBgColor}
                getStatusBadgeColor={getStatusBadgeColor}
                isUrgent={isUrgent}
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
  onStart: (orderId: number) => void;
  onReady: (orderId: number) => void;
  formatTime: (seconds: number) => string;
  getStatusColor: (elapsedSeconds: number, status: Order['status']) => string;
  getStatusBgColor: (status: Order['status']) => string;
  getStatusBadgeColor: (status: Order['status']) => string;
  isUrgent: (elapsedSeconds: number) => boolean;
}

function OrderCard({
  order,
  onStart,
  onReady,
  formatTime,
  getStatusColor,
  getStatusBgColor,
  getStatusBadgeColor,
  isUrgent,
}: OrderCardProps) {
  const { t } = useTranslation('kitchen');
  const [isLoading, setIsLoading] = useState(false);

  const handleAction = async (action: 'start' | 'ready') => {
    setIsLoading(true);
    try {
      if (action === 'start') {
        await onStart(order.id);
      } else {
        await onReady(order.id);
      }
    } finally {
      setIsLoading(false);
    }
  };

  const statusLabel = order.status === 'pending' ? t('status.pending') : t('status.preparing');

  return (
    <div
      className={`${getStatusColor(order.elapsedSeconds, order.status)} ${getStatusBgColor(order.status)} rounded-lg p-6 shadow-lg flex flex-col h-full transition-all duration-300 border border-neutral-800`}
    >
      {/* Order Header */}
      <div className="flex items-start justify-between mb-4 border-b border-neutral-800 pb-4">
        <div>
          <h2 className="text-5xl font-black tracking-tighter text-white mb-1">#{order.order_number}</h2>
          <p className="text-sm text-neutral-500">{t('orders.orderId', { id: String(order.id).slice(0, 8) })}</p>
        </div>
        <div className="flex items-center gap-2">
          {order.source === 'qr_order' && (
            <span className="bg-violet-600 text-white px-2.5 py-1.5 rounded-full font-bold text-xs whitespace-nowrap">
              QR
            </span>
          )}
          {order.table_number && (
            <span className="bg-sky-600 text-white px-2.5 py-1.5 rounded-full font-bold text-xs whitespace-nowrap">
              Table {order.table_number}
            </span>
          )}
          <span
            className={`${getStatusBadgeColor(order.status)} px-4 py-2 rounded-full font-bold text-sm whitespace-nowrap`}
          >
            {statusLabel}
          </span>
        </div>
      </div>

      {/* Time Elapsed */}
      <div
        className={`flex items-center gap-2 mb-4 text-lg font-semibold ${
          isUrgent(order.elapsedSeconds) ? 'text-brand-400' : 'text-neutral-400'
        }`}
      >
        <Clock size={24} />
        <span>{formatTime(order.elapsedSeconds)}</span>
        {isUrgent(order.elapsedSeconds) && <span className="text-brand-500">{t('status.urgent')}</span>}
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
                  <div key={comboId} className="border border-amber-700/50 rounded-lg p-2 bg-amber-900/10">
                    <p className="text-xs font-bold text-amber-400 uppercase mb-2">{t('orders.combo')}</p>
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

      {/* Action Buttons */}
      <div className="grid grid-cols-2 gap-3 mt-auto">
        {order.status === 'pending' && (
          <button
            onClick={() => handleAction('start')}
            disabled={isLoading}
            className="bg-brand-600 hover:bg-brand-700 disabled:bg-brand-800 disabled:opacity-50 text-white font-bold py-3 px-4 rounded-lg transition-colors text-lg min-h-[48px] flex items-center justify-center"
          >
            {isLoading ? (
              <span className="animate-pulse">{t('actions.starting')}</span>
            ) : (
              <span>{t('actions.start')}</span>
            )}
          </button>
        )}
        {order.status === 'preparing' && (
          <button
            onClick={() => handleAction('ready')}
            disabled={isLoading}
            className="bg-green-600 hover:bg-green-500 disabled:bg-green-700 disabled:opacity-50 text-white font-bold py-3 px-4 rounded-lg transition-colors text-lg min-h-[48px] flex items-center justify-center col-span-2"
          >
            {isLoading ? (
              <span className="animate-pulse">{t('actions.markingReady')}</span>
            ) : (
              <span>{t('actions.readyForPickup')}</span>
            )}
          </button>
        )}
        {order.status === 'pending' && (
          <button
            disabled
            className="col-span-2 bg-neutral-800 text-neutral-600 font-bold py-3 px-4 rounded-lg cursor-not-allowed text-lg min-h-[48px] flex items-center justify-center"
          >
            {t('actions.clickStartFirst')}
          </button>
        )}
      </div>
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
