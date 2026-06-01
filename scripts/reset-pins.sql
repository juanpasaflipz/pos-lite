-- One-time 4-digit PIN reset for all active employees in a tenant.
--
-- Context: switching back from 6-digit to 4-digit PINs locks out any
-- employee whose stored bcrypt hash was generated from a 6-digit value
-- (LoginScreen auto-submits at 4 chars). This snippet bulk-resets PINs
-- and prints plaintext once via RETURNING — copy the output before
-- closing the tab.
--
-- Usage: run in the Neon SQL editor as neondb_owner (bypasses RLS).
-- Replace the subdomain below with the target tenant.
--
-- Compatibility: pgcrypto's crypt(..., gen_salt('bf', 12)) produces
-- $2a$ bcrypt hashes that node-bcrypt verifies cleanly (same cost as
-- BCRYPT_ROUNDS=12 in server/lib/constants.js).
--
-- Collision note: RANDOM() can theoretically repeat in a 4-digit space.
-- With small staff this is unlikely; if duplicates appear in output,
-- rerun for the affected rows or hand-pick a unique replacement.
-- Duplicate PINs collapse to whichever employee bcrypt's iteration
-- matches first.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

WITH target_tenant AS (
  SELECT id FROM tenants WHERE subdomain = 'juanbertos'
),
new_pins AS (
  SELECT
    e.id,
    LPAD(FLOOR(RANDOM() * 10000)::int::text, 4, '0') AS new_pin
  FROM employees e
  JOIN target_tenant t ON e.tenant_id = t.id
  WHERE e.active = true
)
UPDATE employees e
SET pin = crypt(np.new_pin, gen_salt('bf', 12))
FROM new_pins np
WHERE e.id = np.id
RETURNING e.id, e.name, e.role, np.new_pin;
