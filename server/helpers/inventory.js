import { getConn } from '../db/index.js';

/**
 * Deduct inventory for all items in an order.
 * Single UPDATE+JOIN: aggregates all ingredient requirements across order items
 * and deducts from inventory in one query.
 */
export async function deductInventoryForOrder(orderId) {
  const conn = getConn();
  await conn.unsafe(`
    UPDATE inventory_items ii
    SET quantity = GREATEST(0, ii.quantity - deductions.total_needed)
    FROM (
      SELECT mii.inventory_item_id,
             SUM(mii.quantity_used * oi.quantity) AS total_needed
      FROM order_items oi
      JOIN menu_item_ingredients mii ON mii.menu_item_id = oi.menu_item_id
      WHERE oi.order_id = $1
      GROUP BY mii.inventory_item_id
    ) deductions
    WHERE ii.id = deductions.inventory_item_id
  `, [orderId]);
}

/**
 * Restore inventory for specific refunded items.
 * Single UPDATE+JOIN with unnest: passes per-item refund quantities
 * to handle partial refunds correctly.
 * @param {Array<{order_item_id: number, quantity: number}>} items
 */
export async function restoreInventoryForItems(items) {
  if (!items || items.length === 0) return;
  const conn = getConn();
  const orderItemIds = items.map(i => i.order_item_id);
  const quantities = items.map(i => i.quantity);

  await conn`
    UPDATE inventory_items ii
    SET quantity = ii.quantity + restorations.total_restore
    FROM (
      SELECT mii.inventory_item_id,
             SUM(mii.quantity_used * refund.qty) AS total_restore
      FROM unnest(${orderItemIds}::int[], ${quantities}::numeric[]) AS refund(order_item_id, qty)
      JOIN order_items oi ON oi.id = refund.order_item_id
      JOIN menu_item_ingredients mii ON mii.menu_item_id = oi.menu_item_id
      GROUP BY mii.inventory_item_id
    ) restorations
    WHERE ii.id = restorations.inventory_item_id
  `;
}
