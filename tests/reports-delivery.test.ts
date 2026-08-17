// Reports → Delivery: per-provider commission reconciliation.
//
// The owner reads this table as gross − commission = net-to-house, so three
// properties are load-bearing:
//
//   1. BASIS. Commission is charged on what the customer paid (tax-inclusive
//      gross), so the effective rate must divide by SUM(total). The old
//      margin_percent divided by SUM(subtotal) and read ~16 IVA points off.
//   2. ESTIMATES. Live-tagged POS re-rings (linkDeliveryPlatform) carry
//      platform_commission = 0 and no manual_batch_id — their commission is
//      estimated from the configured percent and marked as such. Manual/CSV
//      rows always carry manual_batch_id and their zeros are TRUSTED (DiDi
//      rebates commission to ~0 during promos); estimating those would invent
//      a cost that was never charged.
//   3. RECONCILIATION. Channel revenue must sum to the Net Sales KPI, and
//      /api/delivery-intel/analytics (the /admin/delivery screen) must agree
//      with /api/reports/delivery-margins for the same range.

import express from 'express';
import request from 'supertest';
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
import { adminSql } from '../server/db/index.js';
// @ts-ignore
import reportsRouter from '../server/routes/reports.js';
// @ts-ignore
import deliveryIntelRouter from '../server/routes/delivery-intelligence.js';
// @ts-ignore
import { JWT_SECRET } from '../server/lib/constants.js';

const TZ = 'America/Mexico_City'; // UTC-6 year-round since 2022 — no DST edge
const OFFSET = '-06:00';
const DAY_A = '2026-03-10';
const DAY_B = '2026-03-11';
const RANGE = `start_date=${DAY_A}&end_date=${DAY_B}`;

let tenant: TestTenant;
let token = '';
let employeeId = 0;
const platformIds: Record<string, number> = {};

function app(plan = 'pro') {
  const a = express();
  a.use(express.json());
  a.use((req: any, res, next) => {
    req.tenant = { id: tenant.id, plan, timezone: TZ };
    void asTenant(tenant.id, () => new Promise<void>((resolve) => {
      res.on('finish', resolve);
      res.on('close', resolve);
      next();
    }));
  });
  a.use('/api/reports', reportsRouter);
  a.use('/api/delivery-intel', deliveryIntelRouter);
  return a;
}

/**
 * One paid order + its delivery_orders row. Timestamps carry an explicit
 * offset — a bare string in a postgres.js tagged template arrives shifted by
 * the Node process timezone (see reports-hourly.test.ts for the full story).
 */
async function seedDeliveryOrder(opts: {
  orderNumber: number;
  day: string;
  hhmm: string;
  platform: string;
  source: string;
  subtotal: number;
  tax: number;
  commission: number;
  batchId?: number | null;
  paid?: boolean;
}) {
  const { orderNumber, day, hhmm, platform, source, subtotal, tax, commission } = opts;
  const at = `${day}T${hhmm}:00${OFFSET}`;
  const total = subtotal + tax;
  const [order] = await adminSql`
    INSERT INTO orders (
      tenant_id, order_number, employee_id, status, subtotal, tax, tip, total,
      payment_status, payment_method, source, order_fulfillment_type,
      manual_batch_id, created_at, paid_at
    )
    VALUES (
      ${tenant.id}, ${orderNumber}, ${employeeId}, 'completed',
      ${subtotal}, ${tax}, 0, ${total},
      ${opts.paid === false ? 'unpaid' : 'paid'}, ${source}, ${source}, 'delivery',
      ${opts.batchId ?? null}, ${at}::timestamptz, ${at}::timestamptz
    ) RETURNING id
  `;
  await adminSql`
    INSERT INTO delivery_orders (tenant_id, order_id, platform_id, platform_status, platform_commission)
    VALUES (${tenant.id}, ${Number(order.id)}, ${platformIds[platform]}, 'completed', ${commission})
  `;
}

