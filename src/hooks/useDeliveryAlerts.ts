import { useState, useEffect, useCallback, useRef } from 'react';
import { getActiveDeliveryOrders } from '../api';
import { DeliveryOrder } from '../types';

const POLL_INTERVAL = 20_000; // 20 seconds
const TICK_INTERVAL = 1_000;  // 1 second

export interface DeliveryAlert extends DeliveryOrder {
  elapsedSeconds: number;
}

export function useDeliveryAlerts() {
  const [orders, setOrders] = useState<DeliveryOrder[]>([]);
  const [dismissedIds, setDismissedIds] = useState<Set<number>>(new Set());
  const [now, setNow] = useState(Date.now());
  const mountedRef = useRef(true);

  // Poll active delivery orders
  useEffect(() => {
    mountedRef.current = true;

    const fetchOrders = async () => {
      try {
        const data = await getActiveDeliveryOrders();
        if (!mountedRef.current) return;
        setOrders(data);
        // Clean dismissed IDs that are no longer in the active list
        const activeIds = new Set(data.map((o) => o.id));
        setDismissedIds((prev) => {
          const next = new Set<number>();
          prev.forEach((id) => {
            if (activeIds.has(id)) next.add(id);
          });
          return next;
        });
      } catch {
        // Silently fail — banner just won't show
      }
    };

    fetchOrders();
    const interval = setInterval(fetchOrders, POLL_INTERVAL);
    return () => {
      mountedRef.current = false;
      clearInterval(interval);
    };
  }, []);

  // Tick elapsed time every second
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), TICK_INTERVAL);
    return () => clearInterval(interval);
  }, []);

  const dismiss = useCallback((id: number) => {
    setDismissedIds((prev) => new Set(prev).add(id));
  }, []);

  const alerts: DeliveryAlert[] = orders
    .filter((o) => !dismissedIds.has(o.id))
    .map((o) => {
      const createdAt = o.created_at ? new Date(o.created_at).getTime() : now;
      return {
        ...o,
        elapsedSeconds: Math.max(0, Math.floor((now - createdAt) / 1000)),
      };
    });

  return { alerts, dismiss };
}
