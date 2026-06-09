export const version = 69;
export const name = 'uber_direct_foundation';

// Uber Direct (white-label courier dispatch) reuses the existing
// delivery_orders / delivery_platforms tables. The Marketplace integration
// already populates display_name + courier-free columns; Direct needs a few
// courier-tracking columns so we can render the live status pill, hand the
// eater a tracking URL, and reconcile fees on the Delivery reports tab.

export async function up(sql) {
  await sql`ALTER TABLE delivery_orders ADD COLUMN IF NOT EXISTS tracking_url TEXT`;
  await sql`ALTER TABLE delivery_orders ADD COLUMN IF NOT EXISTS courier_name TEXT`;
  await sql`ALTER TABLE delivery_orders ADD COLUMN IF NOT EXISTS courier_phone TEXT`;
  await sql`ALTER TABLE delivery_orders ADD COLUMN IF NOT EXISTS courier_vehicle TEXT`;

  // Direct charges a flat per-delivery fee (no commission %), so the platform
  // row is created with commission_percent=0. Created lazy at first webhook /
  // first booking via ensurePlatform() in the route, but we seed any tenant
  // that already has another delivery_platforms row so the Reports tab shows
  // it without a manual step.
  await sql`
    INSERT INTO delivery_platforms (tenant_id, name, display_name, commission_percent, active)
    SELECT DISTINCT tenant_id, 'uber_direct', 'Uber Direct', 0, true
    FROM delivery_platforms
    WHERE NOT EXISTS (
      SELECT 1 FROM delivery_platforms dp2
      WHERE dp2.tenant_id = delivery_platforms.tenant_id
        AND dp2.name = 'uber_direct'
    )
  `;
}
