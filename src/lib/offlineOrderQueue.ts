import { offlineDb, type OfflineOrder } from './offlineDb';
import type { CartItem, Order } from '../types';
import { TAX_RATE } from '../utils/currency';

/* ==================== Offline Order Number ==================== */

const COUNTER_KEY = 'offlineOrderCounter';

interface DailyCounter {
  date: string;
  count: number;
}

function getTodayStr(): string {
  return new Date().toISOString().split('T')[0];
}

async function getNextOfflineOrderNumber(): Promise<string> {
  const today = getTodayStr();
  const raw = localStorage.getItem(COUNTER_KEY);
  let counter: DailyCounter = raw ? JSON.parse(raw) : { date: today, count: 0 };

  // Reset counter on new day
  if (counter.date !== today) {
    counter = { date: today, count: 0 };
  }

  counter.count += 1;
  localStorage.setItem(COUNTER_KEY, JSON.stringify(counter));

  return `OFF-${String(counter.count).padStart(3, '0')}`;
}

/* ==================== Order Total Calculation ==================== */

/**
 * Mirrors server-side math exactly:
 * - prices already include 16% IVA
 * - total = sum(unit_price * quantity)
 * - tax = total - (total / 1.16)
 * - subtotal = total - tax
 */
export function calculateOrderTotals(items: CartItem[]): {
  subtotal: number;
  tax: number;
  total: number;
} {
  let total = 0;
  for (const item of items) {
    total += item.unit_price * item.quantity;
  }
  total = Math.round(total * 100) / 100;
  const tax = Math.round((total - total / (1 + TAX_RATE)) * 100) / 100;
  const subtotal = Math.round((total - tax) * 100) / 100;
  return { subtotal, tax, total };
}

/* ==================== Create Offline Order ==================== */

export async function createOfflineOrder(
  employeeId: number,
  employeeName: string,
  cart: CartItem[],
  tip: number,
  amountReceived: number,
): Promise<OfflineOrder> {
  const { subtotal, tax, total } = calculateOrderTotals(cart);
  const totalWithTip = Math.round((total + tip) * 100) / 100;
  const changeDue = Math.round((amountReceived - totalWithTip) * 100) / 100;

  const offlineOrder: OfflineOrder = {
    tempId: crypto.randomUUID(),
    offlineOrderNumber: await getNextOfflineOrderNumber(),
    employeeId,
    employeeName,
    items: cart.map((item) => ({
      menu_item_id: item.menu_item_id,
      item_name: item.item_name,
      quantity: item.quantity,
      unit_price: item.unit_price,
      notes: item.notes,
      modifiers: item.selectedModifierIds || [],
      selectedModifierNames: item.selectedModifierNames || [],
      combo_instance_id: item.combo_instance_id || null,
      virtual_brand_id: item.virtual_brand_id || null,
    })),
    subtotal,
    tax,
    total,
    tip,
    amountReceived,
    changeDue,
    status: 'pending_sync',
    syncAttempts: 0,
    createdAt: Date.now(),
  };

  const id = await offlineDb.offlineOrders.add(offlineOrder);
  return { ...offlineOrder, id: id as number };
}

/* ==================== Query Helpers ==================== */

export async function getPendingOrders(): Promise<OfflineOrder[]> {
  return offlineDb.offlineOrders
    .where('status')
    .anyOf(['pending_sync', 'sync_failed'])
    .sortBy('createdAt');
}

export async function getAllOfflineOrders(): Promise<OfflineOrder[]> {
  return offlineDb.offlineOrders.orderBy('createdAt').reverse().toArray();
}

/**
 * Build a receipt-compatible Order object from an offline order.
 */
export function toReceiptOrder(offline: OfflineOrder): Order {
  return {
    id: -(offline.id ?? 0), // negative ID to distinguish from server orders
    order_number: offline.offlineOrderNumber,
    employee_id: offline.employeeId,
    employee_name: offline.employeeName,
    status: 'pending',
    subtotal: offline.subtotal,
    tax: offline.tax,
    tip: offline.tip,
    total: offline.total + offline.tip,
    payment_status: 'paid',
    payment_method: 'cash',
    source: 'pos',
    created_at: new Date(offline.createdAt).toISOString(),
    items: offline.items.map((item, idx) => ({
      id: idx,
      menu_item_id: item.menu_item_id,
      item_name: item.item_name,
      quantity: item.quantity,
      unit_price: item.unit_price,
      notes: item.notes,
      combo_instance_id: item.combo_instance_id,
    })),
  };
}
