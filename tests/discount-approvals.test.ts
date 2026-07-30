// Discount approval records — the gate that replaced the self-authorizable
// `authorized_by_employee_id`.
//
// The hole these close: `authorizeDiscount` used to accept a bare employee id
// from the request body with nothing binding it to a PIN entry, so any
// pos_access client could name any manager's (sequential, enumerable) employee
// id and authorize its own discount — `comp`, i.e. 100% off, included.
//
// Invariants guarded here:
//   1. An actor whose own role grants apply_discounts still self-stamps, with
//      no approval record involved (this is also the offline path).
//   2. No approval → 403 carrying code 'approval_required'.
//   3. THE REGRESSION: the old exploit shape (naming a manager's employee id)
//      grants nothing.
//   4. A valid approval authorizes once, returns the approver, and is marked
//      consumed against the order/item it paid for.
//   5. The binding holds: a percent approval cannot be spent as a comp, at a
//      different value, or at a different scope.
//   6. Single-use: a second spend of the same approval fails — which is what
//      stops one approval from covering several discounted lines.
//   7. Expired approvals fail.
//   8. Approvals are invisible across tenants (RLS).

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
import { authorizeDiscount } from '../server/routes/orders.js';

let tenant: TestTenant;
let otherTenant: TestTenant;
let managerId: number;
let cashierId: number;
let otherManagerId: number;

const MANAGER = { id: 0, role: 'manager' };
const CASHIER = { id: 0, role: 'cashier' };

/** Mint an approval row directly — mirrors what /employees/manager-approve inserts. */
async function mintApproval(opts: {
  scope: 'cart' | 'line';
  type: 'percent' | 'amount' | 'comp';
  value: number;
  expiresAt?: string;
  tenantId?: string;
  approverId?: number;
}): Promise<string> {
  const tid = opts.tenantId ?? tenant.id;
  const approverId = opts.approverId ?? managerId;
  // Same reason as the approver: requested_by must belong to the row's tenant.
  const requestedBy = tid === tenant.id ? cashierId : null;
  const [row] = opts.expiresAt
    ? await adminSql`
        INSERT INTO discount_approvals
          (tenant_id, approver_employee_id, requested_by_employee_id, scope,
           discount_type, discount_value, expires_at)
        VALUES (${tid}, ${approverId}, ${requestedBy}, ${opts.scope},
                ${opts.type}, ${opts.value}, ${opts.expiresAt}::timestamptz)
        RETURNING id`
    : await adminSql`
        INSERT INTO discount_approvals
          (tenant_id, approver_employee_id, requested_by_employee_id, scope,
           discount_type, discount_value)
        VALUES (${tid}, ${approverId}, ${requestedBy}, ${opts.scope},
                ${opts.type}, ${opts.value})
        RETURNING id`;
  return String(row.id);
}

beforeAll(async () => {
  tenant = await createTestTenant('discappr');
  otherTenant = await createTestTenant('discoth');

  await asTenant(tenant.id, async () => {
    const mgr = await get(
      `INSERT INTO employees (name, pin, role) VALUES ('Manager', '1111', 'manager') RETURNING id`,
    );
    managerId = Number(mgr.id);
    const csh = await get(
      `INSERT INTO employees (name, pin, role) VALUES ('Cashier', '2222', 'cashier') RETURNING id`,
    );
    cashierId = Number(csh.id);

    // manager may discount; cashier may not.
    await get(
      `INSERT INTO role_permissions (role, permission, granted) VALUES ('manager', 'apply_discounts', true)
       ON CONFLICT (tenant_id, role, permission) DO UPDATE SET granted = true RETURNING id`,
    );
    await get(
      `INSERT INTO role_permissions (role, permission, granted) VALUES ('cashier', 'apply_discounts', false)
       ON CONFLICT (tenant_id, role, permission) DO UPDATE SET granted = false RETURNING id`,
    );
  });

  // The other tenant needs its own manager: an approval always references an
  // employee of its own tenant, and borrowing this tenant's id would leave a
  // cross-tenant FK that tenant-scoped cleanup can never resolve.
  await asTenant(otherTenant.id, async () => {
    const mgr = await get(
      `INSERT INTO employees (name, pin, role) VALUES ('Other Manager', '3333', 'manager') RETURNING id`,
    );
    otherManagerId = Number(mgr.id);
  });

  MANAGER.id = managerId;
  CASHIER.id = cashierId;
}, 90_000);

