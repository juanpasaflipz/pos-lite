// Sentinel tests — detection, dedup, self-heal, playbook guards, budget, RLS.
//
// Everything here runs LLM-free: sweepOnce({ triage: false }) exercises the
// deterministic spine (sensors → incidents → self-heal), and playbooks are
// invoked directly to prove their precondition guards block mutation. The
// guards are what make "auto-safe" true, so they get the densest coverage
// (docs/ai-sentinel-design.md §10).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestTenant,
  dropTestTenant,
  asTenant,
  closePools,
  type TestTenant,
} from './helpers/db.js';
// @ts-ignore — server files are plain JS
import { adminSql, all } from '../server/db/index.js';
// @ts-ignore
import { initMigrations, runMigrations } from '../server/db/migrate.js';
// @ts-ignore
import { sweepOnce } from '../server/sentinel/sweep.js';
// @ts-ignore
import { PLAYBOOKS } from '../server/sentinel/playbooks.js';
// @ts-ignore
import { consumeTriageBudget, _resetTriageBudget } from '../server/sentinel/triage.js';

let tenantA: TestTenant;
let tenantB: TestTenant;
let employeeIdA: number;

async function seedEmployee(tenantId: string): Promise<number> {
  const [row] = await adminSql`
    INSERT INTO employees (tenant_id, name, pin, role)
    VALUES (${tenantId}, 'Sentinel Test', '0000', 'cashier')
    RETURNING id
  `;
  return row.id;
}

interface SeedOrderOpts {
  status?: string;
  paymentStatus?: string;
  mpOrderId?: string | null;
  ageMinutes?: number;
  total?: number;
}

async function seedOrder(tenantId: string, employeeId: number, opts: SeedOrderOpts = {}): Promise<number> {
  const {
    status = 'active',
    paymentStatus = 'unpaid',
    mpOrderId = null,
    ageMinutes = 0,
    total = 100,
  } = opts;
  const [row] = await adminSql`
    INSERT INTO orders
      (tenant_id, order_number, employee_id, status, payment_status, mp_order_id,
       subtotal, tax, total, created_at)
    VALUES
      (${tenantId}, ${Math.floor(Math.random() * 1e9)}, ${employeeId}, ${status},
       ${paymentStatus}, ${mpOrderId}, ${total}, 0, ${total},
       NOW() - ${ageMinutes} * INTERVAL '1 minute')
    RETURNING id
  `;
  return row.id;
}

async function incidentsFor(tenantId: string, sensor?: string) {
  return sensor
    ? adminSql`SELECT * FROM sentinel_incidents WHERE tenant_id = ${tenantId} AND sensor = ${sensor} ORDER BY id`
    : adminSql`SELECT * FROM sentinel_incidents WHERE tenant_id = ${tenantId} ORDER BY id`;
}

beforeAll(async () => {
  await initMigrations();
  await runMigrations('sentinel-tests'); // idempotent; guarantees 0079 applied
  tenantA = await createTestTenant('sentinel-a');
  tenantB = await createTestTenant('sentinel-b');
  employeeIdA = await seedEmployee(tenantA.id);
});

afterAll(async () => {
  await dropTestTenant(tenantA.id);
  await dropTestTenant(tenantB.id);
  await closePools();
});

