// Reconcile orders that were paid on the MP terminal but missing in pos-lite.
// Mirrors markTerminalOrderPaid() semantics: payment_status='paid',
// payment_method='card', paid_at=NOW(), deducts inventory, inserts an
// order_payments row for the audit trail.
//
// Dry-run by default. Pass --apply to actually mutate.
//
// Usage:
//   PROD_DATABASE_URL=... node scripts/reconcile-unpaid-card.mjs \
//     --tenant=juanbertos --orders=6261,6262,6265 [--mp-id-6261=ORDxxx ...] [--apply]

import postgres from 'postgres';

const DB_URL = process.env.PROD_DATABASE_URL;
if (!DB_URL) { console.error('Set PROD_DATABASE_URL'); process.exit(1); }

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? true];
}));
const TENANT = args.tenant || 'juanbertos';
const APPLY = args.apply === true || args.apply === 'true';
const orderIds = String(args.orders || '').split(',').map(s => Number(s.trim())).filter(Boolean);
if (!orderIds.length) { console.error('Pass --orders=id1,id2,...'); process.exit(1); }

const sql = postgres(DB_URL, { ssl: 'require' });

console.log(`Tenant : ${TENANT}`);
console.log(`Orders : ${orderIds.join(', ')}`);
console.log(`Mode   : ${APPLY ? 'APPLY' : 'DRY-RUN (no mutations)'}\n`);

const orders = await sql`
  SELECT id, order_number, status, payment_status, payment_method,
         mp_order_id, total, tip, paid_at
  FROM orders
  WHERE tenant_id = ${TENANT} AND id = ANY(${orderIds})
  ORDER BY id
`;

if (orders.length !== orderIds.length) {
  const found = new Set(orders.map(o => o.id));
  const missing = orderIds.filter(id => !found.has(id));
  console.error(`Missing order ids on ${TENANT}: ${missing.join(', ')}`);
  await sql.end(); process.exit(1);
}

console.log('=== Current state ===');
console.table(orders.map(o => ({
  id: o.id, order_number: o.order_number, status: o.status,
  payment_status: o.payment_status, payment_method: o.payment_method,
  total: Number(o.total), has_mp_id: o.mp_order_id != null, paid_at: o.paid_at,
})));

const alreadyPaid = orders.filter(o => o.payment_status === 'paid');
if (alreadyPaid.length) {
  console.warn(`\n${alreadyPaid.length} order(s) already paid — will be skipped:`,
    alreadyPaid.map(o => o.id).join(', '));
}

const toFix = orders.filter(o => o.payment_status !== 'paid');
if (!toFix.length) { console.log('\nNothing to do.'); await sql.end(); process.exit(0); }

console.log(`\n=== Plan for ${toFix.length} order(s) ===`);
for (const o of toFix) {
  const mpId = args[`mp-id-${o.id}`] || null;
  console.log(`  #${o.id} (${o.order_number}) $${Number(o.total)}` +
    `  → payment_status=paid, payment_method=card, paid_at=NOW()` +
    (mpId ? `, mp_order_id=${mpId}` : '') +
    `, +order_payments row, deduct inventory`);
}

if (!APPLY) {
  console.log('\nDry-run complete. Re-run with --apply to execute.');
  await sql.end(); process.exit(0);
}

console.log('\nApplying...');
await sql.begin(async (tx) => {
  await tx`SELECT set_config('app.tenant_id', ${TENANT}, true)`;
  for (const o of toFix) {
    const mpId = args[`mp-id-${o.id}`] || null;

    // Mirror markTerminalOrderPaid order-row update + status guard.
    const updated = await tx`
      UPDATE orders
      SET payment_status = 'paid',
          payment_method = 'card',
          paid_at = COALESCE(paid_at, NOW()),
          status = CASE
            WHEN status IN ('ready', 'completed') THEN status
            ELSE 'preparing'
          END,
          mp_order_id = COALESCE(mp_order_id, ${mpId})
      WHERE id = ${o.id} AND tenant_id = ${TENANT}
      RETURNING id
    `;
    if (!updated.length) {
      throw new Error(`Order ${o.id} did not update — abort`);
    }

    // Insert audit row in order_payments (matches recordMpTerminalPayment shape
    // minus fee data, which we don't have for reconciled-after-the-fact rows).
    await tx`
      INSERT INTO order_payments
        (tenant_id, order_id, payment_method, amount, tip, status, payment_intent_id, processor_response)
      VALUES (${TENANT}, ${o.id}, 'card', ${Number(o.total)}, ${Number(o.tip || 0)},
              'paid', ${mpId}, ${sql.json({ reconciled: true, reason: 'orphan-terminal-payment', script: 'reconcile-unpaid-card' })})
    `;

    // Deduct inventory — these orders skipped the normal payment->deduct path.
    await tx.unsafe(`
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
    `, [o.id]);

    console.log(`  #${o.id} → reconciled`);
  }
});

console.log('\nDone. Verify with mp-payments-today.mjs.');
await sql.end();