afterAll(async () => {
  await dropTestTenant(tenant.id);
  await dropTestTenant(otherTenant.id);
  await closePools();
}, 30_000);

describe('actor holds apply_discounts', () => {
  it('self-stamps without any approval record', async () => {
    const authorizedBy = await asTenant(tenant.id, () =>
      authorizeDiscount({
        actorEmployee: MANAGER,
        discount: { type: 'percent', value: 10, reason: 'regular' },
        scope: 'cart',
      }),
    );
    expect(authorizedBy).toBe(managerId);

    const [{ n }] = await adminSql`
      SELECT COUNT(*)::int AS n FROM discount_approvals
      WHERE tenant_id = ${tenant.id} AND consumed_at IS NOT NULL
    `;
    expect(n).toBe(0);
  });
});

describe('actor lacks apply_discounts', () => {
  it('rejects with approval_required when no approval is supplied', async () => {
    await expect(
      asTenant(tenant.id, () =>
        authorizeDiscount({
          actorEmployee: CASHIER,
          discount: { type: 'percent', value: 10, reason: 'nope' },
          scope: 'cart',
        }),
      ),
    ).rejects.toMatchObject({ status: 403, code: 'approval_required' });
  });

  // The exploit this whole change exists to kill: before, naming any manager's
  // employee id was sufficient authorization.
  it('rejects the legacy authorized_by_employee_id shape', async () => {
    await expect(
      asTenant(tenant.id, () =>
        authorizeDiscount({
          actorEmployee: CASHIER,
          discount: {
            type: 'comp',
            value: 100,
            reason: 'free lunch',
            authorized_by_employee_id: managerId,
          },
          scope: 'cart',
        }),
      ),
    ).rejects.toMatchObject({ status: 403, code: 'approval_required' });
  });

  it('accepts a bound approval, returns the approver, and consumes it', async () => {
    const approvalId = await mintApproval({ scope: 'cart', type: 'percent', value: 15 });

    const authorizedBy = await asTenant(tenant.id, () =>
      authorizeDiscount({
        actorEmployee: CASHIER,
        discount: { type: 'percent', value: 15, reason: 'birthday', approval_id: approvalId },
        scope: 'cart',
        orderId: 4242,
      }),
    );
    expect(authorizedBy).toBe(managerId);

    const [row] = await adminSql`
      SELECT consumed_at, consumed_order_id FROM discount_approvals WHERE id = ${approvalId}::uuid
    `;
    expect(row.consumed_at).not.toBeNull();
    expect(Number(row.consumed_order_id)).toBe(4242);
  });

  it('treats a comp approval as value 100 regardless of what the client sends', async () => {
    const approvalId = await mintApproval({ scope: 'line', type: 'comp', value: 100 });

    const authorizedBy = await asTenant(tenant.id, () =>
      authorizeDiscount({
        actorEmployee: CASHIER,
        // Clients have sent both 0 and 100 for a comp; both must bind.
        discount: { type: 'comp', value: 0, reason: 'remake', approval_id: approvalId },
        scope: 'line',
      }),
    );
    expect(authorizedBy).toBe(managerId);
  });
});