describe('S1: stuck_terminal_payment detection + dedup + self-heal', () => {
  let orderId: number;

  it('detects an order stuck in pending_terminal past the threshold', async () => {
    orderId = await seedOrder(tenantA.id, employeeIdA, {
      paymentStatus: 'pending_terminal',
      mpOrderId: 'TEST-MP-INTENT-1',
      ageMinutes: 30,
    });

    await sweepOnce({ triage: false });

    const incidents = await incidentsFor(tenantA.id, 'stuck_terminal_payment');
    expect(incidents.length).toBe(1);
    expect(incidents[0].severity).toBe('high');
    expect(incidents[0].status).toBe('open');
    expect(incidents[0].dedup_key).toBe(`order:${orderId}`);
    expect(incidents[0].evidence.order_id).toBe(orderId);
    expect(incidents[0].evidence.processor).toBe('mercadopago');
  });

  it('dedups on re-detection: same incident, bumped last_seen_at, no duplicate', async () => {
    const [before] = await incidentsFor(tenantA.id, 'stuck_terminal_payment');
    await new Promise((r) => setTimeout(r, 50));
    await sweepOnce({ triage: false });

    const incidents = await incidentsFor(tenantA.id, 'stuck_terminal_payment');
    expect(incidents.length).toBe(1);
    expect(incidents[0].id).toBe(before.id);
    expect(new Date(incidents[0].last_seen_at).getTime()).toBeGreaterThanOrEqual(
      new Date(before.last_seen_at).getTime()
    );
  });

  it('fresh orders under the threshold do NOT fire', async () => {
    await seedOrder(tenantA.id, employeeIdA, {
      paymentStatus: 'pending_terminal',
      mpOrderId: 'TEST-MP-INTENT-FRESH',
      ageMinutes: 1,
    });
    await sweepOnce({ triage: false });
    const incidents = await incidentsFor(tenantA.id, 'stuck_terminal_payment');
    expect(incidents.length).toBe(1); // still only the aged one
  });

  it('self-heals when the condition clears: resolved + dedup slot freed', async () => {
    await adminSql`
      UPDATE orders SET payment_status = 'paid', paid_at = NOW()
      WHERE id = ${orderId} AND tenant_id = ${tenantA.id}
    `;
    await sweepOnce({ triage: false });

    const incidents = await incidentsFor(tenantA.id, 'stuck_terminal_payment');
    expect(incidents.length).toBe(1);
    expect(incidents[0].status).toBe('resolved');
    expect(incidents[0].resolved_at).not.toBeNull();
    expect(incidents[0].dedup_key).toBe(`order:${orderId}:r${incidents[0].id}`);
    const actions = incidents[0].actions as Array<{ type: string }>;
    expect(actions.some((a) => a.type === 'self_healed')).toBe(true);
  });
});

describe('S2: stale_kiosk_draft severity split (decision #2: detect, never void)', () => {
  it('cash draft → low severity; card-attempt draft → high severity', async () => {
    const cashDraft = await seedOrder(tenantA.id, employeeIdA, {
      status: 'draft_kiosk',
      ageMinutes: 120,
    });
    const cardDraft = await seedOrder(tenantA.id, employeeIdA, {
      status: 'draft_kiosk',
      mpOrderId: 'TEST-MP-DRAFT-1',
      ageMinutes: 120,
    });

    await sweepOnce({ triage: false });

    const incidents = await incidentsFor(tenantA.id, 'stale_kiosk_draft');
    const byOrder = new Map(incidents.map((i: any) => [i.evidence.order_id, i]));
    expect(byOrder.get(cashDraft)?.severity).toBe('low');
    expect(byOrder.get(cardDraft)?.severity).toBe('high');

    // The invariant that matters: detection did not mutate the drafts.
    const drafts = await adminSql`
      SELECT id, status FROM orders
      WHERE tenant_id = ${tenantA.id} AND id IN (${cashDraft}, ${cardDraft})
    `;
    expect(drafts.every((d: any) => d.status === 'draft_kiosk')).toBe(true);
  });
});

