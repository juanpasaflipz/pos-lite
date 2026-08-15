// Reports → Sales → "Desglose de Ventas por Hora".
//
// This table was reported as "the numbers don't add up" and it had two
// independent reasons to be true:
//
//   1. RANGE. /api/reports/hourly ignored start_date/end_date/period and was
//      hard-pinned to "today" in tenant time. Pick "this month" and the KPI
//      strip showed the month while the hourly rows below it showed today —
//      nothing on the screen could be reconciled against anything else.
//   2. BASIS. `revenue` was SUM(subtotal) (net of IVA and tips) while
//      `avg_ticket` was AVG(total) (what the customer paid), so no row
//      satisfied revenue / orders === avg_ticket and the ~16% gap looked like
//      missing money.
//
// Both are pinned below, plus the timezone property that makes the hour column
// meaningful at all: a 20:15 Mexico City sale lands at 02:15 UTC the FOLLOWING
// day, so a UTC-naive query would file it under hour 2 of the wrong date.

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
import { adminSql, getConn } from '../server/db/index.js';
// @ts-ignore
import reportsRouter from '../server/routes/reports.js';
// @ts-ignore
import { TOOL_HANDLERS } from '../server/agent/handlers.js';
// @ts-ignore
import { JWT_SECRET } from '../server/lib/constants.js';

const TZ = 'America/Mexico_City'; // UTC-6 year-round since 2022 — no DST edge
const OFFSET = '-06:00';
const DAY_A = '2026-03-10';
const DAY_B = '2026-03-11';

let tenant: TestTenant;
let token = '';

/** YYYY-MM-DD `n` days ago in tenant time — for the agent's rolling windows. */
function daysAgo(n: number) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(Date.now() - n * 86400000));
}

const RECENT_DAY = daysAgo(3);

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
  return a;
}

/**
 * One paid order stamped at `day` + `hhmm` in tenant time.
 *
 * The instant is written as an ISO string carrying an explicit offset. Do NOT
 * be tempted to write `${'2026-03-10 13:30'}::timestamp AT TIME ZONE ${TZ}` in
 * a postgres.js tagged template: the driver hands the bare string over as a
 * timestamptz-ish parameter and the value silently arrives already shifted by
 * the *Node process* timezone, so the row lands 6 hours late and every hour
 * assertion below drifts. An explicit offset is unambiguous everywhere.
 */
async function seedOrder(
  employeeId: number,
  orderNumber: number,
  day: string,
  hhmm: string,
  { subtotal, tax, tip }: { subtotal: number; tax: number; tip: number }
) {
  const at = `${day}T${hhmm}:00${OFFSET}`;
  const total = subtotal + tax + tip;
  await adminSql`
    INSERT INTO orders (
      tenant_id, order_number, employee_id, status, subtotal, tax, tip, total,
      payment_status, payment_method, created_at, paid_at
    )
    VALUES (
      ${tenant.id}, ${orderNumber}, ${employeeId}, 'completed',
      ${subtotal}, ${tax}, ${tip}, ${total}, 'paid', 'cash',
      ${at}::timestamptz, ${at}::timestamptz
    )
  `;
}

beforeAll(async () => {
  tenant = await createTestTenant('hourly');

  const [emp] = await adminSql`
    INSERT INTO employees (tenant_id, name, pin, role, active)
    VALUES (${tenant.id}, 'Reportes', '7171', 'manager', true) RETURNING id
  `;
  const employeeId = Number(emp.id);
  token = jwt.sign(
    { tenantId: tenant.id, employeeId, role: 'manager', type: 'employee' },
    JWT_SECRET,
    { expiresIn: '24h' },
  );

  // Day A, hour 13: two orders. Day B, hour 20: one order that falls on the
  // NEXT UTC day (02:15Z). Day B, hour 13: one order, so hour 13 spans days.
  await seedOrder(employeeId, 1, DAY_A, '13:30', { subtotal: 100, tax: 16, tip: 10 });
  await seedOrder(employeeId, 2, DAY_A, '13:45', { subtotal: 200, tax: 32, tip: 0 });
  await seedOrder(employeeId, 3, DAY_B, '20:15', { subtotal: 300, tax: 48, tip: 20 });
  await seedOrder(employeeId, 4, DAY_B, '13:05', { subtotal: 50, tax: 8, tip: 0 });

  // Inside the AI agent's rolling 4-week window, which the fixed March dates
  // above fall outside of. Same 20:15 local / 02:15Z-next-day property.
  await seedOrder(employeeId, 6, RECENT_DAY, '20:15', { subtotal: 400, tax: 64, tip: 0 });
  await seedOrder(employeeId, 7, RECENT_DAY, '13:30', { subtotal: 120, tax: 19.2, tip: 0 });

  // An unpaid order in range — must not appear anywhere.
  await seedOrder(employeeId, 5, DAY_A, '15:00', { subtotal: 999, tax: 0, tip: 0 });
  await adminSql`
    UPDATE orders SET payment_status = 'unpaid'
    WHERE tenant_id = ${tenant.id} AND order_number = 5
  `;
});

afterAll(async () => {
  await dropTestTenant(tenant.id);
  await closePools();
});

async function hourly(query: string) {
  const res = await request(app())
    .get(`/api/reports/hourly?${query}`)
    .set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  return res.body as Array<{
    hour: number; orders: number; revenue: number; gross_revenue: number; avg_ticket: number;
  }>;
}

const RANGE = `start_date=${DAY_A}&end_date=${DAY_B}`;

