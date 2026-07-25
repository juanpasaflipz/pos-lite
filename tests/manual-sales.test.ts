// Manual & imported sales entry (2026-07-25).
//
// Two halves:
//   1. Pure parsing (server/lib/salesImport.js) — no DB. This is the part most
//      likely to be wrong, because neither a real Rappi "Relación de ventas"
//      nor a real DiDi "Detalle de pagos" file has ever been run through it;
//      the fixtures below are built from each platform's PUBLISHED column
//      dictionary. If a real export later disagrees, fix it here first.
//   2. The fan-out write path (server/routes/manual-sales.js) — a real tenant
//      under RLS. The invariants that matter: money in == money out (an
//      aggregate day must sum back to the gross the user typed, to the cent),
//      and each order must be paired with ITS OWN external order id — a
//      mis-pairing there would silently corrupt import dedup forever.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestTenant, dropTestTenant, asTenant, closePools, type TestTenant } from './helpers/db.js';
// @ts-ignore — server files are plain JS
import {
  parseAmount, parseBusinessDate, detectMapping, splitAmount, parseUpload, normalizeRows,
} from '../server/lib/salesImport.js';
// @ts-ignore
import { insertSaleOrders, createBatch, resolvePlatform } from '../server/routes/manual-sales.js';
// @ts-ignore
import { all, get, run } from '../server/db/index.js';

// ==================== 1. Pure parsing ====================

describe('parseAmount', () => {
  it('reads the money formats a Mexican portal export can emit', () => {
    expect(parseAmount('1234.56')).toBe(1234.56);
    expect(parseAmount('$1,234.56')).toBe(1234.56);      // MX / US grouping
    expect(parseAmount('1.234,56')).toBe(1234.56);        // European grouping
    expect(parseAmount('123,45')).toBe(123.45);           // comma as decimal
    expect(parseAmount('1,234')).toBe(1234);              // comma as thousands
    expect(parseAmount('2,500.00 MXN')).toBe(2500);
    expect(parseAmount(45.2)).toBe(45.2);
  });

  it('treats parenthesised and signed values as negative', () => {
    expect(parseAmount('(123.45)')).toBe(-123.45);
    expect(parseAmount('-99.50')).toBe(-99.5);
  });

  it('returns 0 rather than NaN for junk, so a bad cell cannot poison a total', () => {
    expect(parseAmount('')).toBe(0);
    expect(parseAmount('n/a')).toBe(0);
    expect(parseAmount(null)).toBe(0);
    expect(parseAmount(undefined)).toBe(0);
  });
});

describe('parseBusinessDate', () => {
  it('reads day-first dates — both portals are es-MX', () => {
    expect(parseBusinessDate('20/07/2026')).toBe('2026-07-20');
    expect(parseBusinessDate('5/7/2026')).toBe('2026-07-05');
  });

  it('reads ISO, ISO-with-time and slashed-ISO', () => {
    expect(parseBusinessDate('2026-07-20')).toBe('2026-07-20');
    expect(parseBusinessDate('2026-07-20 14:33:02')).toBe('2026-07-20');
    expect(parseBusinessDate('2026/07/20')).toBe('2026-07-20');
  });

  it('reads an Excel serial date (survives an xlsx→csv round trip)', () => {
    expect(parseBusinessDate('46223')).toBe('2026-07-20');
  });

  it('returns null for junk instead of guessing a date', () => {
    expect(parseBusinessDate('---')).toBeNull();
    expect(parseBusinessDate('')).toBeNull();
    expect(parseBusinessDate(null)).toBeNull();
  });
});

describe('splitAmount', () => {
  it('always sums back to the original to the cent', () => {
    const cases: [number, number][] = [
      [12400, 47], [100, 3], [0.05, 4], [99999.99, 1000], [1, 7], [33.33, 3], [8675.309, 11],
    ];
    for (const [total, n] of cases) {
      const parts = splitAmount(total, n);
      expect(parts).toHaveLength(n);
      expect(Math.round(parts.reduce((a: number, b: number) => a + b, 0) * 100) / 100)
        .toBe(Math.round(total * 100) / 100);
    }
  });

  it('spreads remainder cents rather than dropping them', () => {
    const parts = splitAmount(1, 3); // 100 cents / 3
    expect(parts).toEqual([0.34, 0.33, 0.33]);
  });
});

