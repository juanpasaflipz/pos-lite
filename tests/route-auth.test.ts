// Route auth-guard tests — the requireAuth middleware behavior that now
// protects the endpoints hardened in the Day-1 pass:
//   - combos mutations (POST/PUT/DELETE, requireAuth('manage_menu'))
//   - employee create/update/toggle (requireAuth('manage_employees')) + list
//   - the four payment GETs (requireAuth())
// plus the new session-invalidation-on-PIN-change logic added to the same
// middleware (server/middleware/auth.js).
//
// These exercise the middleware directly — it's the single shared guard all
// those routes now mount, so testing it once covers the contract with far less
// scaffolding than standing up each route over HTTP. Covered:
//   - missing / malformed / cross-tenant tokens are rejected (401/403)
//   - a permission the role lacks is rejected (403); one it has passes through
//   - a JWT minted BEFORE employees.pin_changed_at is rejected (session
//     invalidation); one minted after passes; a NULL stamp never rejects.

import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestTenant,
  dropTestTenant,
  asTenant,
  closePools,
  type TestTenant,
} from './helpers/db.js';
// @ts-ignore — server files are plain JS
import { adminSql, get } from '../server/db/index.js';
// @ts-ignore
import { requireAuth } from '../server/middleware/auth.js';
// @ts-ignore
import { JWT_SECRET } from '../server/lib/constants.js';

let tenant: TestTenant;
let managerId: number;
let cashierId: number;

// Minimal Express-shaped res double: captures status + json body.
function mockRes() {
  return {
    statusCode: 200,
    body: undefined as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(obj: any) {
      this.body = obj;
      return this;
    },
  };
}

// Invoke a middleware and report how it resolved: did it call next(), and if
// not, what status/body did it send?
async function runGuard(
  mw: (req: any, res: any, next: () => void) => any,
  req: any,
): Promise<{ nexted: boolean; status: number; body: any }> {
  const res = mockRes();
  let nexted = false;
  await mw(req, res, () => {
    nexted = true;
  });
  return { nexted, status: res.statusCode, body: res.body };
}

// Sign an employee JWT. When iatOffsetSec is given, iat/exp are set explicitly
// (jsonwebtoken forbids combining a payload `iat` with the `expiresIn` option),
// letting us mint tokens dated before/after a pin_changed_at stamp.
function tokenFor(
  tenantId: string,
  employeeId: number,
  role: string,
  opts: { iatOffsetSec?: number } = {},
): string {
  const payload: any = { tenantId, employeeId, role, type: 'employee' };
  if (opts.iatOffsetSec !== undefined) {
    const nowSec = Math.floor(Date.now() / 1000);
    payload.iat = nowSec + opts.iatOffsetSec;
    payload.exp = nowSec + 24 * 3600;
    return jwt.sign(payload, JWT_SECRET);
  }
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '24h' });
}

beforeAll(async () => {
  tenant = await createTestTenant('routeauth');
  // Seed a manager (has manage_employees / manage_menu by default) and a
  // cashier (has neither). createTestTenant → createTenant seeds the default
  // role_permissions grid, so these permission checks resolve against real rows.
  await asTenant(tenant.id, async () => {
    const m = await get(
      `INSERT INTO employees (name, pin, role, pin_changed_at)
       VALUES ('Mgr', '1111', 'manager', NOW()) RETURNING id`,
    );
    managerId = Number(m.id);
    const c = await get(
      `INSERT INTO employees (name, pin, role, pin_changed_at)
       VALUES ('Cash', '2222', 'cashier', NOW()) RETURNING id`,
    );
    cashierId = Number(c.id);
  });
}, 60_000);

afterAll(async () => {
  await dropTestTenant(tenant.id);
  await closePools();
}, 30_000);

describe('requireAuth: token validation', () => {
  it('rejects a request with no Authorization header (401)', async () => {
    const r = await runGuard(requireAuth(), { headers: {}, tenant: { id: tenant.id } });
    expect(r.nexted).toBe(false);
    expect(r.status).toBe(401);
  });

  it('rejects a malformed / unverifiable token (401)', async () => {
    const r = await runGuard(requireAuth(), {
      headers: { authorization: 'Bearer not.a.real.jwt' },
      tenant: { id: tenant.id },
    });
    expect(r.nexted).toBe(false);
    expect(r.status).toBe(401);
  });

  it('rejects a token whose tenant != the resolved tenant (403)', async () => {
    // Correctly signed, but for a different tenant → cross-tenant replay guard.
    const foreign = tokenFor('test_someone_else_00000000', managerId, 'manager');
    const r = await runGuard(requireAuth(), {
      headers: { authorization: `Bearer ${foreign}` },
      tenant: { id: tenant.id },
    });
    expect(r.nexted).toBe(false);
    expect(r.status).toBe(403);
  });

  it('passes a valid login-level token when no permission is required', async () => {
    // Mirrors the guard now on GET /employees and the four payment GETs.
    const tok = tokenFor(tenant.id, cashierId, 'cashier');
    const r = await runGuard(requireAuth(), {
      headers: { authorization: `Bearer ${tok}` },
      tenant: { id: tenant.id },
    });
    expect(r.nexted).toBe(true);
    expect(r.status).toBe(200);
  });
});

