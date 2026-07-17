// Corporate (organization) dashboard tests — migration 0085 + routes/org.js.
//
// Invariants guarded here:
//   1. Org aggregates include ONLY tenants whose org_id matches — a paid
//      order in a non-org tenant never leaks into the org's numbers.
//   2. Only payment_status='paid' orders count (drafts/unpaid excluded),
//      mirroring the reports.js revenue convention.
//   3. Per-store rollup returns one row per active org store with correct
//      totals; org timeseries and top-items respect the same scoping.
//   4. The organizations table has no app_user grant — the RLS-scoped tenant
//      pool must not be able to read corporate credentials.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcrypt';
import {
  createTestTenant,
  dropTestTenant,
  asTenant,
  closePools,
  type TestTenant,
} from './helpers/db.js';
// @ts-ignore — server files are plain JS
import { adminSql, get, run } from '../server/db/index.js';
// @ts-ignore
import { orgOverview, orgStores, orgTimeseries, orgTopItems } from '../server/routes/org.js';

let orgId: string;
let storeA: TestTenant;
let storeB: TestTenant;
let outsider: TestTenant;

async function seedPaidOrder(tenantId: string, total: number, itemName: string, daysAgo = 0) {
  await asTenant(tenantId, async () => {
    const emp = await get(
      `SELECT id FROM employees LIMIT 1`,
    ) ?? await get(
      `INSERT INTO employees (name, pin, role) VALUES ('Org Test', '0000', 'cashier') RETURNING id`,
    );
    const order = await get(
      `INSERT INTO orders
         (order_number, employee_id, status, subtotal, tax, total,
          payment_status, payment_method, created_at, paid_at)
       VALUES ($1, $2, 'completed', $3, 0, $3, 'paid', 'cash',
               NOW() - make_interval(days => $4), NOW() - make_interval(days => $4))
       RETURNING id`,
      [Date.now() % 1_000_000, (emp as any).id, total, daysAgo],
    );
    await run(
      `INSERT INTO order_items (order_id, item_name, quantity, unit_price)
       VALUES ($1, $2, 1, $3)`,
      [(order as any).id, itemName, total],
    );
  });
}

async function seedUnpaidOrder(tenantId: string, total: number) {
  await asTenant(tenantId, async () => {
    const emp = await get(`SELECT id FROM employees LIMIT 1`);
    await run(
      `INSERT INTO orders
         (order_number, employee_id, status, subtotal, tax, total, payment_status)
       VALUES ($1, $2, 'draft_kiosk', $3, 0, $3, 'unpaid')`,
      [Date.now() % 1_000_000, (emp as any).id, total],
    );
  });
}

beforeAll(async () => {
  orgId = `test_org_${randomUUID().slice(0, 8)}`;
  const hash = await bcrypt.hash('org-test-password', 4);
  await adminSql`
    INSERT INTO organizations (id, name, admin_email, admin_password_hash)
    VALUES (${orgId}, 'Test Org', ${`${orgId}@test.local`}, ${hash})
  `;

  storeA = await createTestTenant('orga');
  storeB = await createTestTenant('orgb');
  outsider = await createTestTenant('orgout');

  await adminSql`UPDATE tenants SET org_id = ${orgId} WHERE id IN (${storeA.id}, ${storeB.id})`;

  // Store A: paid today (100) + paid 10 days ago (50) + unpaid today (999)
  await seedPaidOrder(storeA.id, 100, 'Cono Sencillo');
  await seedPaidOrder(storeA.id, 50, 'Dona Glaseada', 10);
  await seedUnpaidOrder(storeA.id, 999);

  // Store B: paid today (200)
  await seedPaidOrder(storeB.id, 200, 'Cono Sencillo');

  // Outsider (no org): paid today (5000) — must never appear in org numbers
  await seedPaidOrder(outsider.id, 5000, 'Banana Split');
}, 120_000);

afterAll(async () => {
  await dropTestTenant(storeA.id);
  await dropTestTenant(storeB.id);
  await dropTestTenant(outsider.id);
  await adminSql`DELETE FROM organizations WHERE id = ${orgId}`;
  await closePools();
}, 60_000);

describe('org overview', () => {
  it('aggregates paid orders across org stores only', async () => {
    const ov = await orgOverview(orgId);
    expect(ov.store_count).toBe(2);
    expect(ov.today_revenue).toBe(300);      // 100 (A) + 200 (B); excludes unpaid 999 and outsider 5000
    expect(ov.today_orders).toBe(2);
    expect(ov.month_revenue).toBe(350);      // + 50 from 10 days ago
    expect(ov.month_orders).toBe(3);
  });
});

describe('org stores rollup', () => {
  it('returns one row per org store with correct per-store totals', async () => {
    const stores = await orgStores(orgId);
    expect(stores).toHaveLength(2);

    const a = stores.find((s: any) => s.id === storeA.id);
    const b = stores.find((s: any) => s.id === storeB.id);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a.today_revenue).toBe(100);
    expect(a.month_revenue).toBe(150);
    expect(a.month_orders).toBe(2);
    expect(b.today_revenue).toBe(200);
    expect(b.month_orders).toBe(1);

    // Outsider tenant must not appear
    expect(stores.some((s: any) => s.id === outsider.id)).toBe(false);
  });
});

describe('org timeseries + top items', () => {
  it('timeseries sums only org paid orders', async () => {
    const series = await orgTimeseries(orgId, 30);
    const totalRevenue = series.reduce((s: number, p: any) => s + p.revenue, 0);
    expect(totalRevenue).toBe(350);
  });

  it('top items aggregate across the org and exclude outsiders', async () => {
    const items = await orgTopItems(orgId, 10);
    const cono = items.find((i: any) => i.item_name === 'Cono Sencillo');
    expect(cono).toBeDefined();
    expect(cono.units).toBe(2);          // one in each org store
    expect(cono.revenue).toBe(300);
    expect(items.some((i: any) => i.item_name === 'Banana Split')).toBe(false);
  });
});

describe('isolation', () => {
  it('app_user (tenant pool) cannot read the organizations table', async () => {
    await expect(
      asTenant(storeA.id, () => get(`SELECT * FROM organizations LIMIT 1`)),
    ).rejects.toThrow(/permission denied/i);
  });
});
