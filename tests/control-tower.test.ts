// Control-tower tests — fleet overview, cross-tenant incident feed, and the
// sanitizeTenant chokepoint that keeps credential-bearing tenant columns out
// of admin API responses.
//
// Everything runs against real Postgres (Neon test branch) like the rest of
// the suite: the fleet query is one set-based statement whose aggregates are
// exactly what the super-admin dashboard renders, so these assertions are the
// contract for that screen.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestTenant,
  dropTestTenant,
  closePools,
  type TestTenant,
} from './helpers/db.js';
// @ts-ignore — server files are plain JS
import { adminSql } from '../server/db/index.js';
// @ts-ignore
import { initMigrations, runMigrations } from '../server/db/migrate.js';
// @ts-ignore
import { getFleetOverview, listAllIncidents, sanitizeTenant } from '../server/helpers/controlTower.js';

let tenantA: TestTenant;
let tenantB: TestTenant;
let employeeIdA: number;

async function seedEmployee(tenantId: string, name = 'CT Test'): Promise<number> {
  const [row] = await adminSql`
    INSERT INTO employees (tenant_id, name, pin, role)
    VALUES (${tenantId}, ${name}, '0000', 'cashier')
    RETURNING id
  `;
  return row.id;
}

async function seedOrder(tenantId: string, employeeId: number, opts: { status?: string; ageHours?: number; total?: number } = {}): Promise<number> {
  const { status = 'completed', ageHours = 1, total = 100 } = opts;
  const [row] = await adminSql`
    INSERT INTO orders (tenant_id, order_number, employee_id, status, subtotal, tax, total, payment_status, created_at)
    VALUES (${tenantId}, ${Math.floor(Math.random() * 1e9)}, ${employeeId}, ${status},
            ${total}, 0, ${total}, 'paid', NOW() - ${ageHours} * INTERVAL '1 hour')
    RETURNING id
  `;
  return row.id;
}

beforeAll(async () => {
  await initMigrations();
  await runMigrations('test');

  tenantA = await createTestTenant('ctower-a');
  tenantB = await createTestTenant('ctower-b');
  employeeIdA = await seedEmployee(tenantA.id);

  // Activity for A: one recent order (24h window) + one older (7d window only)
  await seedOrder(tenantA.id, employeeIdA, { ageHours: 2, total: 150 });
  await seedOrder(tenantA.id, employeeIdA, { ageHours: 26, total: 200 });
  // A draft must NOT count toward the pulse
  await seedOrder(tenantA.id, employeeIdA, { status: 'draft_kiosk', ageHours: 1, total: 50 });

  // Trial for A: 10 days remaining
  await adminSql`
    UPDATE tenants SET trial_ends_at = NOW() + INTERVAL '10 days' WHERE id = ${tenantA.id}
  `;

  // Open incident for A, resolved incident for B
  await adminSql`
    INSERT INTO sentinel_incidents (tenant_id, sensor, dedup_key, severity, status, evidence)
    VALUES (${tenantA.id}, 'stuck_terminal_payment', 'order:ct-1', 'high', 'open', '{"order_id": 1}'::jsonb)
  `;
  await adminSql`
    INSERT INTO sentinel_incidents (tenant_id, sensor, dedup_key, severity, status, evidence, resolved_at)
    VALUES (${tenantB.id}, 'stale_kiosk_draft', 'order:ct-2', 'low', 'resolved', '{}'::jsonb, NOW())
  `;
});

afterAll(async () => {
  await dropTestTenant(tenantA.id);
  await dropTestTenant(tenantB.id);
  await closePools();
});

describe('sanitizeTenant', () => {
  it('strips every credential-bearing column and keeps the rest', () => {
    const raw = {
      id: 't1',
      name: 'T1',
      owner_email: 'a@b.c',
      owner_password_hash: 'hash',
      mp_access_token: 'mp-secret',
      mp_refresh_token: 'mp-refresh',
      reset_token: 'rt',
      reset_token_expires: new Date(),
      plan: 'free',
    };
    const safe = sanitizeTenant(raw);
    expect(safe.owner_password_hash).toBeUndefined();
    expect(safe.mp_access_token).toBeUndefined();
    expect(safe.mp_refresh_token).toBeUndefined();
    expect(safe.reset_token).toBeUndefined();
    expect(safe.reset_token_expires).toBeUndefined();
    expect(safe.id).toBe('t1');
    expect(safe.plan).toBe('free');
    // non-mutating
    expect(raw.owner_password_hash).toBe('hash');
  });
});

describe('getFleetOverview', () => {
  it('returns one row per tenant with pulse, onboarding, trial, and incident data', async () => {
    const fleet = await getFleetOverview();
    const a = fleet.find((r: any) => r.id === tenantA.id);
    const b = fleet.find((r: any) => r.id === tenantB.id);
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();

    // Pulse: drafts excluded, 24h vs 7d windows split correctly
    expect(a.pulse.orders_24h).toBe(1);
    expect(a.pulse.orders_7d).toBe(2);
    expect(Number(a.pulse.revenue_30d)).toBe(350);
    expect(a.pulse.last_order_at).toBeTruthy();

    // Trial-aware effective plan
    expect(a.plan).toBe('free');
    expect(a.effective_plan).toBe('pro');
    expect(a.trial_active).toBe(true);
    expect(a.trial_days_left).toBeGreaterThanOrEqual(9);
    expect(a.trial_days_left).toBeLessThanOrEqual(10);
    expect(b.trial_active).toBe(false);
    expect(b.effective_plan).toBe('free');

    // Onboarding: A has an employee + a real order, no menu/printer/payment
    expect(a.onboarding.has_first_order).toBe(true);
    expect(a.onboarding.has_menu).toBe(false);
    expect(a.onboarding.has_payment).toBe(false);
    expect(b.onboarding.has_first_order).toBe(false);

    // Incidents: only ACTIVE statuses count
    expect(a.incidents.open).toBe(1);
    expect(a.incidents.high).toBe(1);
    expect(a.incidents.critical).toBe(0);
    expect(b.incidents.open).toBe(0);
  });

  it('never exposes credential-bearing columns', async () => {
    const fleet = await getFleetOverview();
    for (const row of fleet) {
      expect(row.owner_password_hash).toBeUndefined();
      expect(row.mp_access_token).toBeUndefined();
      expect(row.mp_refresh_token).toBeUndefined();
      expect(row.reset_token).toBeUndefined();
    }
  });
});

describe('listAllIncidents', () => {
  it('lists incidents across tenants with tenant names, active first', async () => {
    const incidents = await listAllIncidents({ limit: 300 });
    const aInc = incidents.find((i: any) => i.tenant_id === tenantA.id);
    const bInc = incidents.find((i: any) => i.tenant_id === tenantB.id);
    expect(aInc).toBeTruthy();
    expect(bInc).toBeTruthy();
    expect(aInc.tenant_name).toContain('Test tenant');
    // active (open) incidents sort before resolved ones
    expect(incidents.indexOf(aInc)).toBeLessThan(incidents.indexOf(bInc));
  });

  it('filters by status and tenant', async () => {
    const open = await listAllIncidents({ status: 'open', tenantId: tenantA.id });
    expect(open.length).toBe(1);
    expect(open[0].sensor).toBe('stuck_terminal_payment');

    const resolvedForA = await listAllIncidents({ status: 'resolved', tenantId: tenantA.id });
    expect(resolvedForA.length).toBe(0);
  });

  it('rejects an invalid status filter with a 400-style error', async () => {
    await expect(listAllIncidents({ status: 'bogus' })).rejects.toMatchObject({ status: 400 });
  });
});
