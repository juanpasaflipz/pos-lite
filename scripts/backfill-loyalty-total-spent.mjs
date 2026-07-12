// Backfill `loyalty_customers.total_spent` from linked orders (additive-only).
//
// Why: prior to the 2026-07-11 fix, only stamps granted via the
// /customers/:id/stamp route updated total_spent. Kiosk and POS auto-stamp
// paths silently skipped the update, so ~everyone shows $0.00 in the CRM.
//
// Strategy: for each customer, sum linked orders' totals. If the computed
// sum > current stored value, bump total_spent UP to computed. If computed
// < current (order deletes, ticket re-rings, historical manual adjustments),
// leave the row alone and log it to audits/raw/loyalty-total-spent-overcounts.md
// for separate human review.
//
// Modes:
//   DRY_RUN=1 node scripts/backfill-loyalty-total-spent.mjs   ← preview only
//              node scripts/backfill-loyalty-total-spent.mjs   ← write

import 'dotenv/config';
import postgres from 'postgres';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const OVERCOUNT_LOG_PATH = 'audits/raw/loyalty-total-spent-overcounts.md';
const sql = postgres(process.env.DATABASE_URL, { ssl: 'require', max: 1 });

try {
  await sql`SET row_security = off`;

  // Preview: what would each customer's total_spent become?
  const rows = await sql`
    SELECT lc.id,
           lc.tenant_id,
           lc.name,
           lc.phone,
           lc.total_spent          AS current_total_spent,
           COALESCE(SUM(o.total), 0)::numeric(10,2) AS computed_total_spent,
           COUNT(o.id)             AS linked_orders
    FROM loyalty_customers lc
    LEFT JOIN orders o
      ON o.loyalty_customer_id = lc.id
     AND o.tenant_id           = lc.tenant_id
     AND COALESCE(o.status, '') NOT IN ('void', 'voided', 'canceled', 'cancelled', 'draft_kiosk')
    GROUP BY lc.id
    HAVING lc.total_spent IS DISTINCT FROM COALESCE(SUM(o.total), 0)::numeric(10,2)
    ORDER BY lc.tenant_id, lc.id
  `;

  const undercounts = rows.filter((r) => Number(r.computed_total_spent) > Number(r.current_total_spent));
  const overcounts = rows.filter((r) => Number(r.computed_total_spent) < Number(r.current_total_spent));

  console.log(`\n=== Backfill plan ===\n`);
  console.log(`  Undercounts (will bump UP):   ${undercounts.length}`);
  console.log(`  Overcounts  (LEFT ALONE, logged): ${overcounts.length}`);

  console.log(`\n--- Undercounts (sample of ${Math.min(20, undercounts.length)}) ---`);
  for (const row of undercounts.slice(0, 20)) {
    console.log(
      `  ${row.tenant_id} | ${row.name.padEnd(22)} | ${row.phone.padEnd(12)} | ` +
      `$${row.current_total_spent} → $${row.computed_total_spent}  (${row.linked_orders} orders)`
    );
  }
  if (undercounts.length > 20) console.log(`  ... and ${undercounts.length - 20} more`);

  console.log(`\n--- Overcounts (sample of ${Math.min(10, overcounts.length)}) ---`);
  for (const row of overcounts.slice(0, 10)) {
    console.log(
      `  ${row.tenant_id} | ${row.name.padEnd(22)} | ${row.phone.padEnd(12)} | ` +
      `stored=$${row.current_total_spent}  computed=$${row.computed_total_spent}  (${row.linked_orders} linked orders)`
    );
  }

  // Write the overcount review log regardless of DRY_RUN — it's inert audit data.
  if (overcounts.length > 0) {
    mkdirSync(dirname(OVERCOUNT_LOG_PATH), { recursive: true });
    const lines = [
      `# Loyalty total_spent overcounts — 2026-07-11 backfill review`,
      ``,
      `These customers have a stored \`total_spent\` **greater than** the sum of their`,
      `currently-linked orders. The additive backfill left them untouched. Likely causes:`,
      ``,
      `- Historical order re-linking / deletion (staff re-rang tickets, orders purged)`,
      `- Manual \`total_spent\` adjustments via \`PUT /customers/:id\``,
      `- Orders in statuses this backfill excluded (\`void\`/\`canceled\`/\`draft_kiosk\`)`,
      ``,
      `Review one by one — if the stored value is right (e.g. historical revenue that`,
      `predates linking), leave it. If it's wrong, correct via the admin UI.`,
      ``,
      `| Tenant | Customer | Phone | Stored | Computed | Linked orders |`,
      `|---|---|---|---:|---:|---:|`,
      ...overcounts.map((r) => `| ${r.tenant_id} | ${r.name} | ${r.phone} | $${r.current_total_spent} | $${r.computed_total_spent} | ${r.linked_orders} |`),
      ``,
    ];
    writeFileSync(OVERCOUNT_LOG_PATH, lines.join('\n'));
    console.log(`\nOvercount review log written to ${OVERCOUNT_LOG_PATH}`);
  }

  if (DRY_RUN) {
    console.log('\nDRY_RUN=1 — no writes performed. Rerun without DRY_RUN to apply.');
  } else {
    console.log('\nApplying additive backfill...');
    const result = await sql`
      UPDATE loyalty_customers lc
         SET total_spent = sub.computed
      FROM (
        SELECT lc2.id,
               COALESCE(SUM(o.total), 0)::numeric(10,2) AS computed
        FROM loyalty_customers lc2
        LEFT JOIN orders o
          ON o.loyalty_customer_id = lc2.id
         AND o.tenant_id           = lc2.tenant_id
         AND COALESCE(o.status, '') NOT IN ('void', 'voided', 'canceled', 'cancelled', 'draft_kiosk')
        GROUP BY lc2.id
      ) sub
      WHERE lc.id = sub.id
        AND sub.computed > lc.total_spent
    `;
    console.log(`Updated ${result.count} customer rows.`);
  }
} finally {
  await sql.end({ timeout: 5 });
}