describe('detectMapping', () => {
  it("maps Rappi's published Relación de ventas columns", () => {
    const m = detectMapping([
      'ID de la orden', 'Fecha de la orden', 'Venta bruta (+)',
      'Uso y Alquiler de la Plataforma (-)', 'Valor a transferir',
    ]);
    expect(m.external_order_id).toBe('ID de la orden');
    expect(m.business_date).toBe('Fecha de la orden');
    expect(m.gross).toBe('Venta bruta (+)');
    expect(m.commission).toBe('Uso y Alquiler de la Plataforma (-)');
    expect(m.net).toBe('Valor a transferir');
  });

  it("maps DiDi's published Detalle de pagos columns", () => {
    const m = detectMapping([
      'Número de pedido', 'Fecha', 'Precio original del producto',
      'Tarifa de servicio', 'Ganancias por pedidos',
    ]);
    expect(m.external_order_id).toBe('Número de pedido');
    expect(m.business_date).toBe('Fecha');
    expect(m.gross).toBe('Precio original del producto');
    expect(m.commission).toBe('Tarifa de servicio');
  });

  it('never assigns one column to two fields', () => {
    const m = detectMapping(['Total', 'Fecha']);
    const used = Object.values(m).filter(Boolean);
    expect(new Set(used).size).toBe(used.length);
  });

  it('reports nulls for columns it cannot find, rather than guessing', () => {
    const m = detectMapping(['alpha', 'beta', 'gamma']);
    expect(m.gross).toBeNull();
    expect(m.commission).toBeNull();
  });
});

describe('parseUpload + normalizeRows', () => {
  const rappiCsv = [
    'ID de la orden,Fecha de la orden,Venta bruta (+),Uso y Alquiler de la Plataforma (-)',
    'RP-90011,20/07/2026,"$450.00","$112.50"',
    'RP-90012,20/07/2026,"$1,280.50","$320.13"',
    'RP-90013,21/07/2026,"$215.00","$53.75"',
  ].join('\n');

  it('parses a comma CSV and normalizes it into sale rows', async () => {
    const { headers, rows } = await parseUpload(Buffer.from(rappiCsv, 'utf8'), 'ventas.csv');
    const { rows: norm } = normalizeRows(rows, detectMapping(headers), null);
    expect(norm).toHaveLength(3);
    expect(norm[1]).toMatchObject({ external_order_id: 'RP-90012', gross: 1280.5, commission: 320.13 });
    expect(norm[2].business_date).toBe('2026-07-21');
  });

  it('parses a semicolon CSV with European decimals (DiDi shape)', async () => {
    const didiCsv = [
      'Número de pedido;Fecha;Precio original del producto;Tarifa de servicio',
      'DD77001;2026-07-20;320,00;80,00',
      'DD77002;2026-07-20;155,50;38,88',
    ].join('\n');
    const { headers, rows } = await parseUpload(Buffer.from(didiCsv, 'utf8'), 'pagos.csv');
    const { rows: norm } = normalizeRows(rows, detectMapping(headers), null);
    expect(norm).toHaveLength(2);
    expect(norm[0].gross).toBe(320);
    expect(norm[1].commission).toBe(38.88);
  });

  it('strips a UTF-8 BOM (Excel writes one on CSV export)', async () => {
    const { headers } = await parseUpload(Buffer.from('﻿Total,Fecha\n10,2026-07-20', 'utf8'), 'x.csv');
    expect(headers[0]).toBe('Total');
  });

  it('skips rows with no usable amount or date instead of importing zeroes', async () => {
    const csv = [
      'ID,Fecha,Venta bruta',
      'A,20/07/2026,100.00',
      'B,20/07/2026,',        // no amount
      'C,not-a-date,50.00',   // no date, no fallback
      'D,,75.00',
    ].join('\n');
    const { headers, rows } = await parseUpload(Buffer.from(csv, 'utf8'), 'x.csv');
    const { rows: norm, skipped } = normalizeRows(rows, detectMapping(headers), null);
    expect(norm).toHaveLength(1);
    expect(norm[0].external_order_id).toBe('A');
    expect(skipped).toHaveLength(3);
  });

  it('uses the fallback date only where the file has none', async () => {
    const csv = 'ID,Venta bruta\nA,100.00\nB,250.00';
    const { headers, rows } = await parseUpload(Buffer.from(csv, 'utf8'), 'x.csv');
    const { rows: norm } = normalizeRows(rows, detectMapping(headers), '2026-07-19');
    expect(norm).toHaveLength(2);
    expect(norm.every((r: { business_date: string }) => r.business_date === '2026-07-19')).toBe(true);
  });

  it('rejects an xlsx with an actionable message when exceljs is absent', async () => {
    // PK.. zip magic → detected as xlsx. If exceljs IS installed this parses
    // (and throws a different error for a truncated file); either way the
    // caller gets a 400, never a 500.
    const bogus = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    await expect(parseUpload(bogus, 'export.xlsx')).rejects.toThrow();
    await parseUpload(bogus, 'export.xlsx').catch((e: Error & { statusCode?: number }) => {
      expect(e.statusCode).toBe(400);
    });
  });
});

