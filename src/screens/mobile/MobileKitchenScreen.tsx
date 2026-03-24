import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { getKitchenOrders, updateOrderStatus } from '../../api';
import { Order } from '../../types';
import MobileHeader from '../../components/mobile/MobileHeader';
import { Clock, RefreshCw } from 'lucide-react';

interface OrderWithElapsed extends Order {
  elapsedSeconds: number;
}

const MobileKitchenScreen: React.FC = () => {
  const { t } = useTranslation('pos');
  const [orders, setOrders] = useState<OrderWithElapsed[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<number | null>(null);
  const lastCountRef = useRef(0);
  const audioCtxRef = useRef<AudioContext | null>(null);

  const calcElapsed = (createdAt: string) =>
    Math.floor((Date.now() - new Date(createdAt).getTime()) / 1000);

  const playAlert = useCallback(() => {
    try {
      if (!audioCtxRef.current) {
        audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      }
      const ctx = audioCtxRef.current;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = 800;
      osc.type = 'sine';
      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.5);
    } catch { /* ignore */ }
  }, []);

  const fetchOrders = useCallback(async () => {
    try {
      const data = await getKitchenOrders();
      const active = data
        .filter((o) => o.status !== 'completed' && o.status !== 'cancelled')
        .map((o) => ({ ...o, elapsedSeconds: calcElapsed(o.created_at) }))
        .sort((a, b) => {
          const rank = { pending: 0, preparing: 1 } as Record<string, number>;
          const diff = (rank[a.status] ?? 2) - (rank[b.status] ?? 2);
          return diff !== 0 ? diff : new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
        });

      setOrders(active);
      const pendingCount = active.filter((o) => o.status === 'pending').length;
      if (pendingCount > lastCountRef.current) playAlert();
      lastCountRef.current = pendingCount;
    } catch { /* silent */ } finally {
      setLoading(false);
    }
  }, [playAlert]);

  useEffect(() => {
    fetchOrders();
    const poll = setInterval(fetchOrders, 5_000);
    return () => clearInterval(poll);
  }, [fetchOrders]);

  useEffect(() => {
    const interval = setInterval(() => {
      setOrders((prev) =>
        prev.map((o) => ({ ...o, elapsedSeconds: calcElapsed(o.created_at) }))
      );
    }, 1_000);
    return () => clearInterval(interval);
  }, []);

  const formatElapsed = (s: number) => {
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
  };

  const handleStart = async (id: number) => {
    setActionLoading(id);
    try {
      await updateOrderStatus(id, 'preparing');
      fetchOrders();
    } catch { /* silent */ } finally {
      setActionLoading(null);
    }
  };

  const handleReady = async (id: number) => {
    setActionLoading(id);
    try {
      await updateOrderStatus(id, 'ready');
      fetchOrders();
    } catch { /* silent */ } finally {
      setActionLoading(null);
    }
  };

  const isUrgent = (s: number) => s > 600;

  return (
    <>
      <MobileHeader
        title={t('mobileKitchen.title')}
        rightAction={
          <button
            onClick={fetchOrders}
            className="p-2 text-neutral-400 hover:text-white transition-colors touch-manipulation"
          >
            <RefreshCw className="w-5 h-5" />
          </button>
        }
      />

      <div className="p-4 space-y-4">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Clock className="w-8 h-8 text-brand-500 animate-spin" />
          </div>
        ) : orders.length === 0 ? (
          <div className="text-center py-20">
            <p className="text-2xl font-bold text-green-400">{t('mobileKitchen.allClear')}</p>
            <p className="text-neutral-500 mt-1">{t('mobileKitchen.noPendingOrders')}</p>
          </div>
        ) : (
          orders.map((order) => (
            <div
              key={order.id}
              className={`bg-neutral-900 border rounded-xl overflow-hidden ${
                isUrgent(order.elapsedSeconds) && order.status !== 'completed'
                  ? 'border-brand-500'
                  : 'border-neutral-800'
              }`}
            >
              {/* Order header */}
              <div className="p-4 flex items-center justify-between">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-2xl font-black text-white">#{order.order_number}</span>
                  <span className={`px-2.5 py-1 rounded-full text-xs font-bold ${
                    order.status === 'pending'
                      ? 'bg-brand-600 text-white'
                      : 'bg-amber-500 text-neutral-900'
                  }`}>
                    {t(`common:orderStatus.${order.status}`, order.status)}
                  </span>
                  {order.source === 'qr_order' && (
                    <span className="bg-violet-600 text-white px-2 py-0.5 rounded-full text-xs font-bold">QR</span>
                  )}
                  {order.table_number && (
                    <span className="bg-sky-600 text-white px-2 py-0.5 rounded-full text-xs font-bold">Table {order.table_number}</span>
                  )}
                </div>
                <div className={`flex items-center gap-1 text-sm font-semibold ${
                  isUrgent(order.elapsedSeconds) ? 'text-brand-400' : 'text-neutral-400'
                }`}>
                  <Clock className="w-4 h-4" />
                  {formatElapsed(order.elapsedSeconds)}
                </div>
              </div>

              {/* Items */}
              {order.items && order.items.length > 0 && (
                <div className="px-4 pb-3 space-y-1.5">
                  {order.items.map((item, i) => (
                    <div key={i} className="bg-neutral-800/50 rounded-lg p-2.5 border border-neutral-700">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-semibold text-white">{item.item_name}</span>
                        <span className="bg-neutral-700 text-neutral-200 px-2 py-0.5 rounded-full font-bold text-xs">
                          x{item.quantity}
                        </span>
                      </div>
                      {item.modifiers && item.modifiers.length > 0 && (
                        <div className="mt-1">
                          {item.modifiers.map((mod, j) => (
                            <p key={j} className="text-xs text-brand-400">+ {mod.modifier_name}</p>
                          ))}
                        </div>
                      )}
                      {item.notes && (
                        <p className="text-xs text-brand-300 italic mt-1 border-l-2 border-brand-500 pl-2">{item.notes}</p>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Action buttons */}
              <div className="p-4 pt-0">
                {order.status === 'pending' && (
                  <button
                    onClick={() => handleStart(order.id)}
                    disabled={actionLoading === order.id}
                    className="w-full py-4 bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white font-bold rounded-xl text-lg transition-colors touch-manipulation"
                  >
                    {actionLoading === order.id ? t('mobileKitchen.starting') : t('mobileKitchen.startPreparing')}
                  </button>
                )}
                {order.status === 'preparing' && (
                  <button
                    onClick={() => handleReady(order.id)}
                    disabled={actionLoading === order.id}
                    className="w-full py-4 bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white font-bold rounded-xl text-lg transition-colors touch-manipulation"
                  >
                    {actionLoading === order.id ? t('mobileKitchen.marking') : t('mobileKitchen.readyForPickup')}
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </>
  );
};

export default MobileKitchenScreen;
