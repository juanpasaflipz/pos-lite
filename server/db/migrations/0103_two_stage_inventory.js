export const version = 103;
export const name = 'two_stage_inventory';

// Two-stage inventory: raw stock -> prep runs -> portioned components.
// Spec: PORTION_INVENTORY_SPEC.md (2026-08-03).
//
// The model this replaces conflated "I spent money" with "I can sell food":
// a receipt match incremented inventory_items.quantity, and that same number
// was what recipes deducted against. Buying 10 kg of arrachera does not make
// a single burrito sellable — trim, marinade, cook loss and portioning stand
// in between. This migration adds the second layer (components), the event
// that converts one into the other (prep runs), and the append-only ledger
// that makes every stock movement auditable for the first time.
//
// DEPLOY IS A NO-OP FOR EVERY EXISTING TENANT. tenants.inventory_mode defaults
// to 'ingredients' (today's behavior); every existing inventory_items row
// defaults to kind='raw', which is what those rows already are. Nothing reads
// the new tables until a tenant is flipped to 'two_stage'.
//
// ── Why quantity stays REAL ────────────────────────────────────────────────
// The plan considered ALTERing inventory_items.quantity to NUMERIC(12,4) so
// it could not drift against a NUMERIC ledger. Rejected after measuring the
// blast radius: postgres.js has no numeric type parser configured on either
// pool (server/db/index.js), so NUMERIC columns arrive in JS as STRINGS. The
// out-of-stock classifier compares with strict equality in three places
// (src/screens/InventoryScreen.tsx:265, src/components/inventory/StockTab.tsx:85
// and :219) where "0" === 0 is false — a missed cast would silently disable
// the exact auto-86 path this feature exists to build, and cost_price being
// NUMERIC already shows how easy that class of bug is to introduce here.
//
// Float4 represents integers exactly to 2^24, and the locked v1 decision is
// whole portions, so the ledger/cache invariant is exact for everything P1
// produces. The ledger is NUMERIC(12,4) and remains the source of truth;
// quantity is a cache over it. Revisit only if fractional portions ship.
export async function up(sql) {
  // ── 1. Per-tenant mode switch (0092 kiosk_mode precedent) ────────────────
  await sql`
    ALTER TABLE tenants
      ADD COLUMN IF NOT EXISTS inventory_mode TEXT NOT NULL DEFAULT 'ingredients'
      CHECK (inventory_mode IN ('ingredients', 'two_stage'))
  `;

  // ── 2. The raw/component discriminator + component-only availability flags ─
  // kind='raw'       -> walk-in / dry storage. Never gates the menu.
  // kind='component' -> line inventory, counted in portions. Gates the menu.
  await sql`
    ALTER TABLE inventory_items
      ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'raw'
      CHECK (kind IN ('raw', 'component'))
  `;
  // Portion-level low-stock line, separate from low_stock_threshold (which is
  // in the raw item's own unit and keeps its current meaning).
  await sql`ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS low_threshold_portions NUMERIC(10,2)`;
  // auto_86=false lets a component be tracked without ever blocking a sale
  // (garnishes, things the kitchen can always improvise).
  await sql`ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS auto_86 BOOLEAN NOT NULL DEFAULT true`;
  // Manual kill switch — "86 the asada" when the plancha dies. Always wins
  // over the derived count until cleared.
  await sql`ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS sold_out_manual BOOLEAN NOT NULL DEFAULT false`;

  // ── 3. Prep runs: the conversion event ───────────────────────────────────
  // Inputs are optional (outputs are the hard requirement) — logging what came
  // out is what the kitchen actually knows; what went in is what buys yield %
  // and true cost per portion.
  await sql`
    CREATE TABLE IF NOT EXISTS prep_runs (
      id          SERIAL PRIMARY KEY,
      tenant_id   TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
      prepped_at  TIMESTAMPTZ DEFAULT NOW(),
      employee_id INTEGER REFERENCES employees(id),
      notes       TEXT
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_prep_runs_tenant ON prep_runs(tenant_id, prepped_at DESC)`;
  await sql`ALTER TABLE prep_runs ENABLE ROW LEVEL SECURITY`;
  await sql`ALTER TABLE prep_runs FORCE ROW LEVEL SECURITY`;
  await sql`DROP POLICY IF EXISTS tenant_isolation ON prep_runs`;
  await sql`
    CREATE POLICY tenant_isolation ON prep_runs
      USING (tenant_id = current_setting('app.tenant_id', true))
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true))
  `;
  await sql`GRANT SELECT, INSERT, UPDATE, DELETE ON prep_runs TO app_user`;
  await sql`GRANT USAGE, SELECT ON SEQUENCE prep_runs_id_seq TO app_user`;

  // Raw consumed. cost_at_time snapshots the raw item's cost_price so a later
  // price change never rewrites what a past run actually cost.
  await sql`
    CREATE TABLE IF NOT EXISTS prep_run_inputs (
      id                SERIAL PRIMARY KEY,
      tenant_id         TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
      prep_run_id       INTEGER NOT NULL REFERENCES prep_runs(id) ON DELETE CASCADE,
      inventory_item_id INTEGER NOT NULL REFERENCES inventory_items(id),
      quantity          NUMERIC(12,4) NOT NULL CHECK (quantity > 0),
      cost_at_time      NUMERIC(12,4)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_prep_run_inputs_run ON prep_run_inputs(prep_run_id)`;
  await sql`ALTER TABLE prep_run_inputs ENABLE ROW LEVEL SECURITY`;
  await sql`ALTER TABLE prep_run_inputs FORCE ROW LEVEL SECURITY`;
  await sql`DROP POLICY IF EXISTS tenant_isolation ON prep_run_inputs`;
  await sql`
    CREATE POLICY tenant_isolation ON prep_run_inputs
      USING (tenant_id = current_setting('app.tenant_id', true))
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true))
  `;
  await sql`GRANT SELECT, INSERT, UPDATE, DELETE ON prep_run_inputs TO app_user`;
  await sql`GRANT USAGE, SELECT ON SEQUENCE prep_run_inputs_id_seq TO app_user`;

  // Components produced. This is the count that matters.
  await sql`
    CREATE TABLE IF NOT EXISTS prep_run_outputs (
      id                SERIAL PRIMARY KEY,
      tenant_id         TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
      prep_run_id       INTEGER NOT NULL REFERENCES prep_runs(id) ON DELETE CASCADE,
      inventory_item_id INTEGER NOT NULL REFERENCES inventory_items(id),
      portions          NUMERIC(10,2) NOT NULL CHECK (portions > 0)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_prep_run_outputs_run ON prep_run_outputs(prep_run_id)`;
  await sql`ALTER TABLE prep_run_outputs ENABLE ROW LEVEL SECURITY`;
  await sql`ALTER TABLE prep_run_outputs FORCE ROW LEVEL SECURITY`;
  await sql`DROP POLICY IF EXISTS tenant_isolation ON prep_run_outputs`;
  await sql`
    CREATE POLICY tenant_isolation ON prep_run_outputs
      USING (tenant_id = current_setting('app.tenant_id', true))
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true))
  `;
  await sql`GRANT SELECT, INSERT, UPDATE, DELETE ON prep_run_outputs TO app_user`;
  await sql`GRANT USAGE, SELECT ON SEQUENCE prep_run_outputs_id_seq TO app_user`;

  // ── 4. portion_ledger: append-only truth for every stock movement ────────
  // inventory_items.quantity becomes a cache over this table. The cache clamps
  // at 0 (you cannot have -3 portions on a shelf); the ledger records the
  // UNCLAMPED delta, so overselling stays visible as ledger/cache variance
  // instead of being silently absorbed.
  //
  // ref_id carries NO foreign key on purpose (0098 discount_approvals
  // precedent): orders are hard-deletable via DELETE /api/orders/:id, and the
  // record of what a sale consumed has to survive the order it belonged to.
  await sql`
    CREATE TABLE IF NOT EXISTS portion_ledger (
      id                SERIAL PRIMARY KEY,
      tenant_id         TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
      inventory_item_id INTEGER NOT NULL REFERENCES inventory_items(id),
      delta             NUMERIC(12,4) NOT NULL,
      reason            TEXT NOT NULL CHECK (reason IN (
                          'purchase', 'prep_consume', 'prep_produce', 'sale',
                          'refund_restore', 'void_restore', 'waste',
                          'count_adjust', 'carryover_discard')),
      ref_type          TEXT,
      ref_id            INTEGER,
      employee_id       INTEGER REFERENCES employees(id),
      created_at        TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_portion_ledger_item
      ON portion_ledger(tenant_id, inventory_item_id, created_at DESC)
  `;
  // Drives P2's per-order-item idempotency check (has this line already been
  // deducted?) and P3's per-run correction rollup.
  await sql`
    CREATE INDEX IF NOT EXISTS idx_portion_ledger_ref
      ON portion_ledger(tenant_id, ref_type, ref_id)
  `;
  await sql`ALTER TABLE portion_ledger ENABLE ROW LEVEL SECURITY`;
  await sql`ALTER TABLE portion_ledger FORCE ROW LEVEL SECURITY`;
  await sql`DROP POLICY IF EXISTS tenant_isolation ON portion_ledger`;
  await sql`
    CREATE POLICY tenant_isolation ON portion_ledger
      USING (tenant_id = current_setting('app.tenant_id', true))
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true))
  `;
  await sql`GRANT SELECT, INSERT ON portion_ledger TO app_user`;
  await sql`GRANT USAGE, SELECT ON SEQUENCE portion_ledger_id_seq TO app_user`;

  // The GRANT above is decorative — this database carries an
  // `ALTER DEFAULT PRIVILEGES ... GRANT` by neondb_owner handing app_user
  // `arwd` on every newly created table, which is how 0098 shipped a table it
  // believed was append-only and 0099/0100 had to come back for. Only a REVOKE
  // actually withholds anything.
  //
  // UPDATE is the one that matters: a correction to a prep run is a new
  // compensating row by design, so nothing in the app has a legitimate reason
  // to rewrite what a movement said. That is the property "append-only" is
  // protecting here.
  //
  // DELETE is deliberately KEPT, unlike 0099/0100. Those tables could be locked
  // down because nothing in the app deletes them — but the admin inventory
  // reset ('wipe' and 'zero', server/helpers/inventoryReset.js) does delete
  // ledger rows, and it runs on the tenant connection inside the request
  // transaction. Revoking DELETE would either break that flow or force it onto
  // adminSql, giving up the atomicity that stops a half-finished reset from
  // committing. It also buys nothing: app_user can already DELETE the
  // inventory_items these rows point at, so the ledger is not the weak link.
  await sql`REVOKE UPDATE, TRUNCATE ON portion_ledger FROM app_user`;
  await sql`GRANT DELETE ON portion_ledger TO app_user`;

  // ── 5. Lookup indexes the new read paths need ────────────────────────────
  // Raw/Componentes filtering, and P2's availability query which scans
  // components per tenant.
  await sql`CREATE INDEX IF NOT EXISTS idx_inventory_items_kind ON inventory_items(tenant_id, kind)`;
  // menu_item_ingredients is keyed (menu_item_id, inventory_item_id), so the
  // reverse lookup P2 needs ("which menu items use this component") had no
  // index at all.
  await sql`
    CREATE INDEX IF NOT EXISTS idx_menu_item_ingredients_inventory
      ON menu_item_ingredients(inventory_item_id)
  `;
}
