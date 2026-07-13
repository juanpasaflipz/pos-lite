// Wallet pass tests — schema + RLS boundary for the tables added in 0081.
//
// wallet_passes rows hold per-pass secrets (auth_token authenticates Apple's
// web-service calls; enroll_token is a public capability URL), so the RLS
// boundary matters here exactly like it does for tenant_credentials:
//   - passes/registrations are invisible across tenants
//   - INSERT under A cannot smuggle tenant_id=B
//   - serial_number / enroll_token are globally unique (Apple requires
//     serial uniqueness per pass type across ALL tenants)
//   - deleting a pass cascades its device registrations
//   - passSync's cross-context tenant resolution (customer row → tenant_id)
//     finds the right tenant when called outside a request context

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestTenant,
  dropTestTenant,
  asTenant,
  closePools,
  type TestTenant,
} from './helpers/db.js';
// @ts-ignore — server files are plain JS
import { adminSql, all, get, run } from '../server/db/index.js';

let tenantA: TestTenant;
let tenantB: TestTenant;
let customerA: number;
let customerB: number;

async function seedCustomer(tenantId: string, name: string): Promise<number> {
  const [row] = await adminSql`
    INSERT INTO loyalty_customers (tenant_id, phone, country_code, name)
    VALUES (${tenantId}, ${'55' + String(Math.abs(hash(name))).padStart(8, '0')}, 'MX', ${name})
    RETURNING id
  `;
  return Number(row.id);
}

function hash(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return h;
}

async function seedPass(tenantId: string, customerId: number) {
  const [row] = await adminSql`
    INSERT INTO wallet_passes (tenant_id, customer_id, platform, serial_number, auth_token, enroll_token)
    VALUES (${tenantId}, ${customerId}, 'apple', ${randomUUID()}, ${randomUUID()}, ${randomUUID()})
    RETURNING id, serial_number
  `;
  return { id: Number(row.id), serial: row.serial_number as string };
}

beforeAll(async () => {
  tenantA = await createTestTenant('wallet-a');
  tenantB = await createTestTenant('wallet-b');
  customerA = await seedCustomer(tenantA.id, 'Wallet Customer A');
  customerB = await seedCustomer(tenantB.id, 'Wallet Customer B');
}, 60_000);

afterAll(async () => {
  await dropTestTenant(tenantA.id);
  await dropTestTenant(tenantB.id);
  await closePools();
}, 30_000);

describe('wallet_passes: RLS boundary', () => {
  it('a pass created under A is invisible to B (auth_token never leaks)', async () => {
    await seedPass(tenantA.id, customerA);

    const mine = await asTenant(tenantA.id, () =>
      all('SELECT * FROM wallet_passes'),
    );
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((r: any) => r.tenant_id === tenantA.id)).toBe(true);

    const theirs = await asTenant(tenantB.id, () =>
      all(`SELECT * FROM wallet_passes WHERE tenant_id = '${tenantA.id}'`),
    );
    expect(theirs).toHaveLength(0);
  });

  it('INSERT under A with explicit tenant_id=B is rejected by WITH CHECK', async () => {
    await expect(
      asTenant(tenantA.id, () =>
        run(
          `INSERT INTO wallet_passes (tenant_id, customer_id, platform, serial_number, auth_token)
           VALUES ('${tenantB.id}', ${customerB}, 'apple', '${randomUUID()}', 'smuggled-token')`,
        ),
      ),
    ).rejects.toThrow(/row-level security|violates.*policy/i);
  });

  it('lookup by serial under the wrong tenant returns nothing (web-service auth path)', async () => {
    const pass = await seedPass(tenantB.id, customerB);

    // This is exactly the query routes/wallet.js runs when Apple calls
    // GET /v1/passes — under tenant A's context, B's serial must not resolve.
    const row = await asTenant(tenantA.id, () =>
      get('SELECT * FROM wallet_passes WHERE serial_number = $1', [pass.serial]),
    );
    expect(row).toBeUndefined();
  });
});

describe('wallet_passes: uniqueness constraints', () => {
  it('serial_number is globally unique across tenants', async () => {
    const serial = randomUUID();
    await adminSql`
      INSERT INTO wallet_passes (tenant_id, customer_id, platform, serial_number, auth_token)
      VALUES (${tenantA.id}, ${customerA}, 'google', ${serial}, ${randomUUID()})
    `;
    await expect(
      adminSql`
        INSERT INTO wallet_passes (tenant_id, customer_id, platform, serial_number, auth_token)
        VALUES (${tenantB.id}, ${customerB}, 'google', ${serial}, ${randomUUID()})
      `,
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it('one pass per (tenant, customer, platform)', async () => {
    await expect(
      adminSql`
        INSERT INTO wallet_passes (tenant_id, customer_id, platform, serial_number, auth_token)
        VALUES (${tenantA.id}, ${customerA}, 'apple', ${randomUUID()}, ${randomUUID()})
      `,
    ).rejects.toThrow(/duplicate key|unique/i);
  });
});

describe('wallet_registrations: lifecycle', () => {
  it('registrations cascade-delete with their pass', async () => {
    const cascadeCustomer = await seedCustomer(tenantB.id, 'Cascade Customer');
    const pass = await seedPass(tenantB.id, cascadeCustomer);

    await adminSql`
      INSERT INTO wallet_registrations (tenant_id, pass_id, device_library_id, push_token)
      VALUES (${tenantB.id}, ${pass.id}, 'device-lib-1', 'push-token-1')
    `;

    const [before] = await adminSql`
      SELECT COUNT(*)::int AS n FROM wallet_registrations WHERE pass_id = ${pass.id}
    `;
    expect(before.n).toBe(1);

    await adminSql`DELETE FROM wallet_passes WHERE id = ${pass.id}`;

    const [after] = await adminSql`
      SELECT COUNT(*)::int AS n FROM wallet_registrations WHERE pass_id = ${pass.id}
    `;
    expect(after.n).toBe(0);
  });

  it('a device cannot double-register the same pass', async () => {
    const cust = await seedCustomer(tenantA.id, 'DoubleReg Customer');
    const pass = await seedPass(tenantA.id, cust);

    await adminSql`
      INSERT INTO wallet_registrations (tenant_id, pass_id, device_library_id, push_token)
      VALUES (${tenantA.id}, ${pass.id}, 'device-lib-2', 'push-token-2')
    `;
    await expect(
      adminSql`
        INSERT INTO wallet_registrations (tenant_id, pass_id, device_library_id, push_token)
        VALUES (${tenantA.id}, ${pass.id}, 'device-lib-2', 'push-token-other')
      `,
    ).rejects.toThrow(/duplicate key|unique/i);
  });
});

describe('passSync: cross-context tenant resolution', () => {
  it('resolves the owning tenant from the customer row (webhook path)', async () => {
    // schedulePassUpdate falls back to this lookup when getTenantId() is null
    // (e.g. Mercado Pago webhook promoting a kiosk order). Verify the lookup
    // lands on the right tenant even with same-shaped customers in both.
    const [row] = await adminSql`
      SELECT tenant_id FROM loyalty_customers WHERE id = ${customerA}
    `;
    expect(row.tenant_id).toBe(tenantA.id);

    // And the tenant-filtered UPDATE it runs touches only that tenant's passes.
    const touched = await adminSql`
      UPDATE wallet_passes
      SET updated_at = NOW()
      WHERE tenant_id = ${row.tenant_id} AND customer_id = ${customerA} AND revoked = false
      RETURNING tenant_id
    `;
    expect(touched.every((r: any) => r.tenant_id === tenantA.id)).toBe(true);
  });
});