describe('binding', () => {
  it('will not let a percent approval be spent as a comp', async () => {
    const approvalId = await mintApproval({ scope: 'cart', type: 'percent', value: 10 });

    await expect(
      asTenant(tenant.id, () =>
        authorizeDiscount({
          actorEmployee: CASHIER,
          discount: { type: 'comp', value: 100, reason: 'upgrade attempt', approval_id: approvalId },
          scope: 'cart',
        }),
      ),
    ).rejects.toMatchObject({ status: 403, approvalRejected: 'binding_mismatch' });

    const [row] = await adminSql`SELECT consumed_at FROM discount_approvals WHERE id = ${approvalId}::uuid`;
    expect(row.consumed_at).toBeNull();
  });

  it('will not let the value drift', async () => {
    const approvalId = await mintApproval({ scope: 'cart', type: 'percent', value: 10 });

    await expect(
      asTenant(tenant.id, () =>
        authorizeDiscount({
          actorEmployee: CASHIER,
          discount: { type: 'percent', value: 50, reason: 'drift', approval_id: approvalId },
          scope: 'cart',
        }),
      ),
    ).rejects.toMatchObject({ status: 403, approvalRejected: 'binding_mismatch' });
  });

  it('will not let a line approval pay for a cart discount', async () => {
    const approvalId = await mintApproval({ scope: 'line', type: 'amount', value: 20 });

    await expect(
      asTenant(tenant.id, () =>
        authorizeDiscount({
          actorEmployee: CASHIER,
          discount: { type: 'amount', value: 20, reason: 'scope swap', approval_id: approvalId },
          scope: 'cart',
        }),
      ),
    ).rejects.toMatchObject({ status: 403, approvalRejected: 'binding_mismatch' });
  });
});

describe('single use', () => {
  // This is what stops one approval from covering N discounted lines — the old
  // code authorized once and stamped that approver onto every discounted line.
  it('cannot be spent twice', async () => {
    const approvalId = await mintApproval({ scope: 'line', type: 'amount', value: 25 });
    const discount = { type: 'amount' as const, value: 25, reason: 'once', approval_id: approvalId };

    const first = await asTenant(tenant.id, () =>
      authorizeDiscount({ actorEmployee: CASHIER, discount, scope: 'line' }),
    );
    expect(first).toBe(managerId);

    await expect(
      asTenant(tenant.id, () =>
        authorizeDiscount({ actorEmployee: CASHIER, discount, scope: 'line' }),
      ),
    ).rejects.toMatchObject({ status: 403, approvalRejected: 'already_used' });
  });
});

describe('expiry and isolation', () => {
  it('rejects an expired approval', async () => {
    const approvalId = await mintApproval({
      scope: 'cart',
      type: 'percent',
      value: 5,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    await expect(
      asTenant(tenant.id, () =>
        authorizeDiscount({
          actorEmployee: CASHIER,
          discount: { type: 'percent', value: 5, reason: 'stale', approval_id: approvalId },
          scope: 'cart',
        }),
      ),
    ).rejects.toMatchObject({ status: 403, approvalRejected: 'expired' });
  });

  it('cannot spend another tenant\'s approval', async () => {
    const approvalId = await mintApproval({
      scope: 'cart',
      type: 'percent',
      value: 10,
      tenantId: otherTenant.id,
      approverId: otherManagerId,
    });

    await expect(
      asTenant(tenant.id, () =>
        authorizeDiscount({
          actorEmployee: CASHIER,
          discount: { type: 'percent', value: 10, reason: 'cross tenant', approval_id: approvalId },
          scope: 'cart',
        }),
      ),
    ).rejects.toMatchObject({ status: 403, approvalRejected: 'not_found' });

    // and it is still unspent for its real owner
    const [row] = await adminSql`SELECT consumed_at FROM discount_approvals WHERE id = ${approvalId}::uuid`;
    expect(row.consumed_at).toBeNull();
  });

  it('rejects a malformed approval id without throwing a raw pg error', async () => {
    await expect(
      asTenant(tenant.id, () =>
        authorizeDiscount({
          actorEmployee: CASHIER,
          discount: { type: 'percent', value: 10, reason: 'junk', approval_id: 'not-a-uuid' },
          scope: 'cart',
        }),
      ),
    ).rejects.toMatchObject({ status: 403, code: 'approval_required' });
  });
});
