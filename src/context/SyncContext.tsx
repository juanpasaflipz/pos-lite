import React, { createContext, useContext, useEffect, useRef, useState, useCallback, type ReactNode } from 'react';
import { useNetworkStatus } from '../hooks/useNetworkStatus';
import { SyncEngine } from '../lib/syncEngine';

interface SyncContextType {
  isOnline: boolean;
  pendingSyncCount: number;
  isSyncing: boolean;
  lastSyncAt: number | null;
  triggerSync: () => Promise<void>;
}

const SyncContext = createContext<SyncContextType | undefined>(undefined);

export const SyncProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const { isOnline, pendingSyncCount } = useNetworkStatus();
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const engineRef = useRef<SyncEngine | null>(null);
  const wasOfflineRef = useRef(!isOnline);

  // Initialize sync engine
  useEffect(() => {
    const engine = new SyncEngine({
      onSyncComplete: (count) => {
        setLastSyncAt(Date.now());
        console.log(`[Sync] ${count} order(s) synced`);
      },
      onSyncError: (err) => {
        console.warn(`[Sync] Error: ${err}`);
      },
    });
    engineRef.current = engine;
    engine.start();
    return () => engine.stop();
  }, []);

  // Trigger sync when going from offline → online
  useEffect(() => {
    if (isOnline && wasOfflineRef.current && pendingSyncCount > 0) {
      triggerSync();
    }
    wasOfflineRef.current = !isOnline;
  }, [isOnline]);

  const triggerSync = useCallback(async () => {
    if (!engineRef.current || isSyncing) return;
    setIsSyncing(true);
    try {
      await engineRef.current.syncPendingOrders();
    } finally {
      setIsSyncing(false);
    }
  }, [isSyncing]);

  return (
    <SyncContext.Provider value={{ isOnline, pendingSyncCount, isSyncing, lastSyncAt, triggerSync }}>
      {children}
    </SyncContext.Provider>
  );
};

export const useSync = (): SyncContextType => {
  const ctx = useContext(SyncContext);
  if (!ctx) throw new Error('useSync must be used within SyncProvider');
  return ctx;
};
