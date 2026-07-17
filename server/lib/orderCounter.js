import { adminSql } from '../db/index.js';

// The daily_order_counter table is created at runtime rather than in a
// migration because it was added late and predates the migration numbering
// convention. Both orders.js and kiosk.js call this before their first insert
// on boot; the kiosk copy used to omit the GRANT (fresh-DB footgun where
// app_user reads succeeded but UPDATEs failed). Centralized here so any new
// caller gets both the table and the grant.
let counterTableReady = false;

export async function ensureCounterTable() {
  if (counterTableReady) return;
  await adminSql.unsafe(`
    CREATE TABLE IF NOT EXISTS daily_order_counter (
      tenant_id TEXT NOT NULL,
      date_key DATE NOT NULL,
      last_seq INT NOT NULL DEFAULT 0,
      PRIMARY KEY (tenant_id, date_key)
    )
  `);
  await adminSql
    .unsafe(`GRANT SELECT, INSERT, UPDATE ON daily_order_counter TO app_user`)
    .catch(() => {});
  counterTableReady = true;
}
