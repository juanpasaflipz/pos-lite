import { offlineDb, type OfflineOrder } from './offlineDb';
import { createOrder, cashPayment } from '../api';

const MAX_SYNC_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 5_000; // 5s, 15s, 45s, 135s, 405s

export class SyncEngine {
  private syncing = false;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private onSyncComplete?: (syncedCount: number) => void;
  private onSyncError?: (error: string) => void;

  constructor(opts?: {
    onSyncComplete?: (syncedCount: number) => void;
    onSyncError?: (error: string) => void;
  }) {
    this.onSyncComplete = opts?.onSyncComplete;
    this.onSyncError = opts?.onSyncError;
  }

  /** Start auto-sync on 60s interval */
  start() {
    if (this.intervalId) return;
    this.intervalId = setInterval(() => this.syncPendingOrders(), 60_000);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  async syncPendingOrders(): Promise<number> {
    if (this.syncing) return 0;
    this.syncing = true;

    let syncedCount = 0;

    try {
      const pending = await offlineDb.offlineOrders
        .where('status')
        .anyOf(['pending_sync', 'sync_failed'])
        .sortBy('createdAt');

      for (const order of pending) {
        // Skip if max attempts exceeded
        if (order.syncAttempts >= MAX_SYNC_ATTEMPTS) continue;

        // Check backoff delay
        if (order.status === 'sync_failed' && order.syncAttempts > 0) {
          const delay = BACKOFF_BASE_MS * Math.pow(3, order.syncAttempts - 1);
          const lastAttemptTime = order.syncedAt || order.createdAt;
          if (Date.now() - lastAttemptTime < delay) continue;
        }

        try {
          await this.syncSingleOrder(order);
          syncedCount++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Sync failed';
          await offlineDb.offlineOrders.update(order.id!, {
            status: 'sync_failed',
            syncAttempts: order.syncAttempts + 1,
            syncError: msg,
            syncedAt: Date.now(),
          });
          this.onSyncError?.(msg);
        }
      }

      if (syncedCount > 0) {
        this.onSyncComplete?.(syncedCount);
      }
    } finally {
      this.syncing = false;
    }

    return syncedCount;
  }

  private async syncSingleOrder(order: OfflineOrder): Promise<void> {
    // Mark as syncing
    await offlineDb.offlineOrders.update(order.id!, { status: 'syncing' });

    // 1. Create order on server
    const serverOrder = await createOrder({
      employee_id: order.employeeId,
      items: order.items.map((item) => ({
        menu_item_id: item.menu_item_id,
        quantity: item.quantity,
        notes: item.notes,
        modifiers: item.modifiers || [],
        combo_instance_id: item.combo_instance_id || null,
        virtual_brand_id: item.virtual_brand_id || null,
      })),
      offline_temp_id: order.tempId,
    } as any);

    // 2. Process cash payment
    await cashPayment({
      order_id: serverOrder.id,
      tip: order.tip,
      amount_received: order.amountReceived,
    });

    // 3. Mark as synced
    await offlineDb.offlineOrders.update(order.id!, {
      status: 'synced',
      serverId: serverOrder.id,
      serverOrderNumber: String(serverOrder.order_number),
      syncedAt: Date.now(),
    });
  }
}
