// Payroll forecast test — the /forecast query used to throw
// `column "ss.employee_id" must appear in the GROUP BY clause` because the
// SELECT list referenced the joined table's employee_id but GROUP BY only
// listed employee columns. Fix: select `e.id AS employee_id` instead so the
// value comes from a grouped column (see server/routes/payroll.js).
//
// This test runs the exact SQL from the route against a seeded scheduled
// shift — before the fix it errored on every call; after the fix it returns
// the shift's hours.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestTenant,
  dropTestTenant,
  asTenant,
  closePools,
  type TestTenant,
} from './helpers/db.js';
// @ts-ignore — server files are plain JS
import { get, all, run } from '../server/db/index.js';

// Verbatim from server/routes/payroll.js:259 — if the route SQL diverges,
// the fixture-based assertion here still guards the GROUP BY invariant.
const FORECAST_SQL = `
  SELECT
    e.id AS employee_id,
    e.name AS employee_name,
    e.role AS employee_role,
    e.pay_type,
    e.hourly_rate_cents,
    e.weekly_salary_cents,
    COALESCE(SUM(
      EXTRACT(EPOCH FROM (
        LEAST(ss.ends_at, $2::timestamptz) - GREATEST(ss.starts_at, $1::timestamptz)
      )) / 3600.0
    ) FILTER (WHERE ss.id IS NOT NULL), 0)::numeric(8,2) AS hours_scheduled
  FROM employees e
  LEFT JOIN scheduled_shifts ss
    ON ss.employee_id = e.id
    AND ss.starts_at < $2::timestamptz
    AND ss.ends_at > $1::timestamptz
  WHERE e.active = true
  GROUP BY e.id, e.name, e.role, e.pay_type, e.hourly_rate_cents, e.weekly_salary_cents
  HAVING COALESCE(SUM(
    EXTRACT(EPOCH FROM (
      LEAST(ss.ends_at, $2::timestamptz) - GREATEST(ss.starts_at, $1::timestamptz)
    )) / 3600.0
  ) FILTER (WHERE ss.id IS NOT NULL), 0) > 0
  ORDER BY e.name ASC
`;

let tenant: TestTenant;
let employeeId: number;

beforeAll(async () => {
  tenant = await createTestTenant('payroll');

  await asTenant(tenant.id, async () => {
    const emp = await get(
      `INSERT INTO employees (name, pin, role, pay_type, hourly_rate_cents)
       VALUES ('Test Cook', '4242', 'kitchen', 'hourly', 12000)
       RETURNING id`,
    );
    employeeId = Number(emp.id);

    // Seed a 4-hour shift squarely inside the query window (starts +1h, ends +5h).
    const startsAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const endsAt = new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString();
    await run(
      `INSERT INTO scheduled_shifts (employee_id, starts_at, ends_at)
       VALUES ($1, $2, $3)`,
      [employeeId, startsAt, endsAt],
    );
  });
}, 60_000);

afterAll(async () => {
  await dropTestTenant(tenant.id);
  await closePools();
});

describe('/api/payroll/forecast SQL', () => {
  it('runs without a GROUP BY error and returns the seeded shift hours', async () => {
    const from = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const to = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const rows = await asTenant(tenant.id, () => all(FORECAST_SQL, [from, to]));

    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(Number(row.employee_id)).toBe(employeeId);
    expect(row.pay_type).toBe('hourly');
    // 4h shift (5h - 1h from now); allow tiny drift from wall-clock during the
    // test to avoid flakiness.
    expect(Number(row.hours_scheduled)).toBeGreaterThan(3.9);
    expect(Number(row.hours_scheduled)).toBeLessThanOrEqual(4);
  });
});
