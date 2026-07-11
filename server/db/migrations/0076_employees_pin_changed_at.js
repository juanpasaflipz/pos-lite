export const version = 76;
export const name = 'employees_pin_changed_at';

// Adds employees.pin_changed_at to support session invalidation on PIN change.
//
// Employee JWTs are valid for 24h with no revocation path, so changing a
// compromised PIN did not log out existing sessions (surfaced after a
// suspicious unpaid order on a shared cashier account). We now stamp
// pin_changed_at whenever a PIN is set/changed and reject any employee JWT
// whose `iat` predates that stamp (see server/middleware/auth.js).
//
// Backfill: existing rows get pin_changed_at = created_at so already-issued
// tokens (all necessarily issued after creation) stay valid until they expire.

export async function up(sql) {
  await sql`
    ALTER TABLE employees
    ADD COLUMN IF NOT EXISTS pin_changed_at TIMESTAMPTZ
  `;

  await sql`
    UPDATE employees
    SET pin_changed_at = created_at
    WHERE pin_changed_at IS NULL
  `;
}