describe('P1 guards: unstick_terminal_payment refuses unsafe execution', () => {
  it('aborts on an order that is no longer pending_terminal (live, not shadow)', async () => {
    const paidOrder = await seedOrder(tenantA.id, employeeIdA, {
      paymentStatus: 'paid',
      mpOrderId: 'TEST-MP-PAID-1',
      ageMinutes: 30,
    });
    const result = await PLAYBOOKS.unstick_terminal_payment.run(
      { id: 999999, tenant_id: tenantA.id, subject_id: String(paidOrder) },
      { shadow: false }
    );
    expect(result.aborted).toBe('no_longer_pending_terminal');

    const [order] = await adminSql`
      SELECT payment_status, mp_order_id FROM orders WHERE id = ${paidOrder}
    `;
    expect(order.payment_status).toBe('paid');
    expect(order.mp_order_id).toBe('TEST-MP-PAID-1'); // untouched
  });

  it('aborts without MP credentials — never mutates before processor confirmation', async () => {
    const stuck = await seedOrder(tenantA.id, employeeIdA, {
      paymentStatus: 'pending_terminal',
      mpOrderId: 'TEST-MP-INTENT-2',
      ageMinutes: 30,
    });
    const result = await PLAYBOOKS.unstick_terminal_payment.run(
      { id: 999999, tenant_id: tenantA.id, subject_id: String(stuck) },
      { shadow: false }
    );
    expect(result.aborted).toBe('no_mp_credentials'); // test tenants have no MP token

    const [order] = await adminSql`
      SELECT payment_status, mp_order_id FROM orders WHERE id = ${stuck}
    `;
    expect(order.payment_status).toBe('pending_terminal'); // untouched
    expect(order.mp_order_id).toBe('TEST-MP-INTENT-2');
  });

  it('aborts on a missing order', async () => {
    const result = await PLAYBOOKS.unstick_terminal_payment.run(
      { id: 999999, tenant_id: tenantA.id, subject_id: '99999999' },
      { shadow: false }
    );
    expect(result.aborted).toBe('order_not_found');
  });
});

describe('P5 guards: retry_courier_dispatch', () => {
  it('aborts when the order is not paid', async () => {
    const unpaid = await seedOrder(tenantA.id, employeeIdA, {
      paymentStatus: 'unpaid',
      ageMinutes: 30,
    });
    const [platform] = await adminSql`
      INSERT INTO delivery_platforms (tenant_id, name, display_name)
      VALUES (${tenantA.id}, 'uber-direct-test', 'Uber Direct Test')
      RETURNING id
    `;
    await adminSql`
      INSERT INTO delivery_orders (tenant_id, order_id, platform_id, platform_status, pending_dispatch)
      VALUES (${tenantA.id}, ${unpaid}, ${platform.id}, 'pending_payment', '{"test": true}'::jsonb)
    `;

    const result = await PLAYBOOKS.retry_courier_dispatch.run(
      { id: 999999, tenant_id: tenantA.id, evidence: { order_id: unpaid } },
      { shadow: false }
    );
    expect(result.aborted).toBe('order_not_paid');
  });

  it('aborts when evidence is malformed', async () => {
    const result = await PLAYBOOKS.retry_courier_dispatch.run(
      { id: 999999, tenant_id: tenantA.id, evidence: {} },
      { shadow: false }
    );
    expect(result.aborted).toBe('missing_order_id_in_evidence');
  });
});

describe('triage budget cap', () => {
  it('allows exactly SENTINEL_TRIAGE_DAILY_CAP runs per tenant per day', () => {
    _resetTriageBudget();
    const cap = Number(process.env.SENTINEL_TRIAGE_DAILY_CAP) || 20;
    for (let i = 0; i < cap; i++) {
      expect(consumeTriageBudget('budget-test-tenant')).toBe(true);
    }
    expect(consumeTriageBudget('budget-test-tenant')).toBe(false);
    expect(consumeTriageBudget('budget-test-tenant')).toBe(false);
    // Independent per tenant:
    expect(consumeTriageBudget('other-tenant')).toBe(true);
    _resetTriageBudget();
  });
});

describe('RLS: incidents are tenant-isolated', () => {
  it('tenant B cannot see tenant A incidents; A sees its own', async () => {
    const aRows = await asTenant(tenantA.id, () => all(`SELECT id FROM sentinel_incidents`));
    expect(aRows.length).toBeGreaterThan(0);

    const bRows = await asTenant(tenantB.id, () => all(`SELECT id FROM sentinel_incidents`));
    expect(bRows.length).toBe(0);
  });
});
