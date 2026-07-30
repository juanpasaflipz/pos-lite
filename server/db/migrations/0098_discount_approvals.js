export const version = 98;
export const name = 'discount_approvals';

// Server-side approval records for discounts (2026-07-30).
//
// Closes the last self-authorizable gate. `authorizeDiscount` used to accept a
// bare `authorized_by_employee_id` integer from the request body with nothing
// binding it to the PIN that produced it, so any pos_access client could name
// any manager's employee id — they are small sequential integers, enumerable
// via GET /employees — and self-authorize a discount, `comp` (100% off)
// included.
//
// Every other approval gate takes a signed 5-minute X-Approval-Token instead.
// That shape does not fit discounts: the approver rides inside the cart
// payload rather than a request header, one cart can carry several separately
// approved discounts (per-line plus cart-level), and a cart can sit open far
// longer than the token's TTL before anyone hits Cobrar. So the approval
// becomes a row the cart references by id.
//
// Design notes worth not re-litigating:
//   - UUID id, not SERIAL. Guessable ids are the disease being cured; a
//     sequential id would let one terminal spend another terminal's freshly
//     minted approval. Also means no sequence grant.
//   - The binding columns (scope, discount_type, discount_value) are what stop
//     a 10%-off approval from being replayed as a comp. They are matched in
//     the consuming UPDATE's WHERE clause, so validation and consumption are
//     one atomic statement.
//   - consumed_at makes an approval single-use. That is what stops one
//     approval from covering N discounted lines — the old code authorized once
//     and stamped the same approver onto every discounted line.
//   - 12-hour expiry, not 5 minutes: an approval taken at the start of a cart
//     must still work when that cart is paid, and an order queued offline can
//     sync hours later. Single-use is the real control; the TTL only stops an
//     approval outliving the shift that granted it.
//   - consumed_order_id / consumed_order_item_id carry no FK on purpose.
//     Orders are deletable (DELETE /orders/:id), and the approval record has
//     to survive the order it authorized — it is forensic evidence.
//
// Expired-but-unconsumed rows are never cleaned up here: "a manager approved a
// discount that was never applied" is a signal worth keeping. Revisit with a
// retention sweep if the table ever grows enough to matter.
export async function up(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS discount_approvals (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
      approver_employee_id INTEGER NOT NULL REFERENCES employees(id),
      requested_by_employee_id INTEGER REFERENCES employees(id),
      -- Binding: what exactly the manager put their PIN behind.
      scope TEXT NOT NULL CHECK (scope IN ('cart', 'line')),
      discount_type TEXT NOT NULL CHECK (discount_type IN ('percent', 'amount', 'comp')),
      discount_value NUMERIC(10,2) NOT NULL,
      -- Recorded for forensics, deliberately NOT matched on consume: a cart
      -- legitimately grows after a cart-level percentage is approved, so
      -- enforcing the base would break honest flows. See the note in
      -- authorizeDiscount about percent-approval base drift.
      base_amount NUMERIC(10,2),
      item_label TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '12 hours',
      consumed_at TIMESTAMPTZ,
      consumed_order_id INTEGER,
      consumed_order_item_id INTEGER
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_discount_approvals_tenant_created
      ON discount_approvals (tenant_id, created_at DESC)
  `;

  await sql`ALTER TABLE discount_approvals ENABLE ROW LEVEL SECURITY`;

  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = 'discount_approvals' AND policyname = 'tenant_isolation'
      ) THEN
        CREATE POLICY tenant_isolation ON discount_approvals
          USING (tenant_id = current_setting('app.tenant_id', true));
      END IF;
    END $$
  `;

  // Nothing in the app removes an approval record. Note this GRANT does not by
  // itself withhold DELETE — a database-level default ACL hands app_user `arwd`
  // on every new table, so the REVOKE that actually enforces append-only lives
  // in migration 0099.
  await sql`GRANT SELECT, INSERT, UPDATE ON discount_approvals TO app_user`;
}