describe('requireAuth: permission checks', () => {
  it('allows a manager through a manage_employees guard', async () => {
    const tok = tokenFor(tenant.id, managerId, 'manager');
    const r = await runGuard(requireAuth('manage_employees'), {
      headers: { authorization: `Bearer ${tok}` },
      tenant: { id: tenant.id },
    });
    expect(r.nexted).toBe(true);
  });

  it('blocks a cashier at a manage_employees guard (403)', async () => {
    const tok = tokenFor(tenant.id, cashierId, 'cashier');
    const r = await runGuard(requireAuth('manage_employees'), {
      headers: { authorization: `Bearer ${tok}` },
      tenant: { id: tenant.id },
    });
    expect(r.nexted).toBe(false);
    expect(r.status).toBe(403);
  });

  it('blocks a cashier at a manage_menu guard (the combos-mutation guard) (403)', async () => {
    const tok = tokenFor(tenant.id, cashierId, 'cashier');
    const r = await runGuard(requireAuth('manage_menu'), {
      headers: { authorization: `Bearer ${tok}` },
      tenant: { id: tenant.id },
    });
    expect(r.nexted).toBe(false);
    expect(r.status).toBe(403);
  });
});

describe('requireAuth: session invalidation on PIN change', () => {
  it('rejects a JWT minted before the PIN was last changed (401)', async () => {
    // Stamp the PIN change to NOW, then present a token issued an hour earlier.
    await adminSql`
      UPDATE employees SET pin_changed_at = NOW()
      WHERE id = ${cashierId} AND tenant_id = ${tenant.id}
    `;
    const stale = tokenFor(tenant.id, cashierId, 'cashier', { iatOffsetSec: -3600 });
    const r = await runGuard(requireAuth(), {
      headers: { authorization: `Bearer ${stale}` },
      tenant: { id: tenant.id },
    });
    expect(r.nexted).toBe(false);
    expect(r.status).toBe(401);
  });

  it('accepts a JWT minted after the PIN change', async () => {
    // Move the stamp an hour into the past; a token issued now is clearly newer.
    await adminSql`
      UPDATE employees SET pin_changed_at = NOW() - INTERVAL '1 hour'
      WHERE id = ${cashierId} AND tenant_id = ${tenant.id}
    `;
    const fresh = tokenFor(tenant.id, cashierId, 'cashier');
    const r = await runGuard(requireAuth(), {
      headers: { authorization: `Bearer ${fresh}` },
      tenant: { id: tenant.id },
    });
    expect(r.nexted).toBe(true);
  });

  it('never rejects when pin_changed_at is NULL (backward-compat for pre-migration tokens)', async () => {
    await adminSql`
      UPDATE employees SET pin_changed_at = NULL
      WHERE id = ${cashierId} AND tenant_id = ${tenant.id}
    `;
    const stale = tokenFor(tenant.id, cashierId, 'cashier', { iatOffsetSec: -3600 });
    const r = await runGuard(requireAuth(), {
      headers: { authorization: `Bearer ${stale}` },
      tenant: { id: tenant.id },
    });
    expect(r.nexted).toBe(true);
  });
});

// Regression: the inventory/reports/purchase-orders/waste READ endpoints were
// unauthenticated in production until 2026-07-20 — any anonymous caller hitting
// a tenant subdomain could pull sales, COGS, ingredient costs, supplier lists,
// and waste. They now mount bare requireAuth(): a valid same-tenant employee
// token passes; no token / cross-tenant token is rejected. (The guard is the
// shared contract; this pins the "no anonymous business-data reads" invariant.)
describe('requireAuth(): anonymous business-data reads are rejected', () => {
  it('rejects a missing token (401) — the anonymous-leak case', async () => {
    const r = await runGuard(requireAuth(), { headers: {}, tenant: { id: tenant.id } });
    expect(r.nexted).toBe(false);
    expect(r.status).toBe(401);
  });

  it('rejects an owner-type JWT (POS reads require an employee token)', async () => {
    const ownerJwt = jwt.sign({ tenantId: tenant.id, type: 'owner', role: 'owner' }, JWT_SECRET, { expiresIn: '1h' });
    const r = await runGuard(requireAuth(), {
      headers: { authorization: `Bearer ${ownerJwt}` },
      tenant: { id: tenant.id },
    });
    expect(r.nexted).toBe(false);
    expect(r.status).toBe(401);
  });

  it('rejects a valid employee token scoped to another tenant (403)', async () => {
    const otherToken = tokenFor('some_other_tenant', cashierId, 'cashier');
    const r = await runGuard(requireAuth(), {
      headers: { authorization: `Bearer ${otherToken}` },
      tenant: { id: tenant.id },
    });
    expect(r.nexted).toBe(false);
    expect(r.status).toBe(403);
  });

  it('allows any authenticated same-tenant employee (even a cashier with no special perms)', async () => {
    const r = await runGuard(requireAuth(), {
      headers: { authorization: `Bearer ${tokenFor(tenant.id, cashierId, 'cashier')}` },
      tenant: { id: tenant.id },
    });
    expect(r.nexted).toBe(true);
    expect(r.status).toBe(200);
  });
});
