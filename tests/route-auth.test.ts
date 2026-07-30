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
import { requireAuth, signApprovalToken, verifyApprovalToken } from '../server/middleware/auth.js';
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

// Manager-PIN override for the money-adjacent actions a cashier legitimately
// performs with a manager standing next to them: void an order, refund a
// payment, stamp a CFDI. The permission grid still says no; a signed one-shot
// approval from POST /employees/manager-approve says yes for one request.
//
// The security property under test is that the approval is UNFORGEABLE and
// NON-TRANSFERABLE: it must be signed by us, scoped to the exact permission
// being exercised, and scoped to the tenant that minted it. Anything less and a
// cashier could self-authorize a refund by naming a manager.
describe('requireAuth: manager-approval override', () => {
  const approvalFor = (permission: string, over: Record<string, unknown> = {}) =>
    signApprovalToken({
      tenantId: tenant.id,
      approverId: managerId,
      approverName: 'Mgr',
      permission,
      ...over,
    });

  const cashierReq = (approvalToken?: string) => ({
    headers: {
      authorization: `Bearer ${tokenFor(tenant.id, cashierId, 'cashier')}`,
      ...(approvalToken ? { 'x-approval-token': approvalToken } : {}),
    },
    tenant: { id: tenant.id },
  });

  it('tells the client to raise the PIN pad when no approval is presented', async () => {
    const r = await runGuard(requireAuth('void_orders', { allowApproval: true }), cashierReq());
    expect(r.nexted).toBe(false);
    expect(r.status).toBe(403);
    // The machine-readable code is the contract the client keys off — without
    // it the cashier gets a dead-end error string instead of the PIN pad.
    expect(r.body.code).toBe('approval_required');
    expect(r.body.permission).toBe('void_orders');
  });

  it('lets a cashier through with a manager approval for the same permission', async () => {
    const req: any = cashierReq(approvalFor('void_orders'));
    const r = await runGuard(requireAuth('void_orders', { allowApproval: true }), req);
    expect(r.nexted).toBe(true);
    // The handler audits who approved it.
    expect(req.approver).toEqual({ id: managerId, name: 'Mgr' });
  });

  it('does not accept an approval minted for a different permission', async () => {
    // Approve a CFDI, spend it on a void — the whole point of scoping.
    const r = await runGuard(
      requireAuth('void_orders', { allowApproval: true }),
      cashierReq(approvalFor('manage_invoicing')),
    );
    expect(r.nexted).toBe(false);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('approval_required');
  });

  it('does not accept an approval minted by another tenant', async () => {
    const r = await runGuard(
      requireAuth('void_orders', { allowApproval: true }),
      cashierReq(approvalFor('void_orders', { tenantId: 'some_other_tenant' })),
    );
    expect(r.nexted).toBe(false);
    expect(r.status).toBe(403);
  });

  it('does not accept a self-signed approval', async () => {
    // A client forging the payload without our secret must not get through —
    // this is what a bare `authorized_by_employee_id` in the body could not stop.
    const forged = jwt.sign(
      { type: 'approval', tenantId: tenant.id, approverId: managerId, approverName: 'Mgr', permission: 'void_orders' },
      'not-the-real-secret',
      { expiresIn: '5m' },
    );
    const r = await runGuard(requireAuth('void_orders', { allowApproval: true }), cashierReq(forged));
    expect(r.nexted).toBe(false);
    expect(r.status).toBe(403);
  });

  it('does not accept an expired approval', async () => {
    const stale = jwt.sign(
      { type: 'approval', tenantId: tenant.id, approverId: managerId, approverName: 'Mgr', permission: 'void_orders' },
      JWT_SECRET,
      { expiresIn: '-1s' },
    );
    const r = await runGuard(requireAuth('void_orders', { allowApproval: true }), cashierReq(stale));
    expect(r.nexted).toBe(false);
    expect(r.status).toBe(403);
  });

  it('does not accept an employee session token in the approval header', async () => {
    // Type confusion: a cashier's own JWT is validly signed by us. If the
    // approval reader only checked the signature it would sail through.
    const r = await runGuard(
      requireAuth('void_orders', { allowApproval: true }),
      cashierReq(tokenFor(tenant.id, cashierId, 'cashier')),
    );
    expect(r.nexted).toBe(false);
    expect(r.status).toBe(403);
  });

  it('ignores the approval path entirely when the actor already holds the permission', async () => {
    const req: any = {
      headers: { authorization: `Bearer ${tokenFor(tenant.id, managerId, 'manager')}` },
      tenant: { id: tenant.id },
    };
    const r = await runGuard(requireAuth('void_orders', { allowApproval: true }), req);
    expect(r.nexted).toBe(true);
    // No approver on the request — a manager acting alone isn't an override.
    expect(req.approver).toBeUndefined();
  });

  it('still hard-denies when the route did not opt into approvals', async () => {
    const r = await runGuard(requireAuth('void_orders'), cashierReq(approvalFor('void_orders')));
    expect(r.nexted).toBe(false);
    expect(r.status).toBe(403);
    expect(r.body.code).toBeUndefined();
  });
});

// The same signed approval, used as a bare function rather than middleware.
// authorizeOrderEdit can't be a route guard: whether approval is needed depends
// on the order's payment_status, which the handler loads first.
describe('verifyApprovalToken: the non-middleware gate', () => {
  const req = (approvalToken?: string, tenantId = tenant.id) => ({
    headers: approvalToken ? { 'x-approval-token': approvalToken } : {},
    tenant: { id: tenantId },
  });

  const approval = (permission: string, over: Record<string, unknown> = {}) =>
    signApprovalToken({
      tenantId: tenant.id,
      approverId: managerId,
      approverName: 'Mgr',
      permission,
      ...over,
    });

  it('returns the approver for a valid, matching approval', () => {
    expect(verifyApprovalToken(req(approval('void_orders')), 'void_orders')).toEqual({
      id: managerId,
      name: 'Mgr',
    });
  });

  it('returns null when no approval header is present', () => {
    expect(verifyApprovalToken(req(), 'void_orders')).toBeNull();
  });

  it('returns null for a permission mismatch', () => {
    expect(verifyApprovalToken(req(approval('apply_discounts')), 'void_orders')).toBeNull();
  });

  it('returns null for a tenant mismatch', () => {
    // Minted here, replayed against a different resolved tenant.
    expect(verifyApprovalToken(req(approval('void_orders'), 'other_tenant'), 'void_orders')).toBeNull();
  });

  it('returns null for a forged signature', () => {
    const forged = jwt.sign(
      { type: 'approval', tenantId: tenant.id, approverId: managerId, permission: 'void_orders' },
      'not-the-real-secret',
    );
    expect(verifyApprovalToken(req(forged), 'void_orders')).toBeNull();
  });

  it('returns null for an employee session token (type confusion)', () => {
    // Validly signed by us, but not an approval — the old bare-employee-id gate
    // had no equivalent check because there was nothing to check.
    const session = tokenFor(tenant.id, managerId, 'manager');
    expect(verifyApprovalToken(req(session), 'void_orders')).toBeNull();
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
