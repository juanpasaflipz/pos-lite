import { useState, useEffect, useCallback, useRef } from 'react';
import { offlineDb } from '../lib/offlineDb';

const HEARTBEAT_INTERVAL = 30_000; // 30 seconds
const HEARTBEAT_TIMEOUT = 3_000; // 3 seconds

interface NetworkStatus {
  isOnline: boolean;
  pendingSyncCount: number;
  lastChecked: number;
}

export function useNetworkStatus(): NetworkStatus {
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [pendingSyncCount, setPendingSyncCount] = useState(0);
  const [lastChecked, setLastChecked] = useState(Date.now());
  const intervalRef = useRef<ReturnType<typeof setInterval>>();

  const checkConnection = useCallback(async () => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), HEARTBEAT_TIMEOUT);
      await fetch('/api/health', { signal: controller.signal, cache: 'no-store' });
      clearTimeout(timeout);
      setIsOnline(true);
    } catch {
      setIsOnline(false);
    }
    setLastChecked(Date.now());
  }, []);

  const updatePendingCount = useCallback(async () => {
    try {
      const count = await offlineDb.offlineOrders
        .where('status')
        .anyOf(['pending_sync', 'sync_failed'])
        .count();
      setPendingSyncCount(count);
    } catch {
      // IndexedDB not ready yet
    }
  }, []);

  // Listen to browser online/offline events
  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      checkConnection(); // verify with server
    };
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [checkConnection]);

  // Heartbeat: verify actual connectivity every 30s
  useEffect(() => {
    checkConnection();
    intervalRef.current = setInterval(checkConnection, HEARTBEAT_INTERVAL);
    return () => clearInterval(intervalRef.current);
  }, [checkConnection]);

  // Poll pending sync count
  useEffect(() => {
    updatePendingCount();
    const id = setInterval(updatePendingCount, 5_000);
    return () => clearInterval(id);
  }, [updatePendingCount]);

  return { isOnline, pendingSyncCount, lastChecked };
}