describe('hourly breakdown honors the selected range', () => {
  it('reports the whole range, not just today', async () => {
    const rows = await hourly(RANGE);
    const active = rows.filter(r => r.orders > 0);

    // Four paid orders across two past days. Pinned to "today" this was empty.
    expect(active.reduce((n, r) => n + r.orders, 0)).toBe(4);
    expect(active.map(r => r.hour).sort((a, b) => a - b)).toEqual([13, 20]);
  });

  it('narrows to a single day when the range is a single day', async () => {
    const rows = await hourly(`start_date=${DAY_A}&end_date=${DAY_A}`);
    const active = rows.filter(r => r.orders > 0);
    expect(active).toHaveLength(1);
    expect(active[0].hour).toBe(13);
    expect(active[0].orders).toBe(2);
  });

  it('still returns all 24 hours, zero-filled', async () => {
    const rows = await hourly(RANGE);
    expect(rows).toHaveLength(24);
    expect(rows.map(r => r.hour)).toEqual([...Array(24).keys()]);
  });
});

describe('hours are tenant-local, not UTC', () => {
  it('files a 20:15 Mexico City sale under hour 20 on its own local day', async () => {
    // 20:15 America/Mexico_City === 02:15Z the next calendar day. A UTC-naive
    // EXTRACT would report hour 2, and a UTC date filter would push the order
    // into DAY_B + 1 and out of this range entirely.
    const rows = await hourly(`start_date=${DAY_B}&end_date=${DAY_B}`);
    const active = rows.filter(r => r.orders > 0);
    expect(active.map(r => r.hour).sort((a, b) => a - b)).toEqual([13, 20]);
    expect(rows[2].orders).toBe(0);
  });
});

describe('the numbers reconcile', () => {
  it('net revenue sums to the Net Sales KPI for the same range', async () => {
    const rows = await hourly(RANGE);
    const sales = await request(app())
      .get(`/api/reports/sales?${RANGE}`)
      .set('Authorization', `Bearer ${token}`);
    expect(sales.status).toBe(200);

    const hourlyNet = rows.reduce((sum, r) => sum + r.revenue, 0);
    expect(hourlyNet).toBeCloseTo(Number(sales.body.total_revenue), 2);
    expect(hourlyNet).toBeCloseTo(650, 2); // 100 + 200 + 300 + 50, unpaid excluded

    const hourlyOrders = rows.reduce((sum, r) => sum + r.orders, 0);
    expect(hourlyOrders).toBe(Number(sales.body.order_count));
  });

  it('gross revenue / orders equals avg ticket on every row', async () => {
    const rows = await hourly(RANGE);
    for (const row of rows.filter(r => r.orders > 0)) {
      expect(row.gross_revenue / row.orders).toBeCloseTo(row.avg_ticket, 2);
    }
  });

  it('separates net from gross by exactly IVA plus tips', async () => {
    const rows = await hourly(RANGE);
    const net = rows.reduce((sum, r) => sum + r.revenue, 0);
    const gross = rows.reduce((sum, r) => sum + r.gross_revenue, 0);
    // tax 16+32+48+8 = 104, tips 10+0+20+0 = 30
    expect(gross - net).toBeCloseTo(134, 2);
  });
});

describe('employee performance uses the same two bases', () => {
  it('exposes net total_sales and a gross_sales that divides into avg_ticket', async () => {
    const res = await request(app())
      .get(`/api/reports/employee-performance?${RANGE}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);

    const rows = (res.body as Array<any>).filter(e => e.orders_processed > 0);
    expect(rows).toHaveLength(1);
    const [emp] = rows;
    expect(emp.total_sales).toBeCloseTo(650, 2);
    expect(emp.gross_sales / emp.orders_processed).toBeCloseTo(emp.avg_ticket, 2);
  });
});

// The AI agent answers "when are we busiest?" from the same orders table, and
// had the same defect in a place nobody looks: raw EXTRACT(HOUR/DOW FROM
// created_at) with no conversion. For a UTC-6 tenant that reported the dinner
// rush as a 2am rush and pushed Saturday night's sales onto Sunday.
describe('the AI agent buckets hours and weekdays in tenant time', () => {
  const runTool = (tool: string, input: Record<string, unknown>) =>
    asTenant(tenant.id, () =>
      TOOL_HANDLERS[tool]({ input, conn: getConn(), tenantId: tenant.id, tz: TZ })
    );

  it('reports busiest hours as local hours', async () => {
    const result: any = await runTool('get_sales_summary', {
      start_date: DAY_A, end_date: DAY_B,
    });
    const hours = result.busiest_hours.map((h: any) => h.hour).sort((a: number, b: number) => a - b);
    expect(hours).toEqual([13, 20]); // UTC would have said [19, 2]
    expect(Number(result.order_count)).toBe(4);
  });

  it('does not lose the last evening of a range to the UTC day boundary', async () => {
    // The 20:15 sale on DAY_B is 02:15Z on DAY_B + 1. The old
    // `created_at < end::date + 1 day` bound cut it off in a GMT session.
    const result: any = await runTool('get_sales_summary', {
      start_date: DAY_B, end_date: DAY_B,
    });
    expect(Number(result.order_count)).toBe(2);
    expect(Number(result.revenue)).toBeCloseTo(368 + 58, 2); // 300+48+20, 50+8
  });

  it('files a 20:15 sale under hour 20 on its own local weekday', async () => {
    const result: any = await runTool('get_sales_by_day_and_hour', { weeks: 4 });
    const hours = result.by_hour.map((h: any) => h.hour);
    expect(hours).toContain(20);
    expect(hours).toContain(13);
    expect(hours).not.toContain(2); // the UTC hour of that same sale

    const [y, m, d] = RECENT_DAY.split('-').map(Number);
    const expectedDow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    expect(result.by_day.map((r: any) => r.day_of_week)).toEqual([expectedDow]);
  });
});