// ==================== 2. Fan-out write path (real tenant, RLS) ====================

let tenant: TestTenant;
let employeeId: number;

beforeAll(async () => {
  tenant = await createTestTenant('manualsales');
  await asTenant(tenant.id, async () => {
    const r = await run(
      `INSERT INTO employees (tenant_id, name, pin, role, active) VALUES ($1, $2, $3, 'admin', true)`,
      [tenant.id, 'Manual Sales Tester', '4321']
    );
    employeeId = r.lastInsertRowid;
  });
});

afterAll(async () => {
  await dropTestTenant(tenant.id);
  await closePools();
});

describe('aggregate fan-out', () => {
  it('creates one real order per reported order, summing exactly to gross', async () => {
    await asTenant(tenant.id, async () => {
      const platform = await resolvePlatform('rappi');
      const gross = 12400.55;
      const count = 47;

      const batchId = await createBatch({
        channel: 'rappi', platform_id: platform.id, entry_mode: 'aggregate',
        business_date: '2026-07-20', order_count: count, gross_total: gross,
        commission_total: 0, net_total: gross, commission_percent: 0, created_by: employeeId,
      });

      const sales = splitAmount(gross, count).map((total: number) => ({
        total, business_date: '2026-07-20', external_order_id: null, commission: 0,
      }));
      const created = await insertSaleOrders(sales, {
        batchId, channel: 'rappi', platformId: platform.id, employeeId, tz: 'America/Mexico_City',
      });

      expect(created).toHaveLength(count);

      const row = await get(
        `SELECT COUNT(*)::int AS n, ROUND(SUM(total), 2)::float8 AS total
         FROM orders WHERE manual_batch_id = $1`, [batchId]
      );
      expect(row.n).toBe(count);
      expect(row.total).toBe(gross); // money in == money out, to the cent
    });
  });

  it('marks them paid+completed so reports count them and the KDS never does', async () => {
    await asTenant(tenant.id, async () => {
      const platform = await resolvePlatform('didi_food');
      const batchId = await createBatch({
        channel: 'didi_food', platform_id: platform.id, entry_mode: 'aggregate',
        business_date: '2026-07-18', order_count: 3, gross_total: 300,
        commission_total: 75, net_total: 225, commission_percent: 25, created_by: employeeId,
      });
      await insertSaleOrders(
        splitAmount(300, 3).map((total: number) => ({ total, business_date: '2026-07-18', external_order_id: null, commission: 25 })),
        { batchId, channel: 'didi_food', platformId: platform.id, employeeId, tz: 'America/Mexico_City' }
      );

      const rows = await all(
        `SELECT status, payment_status, source, payment_method FROM orders WHERE manual_batch_id = $1`, [batchId]
      );
      expect(rows).toHaveLength(3);
      for (const r of rows) {
        expect(r.status).toBe('completed');       // never 'active' → never on the KDS
        expect(r.payment_status).toBe('paid');    // reports filter on this
        expect(r.source).toBe('didi_food');       // channel-comparison report
        expect(r.payment_method).toBe('didi_food');
      }
    });
  });

  it('backdates into the tenant timezone, so a report for that day picks them up', async () => {
    await asTenant(tenant.id, async () => {
      const platform = await resolvePlatform('rappi');
      const batchId = await createBatch({
        channel: 'rappi', platform_id: platform.id, entry_mode: 'aggregate',
        business_date: '2026-07-15', order_count: 5, gross_total: 500,
        commission_total: 0, net_total: 500, commission_percent: 0, created_by: employeeId,
      });
      await insertSaleOrders(
        splitAmount(500, 5).map((total: number) => ({ total, business_date: '2026-07-15', external_order_id: null, commission: 0 })),
        { batchId, channel: 'rappi', platformId: platform.id, employeeId, tz: 'America/Mexico_City' }
      );

      // Mirrors the date predicate every report in reports.js uses.
      const row = await get(
        `SELECT COUNT(*)::int AS n FROM orders
         WHERE manual_batch_id = $1
           AND (COALESCE(paid_at, created_at) AT TIME ZONE 'America/Mexico_City')::date = '2026-07-15'`,
        [batchId]
      );
      expect(row.n).toBe(5);
    });
  });

  it('gives every order a distinct order number', async () => {
    await asTenant(tenant.id, async () => {
      const platform = await resolvePlatform('rappi');
      const batchId = await createBatch({
        channel: 'rappi', platform_id: platform.id, entry_mode: 'aggregate',
        business_date: '2026-07-14', order_count: 20, gross_total: 2000,
        commission_total: 0, net_total: 2000, commission_percent: 0, created_by: employeeId,
      });
      await insertSaleOrders(
        splitAmount(2000, 20).map((total: number) => ({ total, business_date: '2026-07-14', external_order_id: null, commission: 0 })),
        { batchId, channel: 'rappi', platformId: platform.id, employeeId, tz: 'America/Mexico_City' }
      );
      const row = await get(
        `SELECT COUNT(*)::int AS n, COUNT(DISTINCT order_number)::int AS distinct_n
         FROM orders WHERE manual_batch_id = $1`, [batchId]
      );
      expect(row.distinct_n).toBe(row.n);
    });
  });
});