beforeAll(async () => {
  tenant = await createTestTenant('delrep');

  const [emp] = await adminSql`
    INSERT INTO employees (tenant_id, name, pin, role, active)
    VALUES (${tenant.id}, 'Reportes', '7272', 'manager', true) RETURNING id
  `;
  employeeId = Number(emp.id);
  token = jwt.sign(
    { tenantId: tenant.id, employeeId, role: 'manager', type: 'employee' },
    JWT_SECRET,
    { expiresIn: '24h' },
  );

  for (const [name, display, pct] of [
    ['uber_eats', 'Uber Eats', 30],
    ['rappi', 'Rappi', 28.1],
    ['didi_food', 'DiDi Food', 15],
  ] as const) {
    const [row] = await adminSql`
      INSERT INTO delivery_platforms (tenant_id, name, display_name, commission_percent, active)
      VALUES (${tenant.id}, ${name}, ${display}, ${pct}, true) RETURNING id
    `;
    platformIds[name] = Number(row.id);
  }

  const [batch] = await adminSql`
    INSERT INTO manual_sales_batches (
      tenant_id, channel, platform_id, entry_mode, business_date,
      order_count, gross_total, commission_total, net_total, commission_percent
    )
    VALUES (${tenant.id}, 'uber_eats', ${platformIds.uber_eats}, 'import',
      ${DAY_A}, 3, 348, 69.60, 278.40, 30)
    RETURNING id
  `;
  const batchId = Number(batch.id);

  // Uber Eats: two imported orders with real per-statement commission (30% of
  // the tax-inclusive 116). Basis + effective-% fixtures.
  await seedDeliveryOrder({
    orderNumber: 101, day: DAY_A, hhmm: '13:30', platform: 'uber_eats',
    source: 'uber_eats', subtotal: 100, tax: 16, commission: 34.80, batchId,
  });
  await seedDeliveryOrder({
    orderNumber: 102, day: DAY_A, hhmm: '14:10', platform: 'uber_eats',
    source: 'uber_eats', subtotal: 100, tax: 16, commission: 34.80, batchId,
  });

  // Rappi: a live-tagged POS re-ring — no batch, commission 0. Its commission
  // must be ESTIMATED at the configured 28.1%. Stamped 20:15 local (02:15Z the
  // next calendar day) so the daily bucket also pins tenant-time bucketing.
  await seedDeliveryOrder({
    orderNumber: 103, day: DAY_B, hhmm: '20:15', platform: 'rappi',
    source: 'rappi', subtotal: 100, tax: 16, commission: 0,
  });

  // DiDi: an imported order whose commission is a TRUSTED zero (promo rebate)
  // — carries manual_batch_id, must NOT be estimated.
  await seedDeliveryOrder({
    orderNumber: 104, day: DAY_A, hhmm: '12:05', platform: 'didi_food',
    source: 'didi_food', subtotal: 100, tax: 16, commission: 0, batchId,
  });

  // An unpaid delivery order in range — must not appear anywhere.
  await seedDeliveryOrder({
    orderNumber: 106, day: DAY_A, hhmm: '16:00', platform: 'rappi',
    source: 'rappi', subtotal: 999, tax: 0, commission: 0, paid: false,
  });

  // A plain POS order for the channel comparison + Net Sales reconciliation.
  await adminSql`
    INSERT INTO orders (
      tenant_id, order_number, employee_id, status, subtotal, tax, tip, total,
      payment_status, payment_method, created_at, paid_at
    )
    VALUES (
      ${tenant.id}, 105, ${employeeId}, 'completed', 50, 8, 0, 58,
      'paid', 'cash', ${`${DAY_A}T15:00:00${OFFSET}`}::timestamptz,
      ${`${DAY_A}T15:00:00${OFFSET}`}::timestamptz
    )
  `;
});

afterAll(async () => {
  await dropTestTenant(tenant.id);
  await closePools();
});

async function getMargins(query = RANGE) {
  const res = await request(app())
    .get(`/api/reports/delivery-margins?${query}`)
    .set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  return res.body as {
    platforms: Array<any>;
    daily: Array<{ day: string; platform_id: number; display_name: string; commission: number; gross_revenue: number }>;
  };
}

const byName = (platforms: Array<any>, name: string) =>
  platforms.find(p => p.platform_id === platformIds[name]);

describe('delivery margins carry both bases', () => {
  it('revenue is net (SUM subtotal) and gross_revenue is what customers paid', async () => {
    const { platforms } = await getMargins();
    const uber = byName(platforms, 'uber_eats');
    expect(uber.order_count).toBe(2);
    expect(uber.revenue).toBeCloseTo(200, 2);
    expect(uber.gross_revenue).toBeCloseTo(232, 2);
    expect(uber.total_commission).toBeCloseTo(69.60, 2);
  });

  it('excludes unpaid orders', async () => {
    const { platforms } = await getMargins();
    const rappi = byName(platforms, 'rappi');
    expect(rappi.order_count).toBe(1); // the 999-peso unpaid order is invisible
  });

  it('computes the effective commission percent against gross, not net', async () => {
    const { platforms } = await getMargins();
    const uber = byName(platforms, 'uber_eats');
    // 69.60 / 232 = 30% — the platform's actual rate. Against net it would
    // read 34.8% and the owner would think Uber raised its cut.
    expect(uber.effective_commission_percent).toBeCloseTo(30.0, 1);
    expect(uber.net_to_house).toBeCloseTo(232 - 69.60, 2);
  });

  it('keeps the deprecated net-basis fields for back-compat', async () => {
    const { platforms } = await getMargins();
    const uber = byName(platforms, 'uber_eats');
    expect(uber.net_revenue).toBeCloseTo(200 - 69.60, 2);
    expect(uber.margin_percent).toBe(65);
  });
});

