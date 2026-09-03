import { offlineDb, type OfflineOrder } from './offlineDb';
import { syncOfflineOrder } from '../api';

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
    // Recover any orders orphaned in 'syncing' by a crash/reload mid-request,
    // then run an immediate pass so recovered orders don't wait a full interval.
    void this.recoverStuckSyncingOrders().then(() => this.syncPendingOrders());
    this.intervalId = setInterval(() => this.syncPendingOrders(), 60_000);
  }

  /**
   * Reset orders stranded in 'syncing' back to 'sync_failed' so the normal
   * backoff/retry loop picks them up. `syncSingleOrder` flips a row to
   * 'syncing' *before* the network call; if the app crashes or reloads before
   * that call resolves, the row is stuck (the sync loop only queries
   * 'pending_sync'/'sync_failed'). Server-side dedup on `offline_temp_id`
   * makes re-sending safe even if the original request had actually landed.
   */
  async recoverStuckSyncingOrders(): Promise<number> {
    const stuck = await offlineDb.offlineOrders
      .where('status')
      .equals('syncing')
      .toArray();

    for (const order of stuck) {
      await offlineDb.offlineOrders.update(order.id!, {
        status: 'sync_failed',
        syncError: 'Recovered from interrupted sync',
      });
    }

    return stuck.length;
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

    // Single atomic call: order + cash payment in one transaction on the
    // server. Replaces the prior two-call flow that could leave an unpaid
    // orphan if the second call failed.
    const serverOrder = await syncOfflineOrder({
      employee_id: order.employeeId,
      items: order.items.map((item) => ({
        menu_item_id: item.menu_item_id,
        quantity: item.quantity,
        notes: item.notes,
        modifiers: item.modifiers || [],
        combo_instance_id: item.combo_instance_id || null,
        virtual_brand_id: item.virtual_brand_id || null,
        ...(item.is_open_amount
          ? { open_amount: true, item_name: item.item_name, unit_price: item.unit_price }
          : {}),
      })),
      offline_temp_id: order.tempId,
      tip: order.tip,
      amount_received: order.amountReceived,
    } as any);

    await offlineDb.offlineOrders.update(order.id!, {
      status: 'synced',
      serverId: serverOrder.id,
      serverOrderNumber: String(serverOrder.order_number),
      syncedAt: Date.now(),
    });
  }
}
