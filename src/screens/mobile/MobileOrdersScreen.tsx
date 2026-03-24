import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { getKitchenOrders } from '../../api';
import { Order } from '../../types';
import { formatPrice } from '../../utils/currency';
import { formatTime } from '../../utils/dateFormat';
import { useNetworkStatus } from '../../hooks/useNetworkStatus';
import MobileHeader from '../../components/mobile/MobileHeader';
import { RefreshCw, WifiOff, ChevronDown, ChevronUp } from 'lucide-react';

const statusColors: Record<string, string> = {
  pending: 'bg-brand-600',
  confirmed: 'bg-blue-600',
  preparing: 'bg-amber-500 text-neutral-900',
  ready: 'bg-green-600',
  completed: 'bg-neutral-600',
  cancelled: 'bg-red-600',
};

const MobileOrdersScreen: React.FC = () => {
  const { t } = useTranslation('pos');
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const { isOnline } = useNetworkStatus();

  const fetchOrders = useCallback(async () => {
    try {
      const data = await getKitchenOrders();
      // Show today's orders, sorted newest first
      setOrders(data.sort((a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      ));
    } catch {
      // silent fail — will retry on next poll
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchOrders();
    const interval = setInterval(fetchOrders, 10_000);
    return () => clearInterval(interval);
  }, [fetchOrders]);

  const handleRefresh = () => {
    setRefreshing(true);
    fetchOrders();
  };

  return (
    <>
      <MobileHeader
        title={t('mobileOrders.title')}
        rightAction={
          <div className="flex items-center gap-2">
            {!isOnline && <WifiOff className="w-4 h-4 text-brand-500 animate-pulse" />}
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              className="p-2 text-neutral-400 hover:text-white transition-colors touch-manipulation"
            >
              <RefreshCw className={`w-5 h-5 ${refreshing ? 'animate-spin' : ''}`} />
            </button>
          </div>
        }
      />

      <div className="p-4 space-y-3">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <p className="text-neutral-500 animate-pulse">{t('mobileOrders.loadingOrders')}</p>
          </div>
        ) : orders.length === 0 ? (
          <div className="flex items-center justify-center py-20">
            <p className="text-neutral-500">{t('mobileOrders.noOrdersToday')}</p>
          </div>
        ) : (
          orders.map((order) => {
            const isExpanded = expandedId === order.id;
            return (
              <div
                key={order.id}
                className="bg-neutral-900 border border-neutral-800 rounded-xl overflow-hidden"
              >
                <button
                  onClick={() => setExpandedId(isExpanded ? null : order.id)}
                  className="w-full flex items-center justify-between p-4 touch-manipulation"
                >
                  <div className="flex items-center gap-3">
                    <span className="text-xl font-black text-white">#{order.order_number}</span>
                    <span className={`px-2.5 py-1 rounded-full text-xs font-bold text-white ${statusColors[order.status] || 'bg-neutral-600'}`}>
                      {t(`common:orderStatus.${order.status}`, order.status)}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="text-right">
                      <p className="text-sm font-bold text-brand-500">{formatPrice(order.total)}</p>
                      <p className="text-xs text-neutral-500">{formatTime(new Date(order.created_at))}</p>
                    </div>
                    {isExpanded ? (
                      <ChevronUp className="w-4 h-4 text-neutral-500" />
                    ) : (
                      <ChevronDown className="w-4 h-4 text-neutral-500" />
                    )}
                  </div>
                </button>

                {isExpanded && order.items && (
                  <div className="border-t border-neutral-800 p-4 space-y-2">
                    {order.items.map((item, i) => (
                      <div key={i} className="flex justify-between items-center">
                        <div>
                          <p className="text-sm text-white font-semibold">{item.item_name}</p>
                          {item.notes && (
                            <p className="text-xs text-neutral-400 italic">{item.notes}</p>
                          )}
                        </div>
                        <div className="text-right">
                          <span className="text-xs text-neutral-400 mr-2">x{item.quantity}</span>
                          <span className="text-sm text-white font-semibold">{formatPrice(item.unit_price * item.quantity)}</span>
                        </div>
                      </div>
                    ))}
                    <div className="pt-2 border-t border-neutral-800 flex justify-between">
                      <span className="text-sm text-neutral-400">{t('mobileOrders.total')}</span>
                      <span className="text-sm font-bold text-brand-500">{formatPrice(order.total)}</span>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </>
  );
};

export default MobileOrdersScreen;