describe('the zero-commission gap is estimated honestly', () => {
  it('estimates commission for live-tagged orders with no manual batch', async () => {
    const { platforms } = await getMargins();
    const rappi = byName(platforms, 'rappi');
    expect(rappi.total_commission).toBeCloseTo(0, 2);
    expect(rappi.estimated_order_count).toBe(1);
    expect(rappi.estimated_commission).toBeCloseTo(32.60, 2); // 116 × 28.1%
    // Estimates are INCLUDED in the headline math, marked in the UI.
    expect(rappi.net_to_house).toBeCloseTo(116 - 32.60, 2);
    expect(rappi.effective_commission_percent).toBeCloseTo(28.1, 1);
  });

  it('trusts a zero from a manual/imported batch (DiDi rebate) — no estimate', async () => {
    const { platforms } = await getMargins();
    const didi = byName(platforms, 'didi_food');
    expect(didi.estimated_order_count).toBe(0);
    expect(didi.estimated_commission).toBeCloseTo(0, 2);
    expect(didi.net_to_house).toBeCloseTo(116, 2);
    expect(didi.effective_commission_percent).toBeCloseTo(0, 1);
  });
});

describe('the daily commission trend buckets in tenant time', () => {
  it('files the 20:15 sale under its own local day', async () => {
    const { daily } = await getMargins();
    const rappiDays = daily.filter(d => d.platform_id === platformIds.rappi);
    // 20:15 local is 02:15Z on DAY_B + 1 — a UTC-naive bucket loses it.
    expect(rappiDays.map(d => d.day)).toEqual([DAY_B]);
    expect(rappiDays[0].gross_revenue).toBeCloseTo(116, 2);

    const uberDays = daily.filter(d => d.platform_id === platformIds.uber_eats);
    expect(uberDays.map(d => d.day)).toEqual([DAY_A]);
    expect(uberDays[0].commission).toBeCloseTo(69.60, 2);
  });
});

describe('channel comparison reconciles with the Net Sales KPI', () => {
  it('carries both bases per channel', async () => {
    const res = await request(app())
      .get(`/api/reports/channel-comparison?${RANGE}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const channels = res.body.channels as Array<any>;

    const uber = channels.find(c => c.channel === 'uber_eats');
    expect(uber.order_count).toBe(2);
    expect(uber.revenue).toBeCloseTo(200, 2);
    expect(uber.gross_revenue).toBeCloseTo(232, 2);
    expect(uber.gross_revenue / uber.order_count).toBeCloseTo(uber.avg_ticket, 2);

    const pos = channels.find(c => c.channel === 'pos');
    expect(pos.revenue).toBeCloseTo(50, 2);
  });

  it('sums to the Net Sales KPI for the same range', async () => {
    const [chanRes, salesRes] = await Promise.all([
      request(app()).get(`/api/reports/channel-comparison?${RANGE}`).set('Authorization', `Bearer ${token}`),
      request(app()).get(`/api/reports/sales?${RANGE}`).set('Authorization', `Bearer ${token}`),
    ]);
    expect(chanRes.status).toBe(200);
    expect(salesRes.status).toBe(200);

    const channelNet = (chanRes.body.channels as Array<any>)
      .reduce((sum, c) => sum + c.revenue, 0);
    expect(channelNet).toBeCloseTo(Number(salesRes.body.total_revenue), 2);
    expect(channelNet).toBeCloseTo(450, 2); // 100×4 delivery + 50 pos, unpaid excluded
  });
});

describe('/admin/delivery analytics agrees with the Reports screen', () => {
  it('reports the same per-platform gross for the same range', async () => {
    const [margins, analytics] = await Promise.all([
      getMargins(),
      request(app())
        .get(`/api/delivery-intel/analytics?start=${DAY_A}&end=${DAY_B}`)
        .set('Authorization', `Bearer ${token}`),
    ]);
    expect(analytics.status).toBe(200);

    for (const name of ['uber_eats', 'rappi', 'didi_food']) {
      const m = byName(margins.platforms, name);
      const a = (analytics.body.platforms as Array<any>)
        .find(p => p.platform_id === platformIds[name]);
      expect(Number(a.gross_revenue)).toBeCloseTo(m.gross_revenue, 2);
      expect(Number(a.total_commission)).toBeCloseTo(m.total_commission, 2);
      expect(Number(a.order_count)).toBe(Number(m.order_count));
    }
  });
});
