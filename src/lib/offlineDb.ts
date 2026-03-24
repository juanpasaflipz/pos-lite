import Dexie, { type Table } from 'dexie';
import type { CartItem, Employee } from '../types';

/* ==================== Types ==================== */

export interface CachedMenuData {
  key: string;
  data: any;
  updatedAt: number;
}

export type OfflineOrderStatus = 'pending_sync' | 'syncing' | 'synced' | 'sync_failed';

export interface OfflineOrder {
  id?: number;
  tempId: string;
  offlineOrderNumber: string;
  employeeId: number;
  employeeName: string;
  items: Array<{
    menu_item_id: number;
    item_name: string;
    quantity: number;
    unit_price: number;
    notes?: string;
    modifiers?: number[];
    selectedModifierNames?: string[];
    combo_instance_id?: string | null;
    virtual_brand_id?: number | null;
  }>;
  subtotal: number;
  tax: number;
  total: number;
  tip: number;
  amountReceived: number;
  changeDue: number;
  status: OfflineOrderStatus;
  syncAttempts: number;
  serverId?: number;
  serverOrderNumber?: string;
  syncError?: string;
  createdAt: number;
  syncedAt?: number;
}

export interface CachedCart {
  id: number; // always 1 (singleton)
  items: CartItem[];
  updatedAt: number;
}

export interface CachedEmployee {
  id: number;
  name: string;
  role: Employee['role'];
  active: boolean;
  permissions: string[];
  pinHash: string;
  token: string | null;
  cachedAt: number;
}

/* ==================== Database ==================== */

class OfflineDatabase extends Dexie {
  menuCache!: Table<CachedMenuData, string>;
  offlineOrders!: Table<OfflineOrder, number>;
  cart!: Table<CachedCart, number>;
  employees!: Table<CachedEmployee, number>;

  constructor() {
    super('desktop-kitchen-offline');

    this.version(1).stores({
      menuCache: 'key',
      offlineOrders: '++id, tempId, status, createdAt',
      cart: 'id',
      employees: 'id',
    });
  }
}

export const offlineDb = new OfflineDatabase();
