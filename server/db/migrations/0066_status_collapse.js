export const version = 66;
export const name = 'status_collapse';

// Collapses the three functionally-equivalent in-flight statuses
// (pending/confirmed/preparing) to a single canonical 'active'.
// See audits/ORDER_FLOW_CONSOLIDATION.md for the rationale.
//
// Idempotent: the UPDATE has no effect once rows are migrated. The DEFAULT
// change is forward-only but harmless to re-apply.
//
// Tolerance: server code keeps accepting the old names as input during the
// rollout window so older deployed kiosks (Android APK in the wild) don't
// 400. Sweep of those write sites happens in a follow-up commit.

export async function up(sql) {
  await sql`
    UPDATE orders
    SET status = 'active'
    WHERE status IN ('pending', 'confirmed', 'preparing')
  `;
  await sql`
    ALTER TABLE orders ALTER COLUMN status SET DEFAULT 'active'
  `;
}
