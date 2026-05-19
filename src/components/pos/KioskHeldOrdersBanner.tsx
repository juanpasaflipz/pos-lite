import React, { useCallback, useEffect, useState } from 'react';
import { Smartphone, X } from 'lucide-react';
import { claimKioskOrder, getKioskHeldOrders, type KioskHeldOrder } from '../../api';

interface Props {
  onClaim: (order: KioskHeldOrder) => void;
  onError?: (message: string) => void;
}

const money = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });

export default function KioskHeldOrdersBanner({ onClaim, onError }: Props) {
  const [orders, setOrders] = useState<KioskHeldOrder[]>([]);
  const [showList, setShowList] = useState(false);
  const [claiming, setClaiming] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await getKioskHeldOrders();
      setOrders(list);
    } catch (err) {
      console.warn('[kiosk-held] refresh failed', err);
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 30_000);
    return () => clearInterval(interval);
  }, [refresh]);

  const handleClaim = async (order: KioskHeldOrder) => {
    if (claiming) return;
    setClaiming(order.id);
    try {
      await claimKioskOrder(order.id);
      onClaim(order);
      setOrders((prev) => prev.filter((o) => o.id !== order.id));
      setShowList(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'No se pudo reclamar la orden';
      onError?.(message);
    } finally {
      setClaiming(null);
    }
  };

  if (orders.length === 0) return null;

  return (
    <>
      <button
        onClick={() => setShowList(true)}
        className="mx-4 mt-2 mb-1 flex items-center gap-3 rounded-lg bg-brand-600/15 border border-brand-600/40 px-4 py-2 text-left hover:bg-brand-600/25 transition-colors"
      >
        <Smartphone className="h-5 w-5 text-brand-400 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold text-brand-200">
            {orders.length === 1
              ? '1 orden esperando del kiosko'
              : `${orders.length} órdenes esperando del kiosko`}
          </p>
          <p className="text-xs text-neutral-400 truncate">
            Toca para reclamar a la caja
          </p>
        </div>
      </button>

      {showList && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50">
          <div className="bg-neutral-900 rounded-lg border border-neutral-800 shadow-xl max-w-2xl w-full max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-800">
              <h2 className="text-xl font-bold text-white inline-flex items-center gap-2">
                <Smartphone className="h-5 w-5 text-brand-400" />
                Órdenes del kiosko
              </h2>
              <button
                onClick={() => setShowList(false)}
                className="text-neutral-500 hover:text-neutral-300"
              >
                <X size={24} />
              </button>
            </div>
            <div className="overflow-y-auto p-4 space-y-3">
              {orders.map((order) => {
                const itemCount = order.items.reduce((sum, item) => sum + item.quantity, 0);
                return (
                  <div
                    key={order.id}
                    className="rounded-lg bg-neutral-800 border border-neutral-700 p-4 flex items-center gap-4"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-white font-bold truncate">
                        {order.customer_name || 'Cliente'}
                      </p>
                      <p className="text-sm text-neutral-400">
                        Orden #{order.order_number} · {itemCount} {itemCount === 1 ? 'producto' : 'productos'}
                      </p>
                      <p className="text-xs text-neutral-500 mt-1 truncate">
                        {order.items.map((item) => `${item.quantity}× ${item.item_name}`).join(' · ')}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-xl font-black text-brand-300">{money.format(Number(order.total))}</p>
                      <button
                        onClick={() => handleClaim(order)}
                        disabled={claiming === order.id}
                        className="mt-2 px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white text-sm font-bold min-h-[40px]"
                      >
                        {claiming === order.id ? 'Reclamando…' : 'Llevar a caja'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