describe('import fan-out', () => {
  it('pairs each order with its OWN external id and commission', async () => {
    // The regression this guards: insertSaleOrders builds its rows with
    // unnest() and matches RETURNING back by order_number. If that join were
    // replaced with "trust the row order", ids would silently drift and
    // future imports would dedup against the wrong orders.
    await asTenant(tenant.id, async () => {
      const platform = await resolvePlatform('rappi');
      const batchId = await createBatch({
        channel: 'rappi', platform_id: platform.id, entry_mode: 'import',
        business_date: '2026-07-10', order_count: 3, gross_total: 1945.5,
        commission_total: 486.38, net_total: 1459.12, commission_percent: 25,
        source_filename: 'relacion.csv', created_by: employeeId,
      });

      const sales = [
        { total: 450.0, business_date: '2026-07-10', external_order_id: 'RP-90011', commission: 112.5 },
        { total: 1280.5, business_date: '2026-07-10', external_order_id: 'RP-90012', commission: 320.13 },
        { total: 215.0, business_date: '2026-07-11', external_order_id: 'RP-90013', commission: 53.75 },
      ];
      await insertSaleOrders(sales, {
        batchId, channel: 'rappi', platformId: platform.id, employeeId, tz: 'America/Mexico_City',
      });

      const rows = await all(
        `SELECT o.total::float8 AS total, d.external_order_id, d.platform_commission::float8 AS commission,
                o.delivery_order_id, d.id AS d_id
         FROM orders o JOIN delivery_orders d ON d.order_id = o.id
         WHERE o.manual_batch_id = $1`, [batchId]
      );
      expect(rows).toHaveLength(3);

      const byExt = new Map(rows.map((r: any) => [r.external_order_id, r]));
      expect(byExt.get('RP-90011').total).toBe(450);
      expect(byExt.get('RP-90011').commission).toBe(112.5);
      expect(byExt.get('RP-90012').total).toBe(1280.5);
      expect(byExt.get('RP-90012').commission).toBe(320.13);
      expect(byExt.get('RP-90013').total).toBe(215);

      // orders.delivery_order_id must point back at its own delivery_orders row
      for (const r of rows) expect(r.delivery_order_id).toBe(r.d_id);
    });
  });

  it('spans multiple business dates in one batch', async () => {
    await asTenant(tenant.id, async () => {
      const platform = await resolvePlatform('rappi');
      const batchId = await createBatch({
        channel: 'rappi', platform_id: platform.id, entry_mode: 'import',
        business_date: '2026-07-01', order_count: 4, gross_total: 400,
        commission_total: 0, net_total: 400, commission_percent: 0, created_by: employeeId,
      });
      await insertSaleOrders([
        { total: 100, business_date: '2026-07-01', external_order_id: 'MD-1', commission: 0 },
        { total: 100, business_date: '2026-07-01', external_order_id: 'MD-2', commission: 0 },
        { total: 100, business_date: '2026-07-02', external_order_id: 'MD-3', commission: 0 },
        { total: 100, business_date: '2026-07-03', external_order_id: 'MD-4', commission: 0 },
      ], { batchId, channel: 'rappi', platformId: platform.id, employeeId, tz: 'America/Mexico_City' });

      const rows = await all(
        `SELECT (COALESCE(paid_at, created_at) AT TIME ZONE 'America/Mexico_City')::date::text AS d,
                COUNT(*)::int AS n
         FROM orders WHERE manual_batch_id = $1 GROUP BY 1 ORDER BY 1`, [batchId]
      );
      expect(rows.map((r: any) => [r.d, r.n])).toEqual([
        ['2026-07-01', 2], ['2026-07-02', 1], ['2026-07-03', 1],
      ]);
    });
  });
});

describe('tenant isolation', () => {
  it('does not leak manual sales batches across tenants', async () => {
    const other = await createTestTenant('manualsales-b');
    try {
      const mine = await asTenant(tenant.id, () => all('SELECT id FROM manual_sales_batches'));
      expect(mine.length).toBeGreaterThan(0);
      const theirs = await asTenant(other.id, () => all('SELECT id FROM manual_sales_batches'));
      expect(theirs).toHaveLength(0);
    } finally {
      await dropTestTenant(other.id);
    }
  });
});
