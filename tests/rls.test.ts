// RLS boundary tests — the load-bearing security invariant.
//
// The tenant middleware sets `app.tenant_id` via set_config inside a BEGIN/COMMIT
// block on the tenant pool (`app_user`, FORCE ROW LEVEL SECURITY). Every
// `tenant_id`-bearing table has a `tenant_isolation` policy of shape
// `tenant_id = current_setting('app.tenant_id', true)` for USING + WITH CHECK.
//
// These tests exercise that policy from the same code path as `/api/*` requests
// (withTenant → asTenant here) and verify:
//   - SELECT under tenant A returns only A's rows
//   - INSERT under A cannot smuggle tenant_id=B (WITH CHECK blocks it)
//   - UPDATE / DELETE against B's rows return 0 affected under A
//   - Same guarantees hold across three unrelated tables (structural, not incidental)

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestTenant,
  dropTestTenant,
  asTenant,
  closePools,
  type TestTenant,
} from './helpers/db.js';
// @ts-ignore — server files are plain JS
import { adminSql, get, all, run } from '../server/db/index.js';

let tenantA: TestTenant;
let tenantB: TestTenant;

beforeAll(async () => {
  tenantA = await createTestTenant('rls-a');
  tenantB = await createTestTenant('rls-b');

  // Seed one row of each protected table into each tenant, via adminSql
  // (which bypasses RLS) so we can stage the fixtures.
  for (const t of [tenantA, tenantB]) {
    await adminSql`
      INSERT INTO menu_categories (tenant_id, name, sort_order)
      VALUES (${t.id}, ${'Category ' + t.id}, 1)
    `;
    await adminSql`
      INSERT INTO loyalty_customers (tenant_id, phone, country_code, name)
      VALUES (${t.id}, ${'55' + t.id.slice(-8)}, 'MX', ${'Customer ' + t.id})
    `;
    await adminSql`
      INSERT INTO tenant_credentials (tenant_id, service, key, value)
      VALUES (${t.id}, 'test', 'api_key', ${'secret-of-' + t.id})
    `;
  }
}, 60_000);

afterAll(async () => {
  await dropTestTenant(tenantA.id);
  await dropTestTenant(tenantB.id);
  await closePools();
}, 30_000);

describe('RLS: SELECT is scoped to the current tenant', () => {
  it('menu_categories: tenant A sees A only, never B', async () => {
    const rows = await asTenant(tenantA.id, () =>
      all('SELECT tenant_id, name FROM menu_categories ORDER BY id'),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r: any) => r.tenant_id === tenantA.id)).toBe(true);
    expect(rows.some((r: any) => r.tenant_id === tenantB.id)).toBe(false);
  });

  it('loyalty_customers: tenant B sees B only, never A', async () => {
    const rows = await asTenant(tenantB.id, () =>
      all('SELECT tenant_id, name FROM loyalty_customers'),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r: any) => r.tenant_id === tenantB.id)).toBe(true);
  });

  it('tenant_credentials: A cannot read B\'s secrets', async () => {
    const rows = await asTenant(tenantA.id, () =>
      all(`SELECT tenant_id, service, key, value FROM tenant_credentials WHERE tenant_id = '${tenantB.id}'`),
    );
    // Even with an explicit WHERE, RLS filters first — B's rows are invisible to A.
    expect(rows).toHaveLength(0);
  });
});

describe('RLS: INSERT cannot target another tenant', () => {
  it('INSERT under A with explicit tenant_id=B is rejected by WITH CHECK', async () => {
    await expect(
      asTenant(tenantA.id, () =>
        run(
          `INSERT INTO menu_categories (tenant_id, name, sort_order) VALUES ('${tenantB.id}', 'Smuggled category', 99)`,
        ),
      ),
    ).rejects.toThrow(/row-level security|violates.*policy/i);
  });

  it('INSERT under A without tenant_id defaults to A (via app.tenant_id default)', async () => {
    await asTenant(tenantA.id, () =>
      run(
        `INSERT INTO menu_categories (name, sort_order) VALUES ('Defaulted', 50)`,
      ),
    );

    const rows = await asTenant(tenantA.id, () =>
      all(`SELECT tenant_id, name FROM menu_categories WHERE name = 'Defaulted'`),
    );
    expect(rows).toHaveLength(1);
    expect((rows[0] as any).tenant_id).toBe(tenantA.id);
  });
});

describe('RLS: UPDATE / DELETE cannot reach across the boundary', () => {
  it('UPDATE B\'s row under A affects 0 rows', async () => {
    const result = await asTenant(tenantA.id, () =>
      run(
        `UPDATE loyalty_customers SET name = 'hijacked' WHERE tenant_id = '${tenantB.id}'`,
      ),
    );
    expect(result.changes ?? 0).toBe(0);

    // Verify B's row is untouched by reading via adminSql (bypasses RLS).
    const [row] = await adminSql`
      SELECT name FROM loyalty_customers WHERE tenant_id = ${tenantB.id}
    `;
    expect(row.name).not.toBe('hijacked');
  });

  it('DELETE B\'s tenant_credentials under A affects 0 rows', async () => {
    const result = await asTenant(tenantA.id, () =>
      run(`DELETE FROM tenant_credentials WHERE tenant_id = '${tenantB.id}'`),
    );
    expect(result.changes ?? 0).toBe(0);

    const [row] = await adminSql`
      SELECT value FROM tenant_credentials WHERE tenant_id = ${tenantB.id} AND key = 'api_key'
    `;
    expect(row.value).toBe('secret-of-' + tenantB.id);
  });
});
