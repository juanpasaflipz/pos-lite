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
  detectProductMapping, aggregateProductRows, suggestPlatformPrice, deriveQuantity,
  fingerprintHeaders,
} from '../server/lib/salesImport.js';
// @ts-ignore
import { coerceMapping } from '../server/lib/aiColumnMap.js';
// @ts-ignore
import { lookupFormat, recordFormat, mappingDiffers } from '../server/lib/importFormatRegistry.js';
// @ts-ignore
import { matchPlatformItem } from '../server/lib/platformItemMatch.js';
// @ts-ignore
import { adjustInventoryForMenuQuantities, unitCostForMenuItems } from '../server/helpers/inventory.js';
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
      'ID de la orden,Fecha,Venta bruta',
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
    const csv = 'ID de la orden,Venta bruta\nA,100.00\nB,250.00';
    const { headers, rows } = await parseUpload(Buffer.from(csv, 'utf8'), 'x.csv');
    const { rows: norm } = normalizeRows(rows, detectMapping(headers), '2026-07-19');
    expect(norm).toHaveLength(2);
    expect(norm.every((r: { business_date: string }) => r.business_date === '2026-07-19')).toBe(true);
  });

  it('preserves a real 0 commission — a Rappi promo row is not a fallback to 25%', async () => {
    // Regression: pre-Jul-10 2026 Rappi orders carry a genuine 0 in the
    // commission column. Collapsing 0 -> null made the commit path fall back
    // to platform_commission_percent (25%) and invent a charge Rappi never
    // made. The fixture pairs a promo row (0) with a post-promo row (28.1%).
    const csv = [
      'ID de la orden,Fecha de la orden,Venta Bruta,Uso y alquiler de plataforma Rappi',
      'PROMO,25/06/2026,389.00,0',
      'PAID,15/07/2026,300.00,84.30',
    ].join('\n');
    const { headers, rows } = await parseUpload(Buffer.from(csv, 'utf8'), 'rappi.csv');
    const mapping = detectMapping(headers);
    expect(mapping.commission).toBe('Uso y alquiler de plataforma Rappi');
    const { rows: norm } = normalizeRows(rows, mapping, null);
    expect(norm[0]).toMatchObject({ external_order_id: 'PROMO', commission: 0 });
    expect(norm[1]).toMatchObject({ external_order_id: 'PAID', commission: 84.30 });
  });

  it('leaves commission null only when the column was never mapped, so the fallback can kick in', async () => {
    const csv = 'ID de la orden,Fecha,Venta bruta\nA,20/07/2026,100.00';
    const { headers, rows } = await parseUpload(Buffer.from(csv, 'utf8'), 'x.csv');
    const mapping = detectMapping(headers);
    expect(mapping.commission).toBeNull();
    const { rows: norm } = normalizeRows(rows, mapping, null);
    expect(norm[0].commission).toBeNull();
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

describe("DiDi daily operations report (real juanbertos export, 2026-07-01..24)", () => {
  // Fixture transcribed from the actual file Juan uploaded 2026-07-25. Every
  // trap it exposed is pinned here:
  //   - TWO columns literally named "Ganancias diarias promedio" (gross, then
  //     net-of-promo). Naive object-keying let the second win and read 26% low.
  //   - "Núm. de id. de la tienda" is the STORE id, identical on every row —
  //     detecting it as the order id would collapse the file to one order.
  //   - One row per DAY, so rows must fan out by "Pedidos válidos".
  const HEADER = [
    'Ciudad', 'Nombre de la tienda', 'Núm. de id. de la tienda', 'Fecha',
    'Ganancias diarias promedio', 'Ganancias diarias promedio',
    'Pedidos válidos', 'Valor promedio de un pedido', 'Total de recompensas de la plataforma',
  ].join(',');
  const CSV = [
    HEADER,
    'Mexico City,Juanbertos,5764614120993983259,2026-07-24,2924.00,2176.12,14,208.86,1901.00',
    'Mexico City,Juanbertos,5764614120993983259,2026-07-21,7180.00,5571.62,46,156.09,4647.00',
    'Mexico City,Juanbertos,5764614120993983259,2026-07-20,0.00,0.00,0,0.00,0.00',
    'Mexico City,Juanbertos,5764614120993983259,2026-07-17,9365.00,6879.79,65,144.08,7145.40',
  ].join('\n');

  it('disambiguates duplicate headers instead of letting the last one win', async () => {
    const { headers } = await parseUpload(Buffer.from(CSV, 'utf8'), 'ops.csv');
    expect(headers.filter((h: string) => h.startsWith('Ganancias diarias')))
      .toEqual(['Ganancias diarias promedio', 'Ganancias diarias promedio (2)']);
  });

  it('detects the daily shape and picks GROSS, not the net column', async () => {
    const { headers } = await parseUpload(Buffer.from(CSV, 'utf8'), 'ops.csv');
    const m = detectMapping(headers);
    expect(m.business_date).toBe('Fecha');
    expect(m.order_count).toBe('Pedidos válidos');
    expect(m.avg_ticket).toBe('Valor promedio de un pedido');
    expect(m.gross).toBe('Ganancias diarias promedio');       // the FIRST one
    expect(m.gross).not.toBe('Ganancias diarias promedio (2)');
    expect(m.external_order_id).toBeNull();                    // never the store id
    expect(m.commission).toBeNull();                           // this report has none
  });

  it('fans days out into orders, matching the spreadsheet exactly', async () => {
    const { headers, rows } = await parseUpload(Buffer.from(CSV, 'utf8'), 'ops.csv');
    const { rows: norm, skipped } = normalizeRows(rows, detectMapping(headers), null);

    expect(norm).toHaveLength(3);                 // the zero-sales day drops out
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toBe('no orders that day');

    const orders = norm.reduce((s: number, r: any) => s + r.order_count, 0);
    const gross = Math.round(norm.reduce((s: number, r: any) => s + r.gross, 0) * 100) / 100;
    expect(orders).toBe(125);                     // 14 + 46 + 65
    expect(gross).toBe(19469);                    // 2924 + 7180 + 9365
    expect(Math.round((gross / orders) * 100) / 100).toBe(155.75);

    // A day standing for many orders cannot carry one platform order id.
    expect(norm.every((r: any) => r.external_order_id === null)).toBe(true);
  });

  it('derives gross from count x avg ticket when no gross column is mapped', async () => {
    const { headers, rows } = await parseUpload(Buffer.from(CSV, 'utf8'), 'ops.csv');
    const m = { ...detectMapping(headers), gross: null };
    const { rows: norm } = normalizeRows(rows, m, null);
    expect(norm[0].gross).toBeCloseTo(14 * 208.86, 2);
  });
});

describe("DiDi settlement receipt — Recibo/Resumen diario (real juanbertos export)", () => {
  // Transcribed from the real "Recibo DiDi 202607 — Resumen diario" Juan
  // uploaded 2026-07-25. Three more traps, none of which any synthetic
  // fixture would have produced:
  //   - a sparse GROUP header row ABOVE the real header row
  //   - dates as compact YYYYMMDD integers
  //   - commission charged and then rebated back in full, so the headline
  //     commission column overstates the real cost by ~100%
  const GROUP = 'Información de factura básica,,,Ingresos por ventas,Costos de promoción de ventas,,Tarifas cobradas a tienda por plataforma,,,Impuestos,Monto de facturación';
  const HEAD = [
    'ID de la tienda', 'Nombre de la tienda', 'Fecha de facturación',
    'Precio total del producto sin promoción',
    'Inversión de promoción de productos de la tienda',
    'Contribución para promoción de productos de Didi Food',
    'Comisión y distribución', 'Premio de comisión de Didi Food para la tienda',
    'Tarifa de servicio de penalización', 'Retención de impuestos', 'Monto de facturación',
  ].join(',');
  const CSV = [
    GROUP, HEAD,
    '5764614120993983259,Juanbertos,20260724,"2,924.00","-1,741.00",993.20,-609.40,609.32,0.00,0.00,"1,721.12"',
    '5764614120993983259,Juanbertos,20260721,"7,180.00","-4,467.00","2,858.70","-1,560.14","1,560.06",0.00,0.00,"4,836.62"',
    '5764614120993983259,Juanbertos,20260718,730.00,-219.00,0.00,-143.08,143.08,0.00,0.00,511.00',
  ].join('\n');

  it('skips the sparse group header and uses the real header row', async () => {
    const { headers, rows } = await parseUpload(Buffer.from(CSV, 'utf8'), 'recibo.csv');
    expect(headers[0]).toBe('ID de la tienda');
    expect(headers).toContain('Comisión y distribución');
    expect(rows).toHaveLength(3); // the group row must NOT become a data row
  });

  it('reads compact YYYYMMDD billing dates', async () => {
    const { headers, rows } = await parseUpload(Buffer.from(CSV, 'utf8'), 'recibo.csv');
    const { rows: norm } = normalizeRows(rows, detectMapping(headers), null);
    expect(norm.map((r: any) => r.business_date)).toEqual(['2026-07-24', '2026-07-21', '2026-07-18']);
  });

  it('does not mistake the penalty fee for the commission column', async () => {
    const { headers } = await parseUpload(Buffer.from(CSV, 'utf8'), 'recibo.csv');
    const m = detectMapping(headers);
    expect(m.commission).toBe('Comisión y distribución');
    expect(m.commission).not.toBe('Tarifa de servicio de penalización');
    expect(m.gross).toBe('Precio total del producto sin promoción');
    expect(m.net).toBe('Monto de facturación');
  });

  it('nets the rebate off commission — the real cost here is ~0, not 25%', async () => {
    // DiDi charged $2,312.62 and rebated $2,312.46 across these three days.
    // Booking the headline figure would invent a cost that was never charged.
    const { headers, rows } = await parseUpload(Buffer.from(CSV, 'utf8'), 'recibo.csv');
    const m = detectMapping(headers);
    expect(m.commission_rebate).toBe('Premio de comisión de Didi Food para la tienda');

    const { rows: norm } = normalizeRows(rows, m, null);
    const commission = norm.reduce((s: number, r: any) => s + (r.commission ?? 0), 0);
    expect(commission).toBeLessThan(1);

    // ...and without the rebate mapped, it would have been ~$2,312.
    const { rows: naive } = normalizeRows(rows, { ...m, commission_rebate: null }, null);
    expect(naive.reduce((s: number, r: any) => s + (r.commission ?? 0), 0)).toBeGreaterThan(2000);
  });

  it('never lets commission go negative when a rebate exceeds the charge', async () => {
    const csv = [HEAD, 'X,Y,20260724,"1,000.00",0.00,0.00,-100.00,250.00,0.00,0.00,900.00'].join('\n');
    const { headers, rows } = await parseUpload(Buffer.from(csv, 'utf8'), 'r.csv');
    const { rows: norm } = normalizeRows(rows, detectMapping(headers), null);
    // Clamped to 0 and stored as 0 (not null) — the column IS mapped, so
    // the commit path must trust the parsed 0 rather than falling back to
    // the platform default.
    expect(norm[0].commission).toBe(0);
  });
});

describe("Rappi Relación de ventas (real juanbertos export, 2026-06-25..07-25)", () => {
  // Rappi's workbook ships FIVE sheets and the first is "Indice" — a 129-row
  // data dictionary. Taking worksheets[0] parsed the glossary and imported
  // nothing at all. Sheet selection is XLSX-only (exceljs), so the sheet
  // picker itself is covered by the CSV-shaped assertions below plus the
  // detection rules that bit us on the real file:
  //   - "Uso y alquiler de plataforma Rappi" has no "la", and the sheet also
  //     carries "Ventas base por Uso y alquiler…", "…Prime" and "IVA Uso y
  //     alquiler…" — a loose match grabs the sales base instead of the fee.
  //   - dates are "jue. 25 jun. 2026, 1:08:47 p. m."
  //   - order ids arrive as floats ("2452095771.0")
  const HEAD = [
    'Fecha de creación orden', 'ID de la órden', 'ID del paidlot', 'ID de la tienda',
    'Ventas base por Uso y alquiler de plataforma Rappi (base)', 'Venta Bruta',
    'Uso y alquiler de plataforma Rappi', 'Uso y alquiler de plataforma Rappi Prime',
    'IVA Uso y alquiler de plataforma Rappi', 'Valor a transferir',
  ].join(',');
  const CSV = [
    HEAD,
    '"jue. 25 jun. 2026, 1:08:47 p. m.",2452095771.0,58386118.0,1930452656.0,0.0,389.00,0.00,0.0,0.0,0.0',
    '"vie. 10 jul. 2026, 8:12:00 p. m.",2455833427.0,58386118.0,1930452656.0,0.0,250.00,-75.00,0.0,0.0,0.0',
    '"sáb. 18 jul. 2026, 2:30:00 p. m.",2457996171.0,58386118.0,1930452656.0,0.0,870.00,-234.90,0.0,0.0,0.0',
  ].join('\n');

  it('picks the fee column, not the sales base / Prime / IVA lookalikes', async () => {
    const { headers } = await parseUpload(Buffer.from(CSV, 'utf8'), 'rappi.csv');
    const m = detectMapping(headers);
    expect(m.commission).toBe('Uso y alquiler de plataforma Rappi');
    expect(m.gross).toBe('Venta Bruta');
    expect(m.external_order_id).toBe('ID de la órden');
  });

  it('parses Spanish long-form dates with day names and clock times', async () => {
    const { headers, rows } = await parseUpload(Buffer.from(CSV, 'utf8'), 'rappi.csv');
    const { rows: norm } = normalizeRows(rows, detectMapping(headers), null);
    expect(norm.map((r: any) => r.business_date))
      .toEqual(['2026-06-25', '2026-07-10', '2026-07-18']);
  });

  it('strips the float suffix off numeric order ids so re-imports dedup', async () => {
    const { headers, rows } = await parseUpload(Buffer.from(CSV, 'utf8'), 'rappi.csv');
    const { rows: norm } = normalizeRows(rows, detectMapping(headers), null);
    expect(norm[0].external_order_id).toBe('2452095771');
    expect(norm[0].external_order_id).not.toContain('.0');
  });

  it('reads negative commission as a positive cost, and preserves a real 0', async () => {
    const { headers, rows } = await parseUpload(Buffer.from(CSV, 'utf8'), 'rappi.csv');
    const { rows: norm } = normalizeRows(rows, detectMapping(headers), null);
    expect(norm[1].commission).toBe(75);
    expect(norm[2].commission).toBe(234.9);
    // 0 must survive as 0 — pre-promo-end rows genuinely carry no commission,
    // and null would fall back to the platform's default 25% at commit time.
    expect(norm[0].commission).toBe(0);
  });

  it('treats every row as its own order (no order-count column here)', async () => {
    const { headers, rows } = await parseUpload(Buffer.from(CSV, 'utf8'), 'rappi.csv');
    const m = detectMapping(headers);
    expect(m.order_count).toBeNull();
    const { rows: norm } = normalizeRows(rows, m, null);
    expect(norm.every((r: any) => r.order_count === 1)).toBe(true);
  });
});

describe('abbreviated month-name dates', () => {
  it('handles Spanish and English abbreviations', () => {
    expect(parseBusinessDate('jue. 25 jun. 2026, 1:08:47 p. m.')).toBe('2026-06-25');
    expect(parseBusinessDate('mié. 03 sept. 2026')).toBe('2026-09-03');
    expect(parseBusinessDate('lun. 07 dic. 2026')).toBe('2026-12-07');
    expect(parseBusinessDate('Fri 10 Apr 2026')).toBe('2026-04-10');
    expect(parseBusinessDate('01 ene. 2027')).toBe('2027-01-01');
  });

  it('does not fire on a month name it does not know', () => {
    expect(parseBusinessDate('xxx. 25 zzz. 2026')).toBeNull();
  });
});

// ==================== 1b. Product report parsing ====================

describe("DiDi per-product report (real juanbertos export, 2026-07-25..28)", () => {
  // Transcribed verbatim from "_Reporte diario de productos(25-07-2026_
  // 28-07-2026).xlsx", downloaded 2026-07-29. What it exposed:
  //   - THREE constant columns whose header starts with "Nombre" ("de la
  //     tienda", "del firmante", "del artículo"). Matching on bare "nombre"
  //     collapses the whole file to a single product.
  //   - No quantity column at all, so units must come from money ÷ price.
  //   - Platform prices are NOT the POS prices: Bean-n-Cheese is $99 in the
  //     POS and bills $129 here.
  //   - Free modifiers (the salsas) bill 0.00 and carry no units.
  const HEADER = [
    'Ciudad', 'Nombre de la tienda', 'Núm. de id. de la tienda', 'Nombre del firmante',
    'Número de identificación del firmante', 'Fecha', 'Nombre del artículo',
    'Ventas con precios sin descuento', 'Ventas finales', 'Valor de la transacción del pedido',
  ].join(',');
  const R = (date: string, item: string, sinDesc: string, finales: string, valor: string) =>
    `Mexico City,Juanbertos,5764614120993983259,Juanberto's - Calle Coahuila 192,5764614441438808209,${date},${item},${sinDesc},${finales},${valor}`;
  const CSV = [
    HEADER,
    R('2026-07-28', 'Cochinita Burrito', '2363.00', '833.00', '1346.68'),
    R('2026-07-28', 'Salsa mango-habanero', '0.00', '0.00', '545.00'),
    R('2026-07-28', 'Bean-n-Cheese Burrito', '516.00', '196.00', '440.21'),
    R('2026-07-28', 'BREAKFAST BURRITO', '360.00', '98.00', '135.00'),
    R('2026-07-28', 'CALIFORNIA BURRITO', '250.00', '175.00', '261.68'),
    R('2026-07-28', 'PORK BELLY BURRITO', '230.00', '154.00', '242.21'),
    R('2026-07-26', 'Cochinita Burrito', '417.00', '147.00', '210.00'),
    R('2026-07-26', 'BREAKFAST BURRITO', '360.00', '98.00', '141.00'),
    R('2026-07-26', 'Bean-n-Cheese Burrito', '258.00', '178.00', '352.19'),
    R('2026-07-25', 'BREAKFAST BURRITO', '180.00', '49.00', '67.00'),
  ].join('\n');

  const parse = async () => {
    const { headers, rows } = await parseUpload(Buffer.from(CSV, 'utf8'), 'productos.csv');
    return { headers, rows, mapping: detectProductMapping(headers) };
  };

  it('picks the product-name column, not the store or signatory name', async () => {
    const { mapping } = await parse();
    expect(mapping.item_name).toBe('Nombre del artículo');
    expect(mapping.business_date).toBe('Fecha');
    expect(mapping.quantity).toBeNull();          // this report has none
  });

  it('picks list-price sales, not the discounted "Ventas finales"', async () => {
    // Only the undiscounted column divides cleanly by a unit price. Deriving
    // units from "Ventas finales" yields fractions and wrong stock.
    const { mapping } = await parse();
    expect(mapping.gross).toBe('Ventas con precios sin descuento');
  });

  it('collapses to one entry per product-day and drops zero-value modifiers', async () => {
    const { rows, mapping } = await parse();
    const { rows: agg, skipped } = aggregateProductRows(rows, mapping, null);
    expect(agg).toHaveLength(9);                                  // 10 rows - 1 salsa
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toBe('no sales and no quantity');
    expect(skipped[0].item_name).toBe('Salsa mango-habanero');
  });

  it('recovers the real platform price for every item with a POS anchor', async () => {
    const { rows, mapping } = await parse();
    const { rows: agg } = aggregateProductRows(rows, mapping, null);
    const grossFor = (n: string) => agg.filter((r: any) => r.norm_name === n).map((r: any) => r.gross);

    // Marked up: $99 in the POS, $129 on DiDi. The naive answer (the POS price)
    // would read 5.2 units instead of 4.
    expect(suggestPlatformPrice(grossFor('bean-n-cheese burrito'), 99))
      .toEqual({ price: 129, basis: 'pos_anchor' });
    // Not marked up — must anchor to itself, not to a smaller divisor.
    expect(suggestPlatformPrice(grossFor('breakfast burrito'), 180))
      .toEqual({ price: 180, basis: 'pos_anchor' });
    expect(suggestPlatformPrice(grossFor('california burrito'), 250))
      .toEqual({ price: 250, basis: 'pos_anchor' });
    expect(suggestPlatformPrice(grossFor('pork belly burrito'), 230))
      .toEqual({ price: 230, basis: 'pos_anchor' });
  });

  it('still finds the price for a platform-only item from several days of totals', async () => {
    const { rows, mapping } = await parse();
    const { rows: agg } = aggregateProductRows(rows, mapping, null);
    // "Cochinita Burrito" has no POS row, so there is no anchor — but $2363
    // and $417 share exactly one plausible divisor.
    expect(suggestPlatformPrice(agg.filter((r: any) => r.norm_name === 'cochinita burrito').map((r: any) => r.gross), null))
      .toEqual({ price: 139, basis: 'divisor' });
  });

  it('flags a single-day product as a guess rather than asserting one unit', () => {
    // One total is divisible by anything; there is no evidence here and the UI
    // must say so instead of silently deducting one unit's ingredients.
    expect(suggestPlatformPrice([973], null)).toEqual({ price: 973, basis: 'single' });
  });

  it('derives whole units at the recovered prices', async () => {
    const { rows, mapping } = await parse();
    const { rows: agg } = aggregateProductRows(rows, mapping, null);
    const units = (norm: string, price: number) => agg
      .filter((r: any) => r.norm_name === norm)
      .map((r: any) => deriveQuantity({ gross: r.gross, quantity: r.quantity, platform_price: price }));

    expect(units('bean-n-cheese burrito', 129).map((u: any) => u.quantity)).toEqual([4, 2]);
    expect(units('breakfast burrito', 180).map((u: any) => u.quantity)).toEqual([2, 2, 1]);
    expect(units('cochinita burrito', 139).map((u: any) => u.quantity)).toEqual([17, 3]);
    expect(units('breakfast burrito', 180).every((u: any) => u.exact)).toBe(true);
  });

  it('marks a wrong price as inexact instead of rounding stock away quietly', async () => {
    // The POS price, not the platform price — the mistake this screen exists
    // to catch. 516/99 = 5.2, which must NOT pass as "5 units".
    const q = deriveQuantity({ gross: 516, quantity: null, platform_price: 99 });
    expect(q.quantity).toBe(5);
    expect(q.exact).toBe(false);
  });

  it('prefers an explicit quantity column over any derivation', () => {
    const q = deriveQuantity({ gross: 516, quantity: 4, platform_price: 999 });
    expect(q).toEqual({ quantity: 4, exact: true, source: 'column' });
  });

  it('sums a product that appears twice on one day rather than overwriting it', async () => {
    const dupe = [HEADER, R('2026-07-28', 'CALIFORNIA BURRITO', '250.00', '175.00', '261.68'),
      R('2026-07-28', 'California Burrito', '500.00', '350.00', '523.36')].join('\n');
    const { headers, rows } = await parseUpload(Buffer.from(dupe, 'utf8'), 'dupe.csv');
    const { rows: agg } = aggregateProductRows(rows, detectProductMapping(headers), null);
    expect(agg).toHaveLength(1);          // case differs; same product
    expect(agg[0].gross).toBe(750);
  });
});

describe('matchPlatformItem', () => {
  const MENU = [
    { id: 1, name: 'Bean & Cheese', price: 99 },
    { id: 2, name: 'Breakfast', price: 180 },
    { id: 3, name: 'California', price: 250 },
    { id: 4, name: 'Porkbelly', price: 230 },
    { id: 5, name: 'Surf-N-Turf (Mar y Tierra)', price: 340 },
    { id: 6, name: 'Cerveza', price: 67 },
  ];

  it('matches across the spacing and punctuation drift between the two menus', () => {
    // Real DiDi names against the real juanbertos POS menu.
    expect(matchPlatformItem('PORK BELLY BURRITO', MENU).name).toBe('Porkbelly');
    expect(matchPlatformItem('BREAKFAST BURRITO', MENU).name).toBe('Breakfast');
    expect(matchPlatformItem('CALIFORNIA BURRITO', MENU).name).toBe('California');
    expect(matchPlatformItem('Bean-n-Cheese Burrito', MENU).name).toBe('Bean & Cheese');
    expect(matchPlatformItem('SURF-N-TURF BURRITO (Mar y Tierra)', MENU).name).toBe('Surf-N-Turf (Mar y Tierra)');
  });

  it('returns no match for a platform-only item rather than forcing a wrong one', () => {
    // A forced match deducts another item's ingredients — strictly worse than
    // asking the owner.
    expect(matchPlatformItem('Cochinita Burrito', MENU).menu_item_id).toBeNull();
    expect(matchPlatformItem('El Tijuana', MENU).menu_item_id).toBeNull();
    expect(matchPlatformItem('Salsa morita roja', MENU).menu_item_id).toBeNull();
  });

  it('reports how it matched, so the UI can flag the weak ones', () => {
    expect(matchPlatformItem('Cerveza', MENU).confidence).toBe('exact');
    expect(matchPlatformItem('BREAKFAST BURRITO', MENU).confidence).toBe('contains');
    expect(matchPlatformItem('Bean-n-Cheese Burrito', MENU).confidence).toBe('fuzzy');
    expect(matchPlatformItem('Cochinita Burrito', MENU).confidence).toBe('none');
  });
});

describe('fingerprintHeaders', () => {
  // The shared format registry (migration 0096) keys on this. It has to be
  // stable across MERCHANTS — Rappi ships the same columns to everyone — and
  // unstable across LAYOUTS, or one platform's mapping would answer for another.
  const RAPPI = ['ID de la orden', 'Fecha de la orden', 'Venta bruta (+)', 'Uso y Alquiler de la Plataforma (-)'];

  it('is identical for the same layout regardless of who exported it', () => {
    expect(fingerprintHeaders(RAPPI, 'settlement')).toBe(fingerprintHeaders([...RAPPI], 'settlement'));
  });

  it('ignores column order — a platform reshuffling columns is the same format', () => {
    const shuffled = [RAPPI[2], RAPPI[0], RAPPI[3], RAPPI[1]];
    expect(fingerprintHeaders(shuffled, 'settlement')).toBe(fingerprintHeaders(RAPPI, 'settlement'));
  });

  it('ignores accents and casing, which differ between portal exports', () => {
    const variant = ['ID DE LA ORDEN', 'Fecha de la órden', 'Venta bruta (+)', 'Uso y Alquiler de la Plataforma (-)'];
    expect(fingerprintHeaders(variant, 'settlement')).toBe(fingerprintHeaders(RAPPI, 'settlement'));
  });

  it('separates the two parsers, so a settlement mapping never answers for a product file', () => {
    expect(fingerprintHeaders(RAPPI, 'settlement')).not.toBe(fingerprintHeaders(RAPPI, 'products'));
  });

  it('changes when the column set changes', () => {
    expect(fingerprintHeaders([...RAPPI, 'Propinas'], 'settlement')).not.toBe(fingerprintHeaders(RAPPI, 'settlement'));
  });

  it('returns null for an empty header set rather than a hash of nothing', () => {
    expect(fingerprintHeaders([], 'settlement')).toBeNull();
    expect(fingerprintHeaders(['', '  '], 'settlement')).toBeNull();
  });
});

describe('coerceMapping (AI cold-start output)', () => {
  // The model proposes column NAMES only — never numbers. These guard the
  // boundary: anything it returns that is not a real header is dropped rather
  // than carried into the import.
  const HEADERS = ['Fecha', 'Nombre del artículo', 'Ventas con precios sin descuento', 'Ventas finales'];

  it('accepts a clean answer', () => {
    const out = coerceMapping(
      '{"business_date":"Fecha","item_name":"Nombre del artículo","quantity":null,"gross":"Ventas con precios sin descuento"}',
      'products', HEADERS
    );
    expect(out).toEqual({
      business_date: 'Fecha',
      item_name: 'Nombre del artículo',
      quantity: null,
      gross: 'Ventas con precios sin descuento',
    });
  });

  it('drops a hallucinated column instead of importing against it', () => {
    const out = coerceMapping(
      '{"business_date":"Fecha","item_name":"Producto","quantity":null,"gross":"Ventas finales"}',
      'products', HEADERS
    );
    expect(out.item_name).toBeNull();      // "Producto" is not in this file
    expect(out.gross).toBe('Ventas finales');
  });

  it('never assigns one column to two fields', () => {
    const out = coerceMapping(
      '{"business_date":"Fecha","item_name":"Fecha","quantity":"Fecha","gross":"Ventas finales"}',
      'products', HEADERS
    );
    const used = Object.values(out).filter(Boolean);
    expect(new Set(used).size).toBe(used.length);
  });

  it('tolerates prose around the JSON', () => {
    const out = coerceMapping(
      'Looking at the columns:\n{"business_date":"Fecha","item_name":"Nombre del artículo","quantity":null,"gross":null}\nHope that helps.',
      'products', HEADERS
    );
    expect(out.item_name).toBe('Nombre del artículo');
  });

  it('returns null on unusable output rather than a mapping of all-nulls', () => {
    // All-null would look like a successful detection that found nothing,
    // masking the failure. null lets the caller fall back to the heuristics.
    expect(coerceMapping('I could not determine the columns.', 'products', HEADERS)).toBeNull();
    expect(coerceMapping('{"item_name":"Nope","gross":"Also nope"}', 'products', HEADERS)).toBeNull();
    expect(coerceMapping('{ broken json', 'products', HEADERS)).toBeNull();
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
  it('expands a daily-summary row into its individual orders', async () => {
    // Guards the regression that motivated the whole daily path: writing one
    // fat order per day would report avg ticket 14x too high.
    await asTenant(tenant.id, async () => {
      const platform = await resolvePlatform('didi_food');
      const batchId = await createBatch({
        channel: 'didi_food', platform_id: platform.id, entry_mode: 'import',
        business_date: '2026-06-24', order_count: 14, gross_total: 2924,
        commission_total: 731, net_total: 2193, commission_percent: 25,
        source_filename: 'reporte-diario.xlsx', created_by: employeeId,
      });
      const totals = splitAmount(2924, 14);
      const comms = splitAmount(731, 14);
      await insertSaleOrders(
        totals.map((total: number, i: number) => ({
          total, business_date: '2026-06-24', external_order_id: null, commission: comms[i],
        })),
        { batchId, channel: 'didi_food', platformId: platform.id, employeeId, tz: 'America/Mexico_City' }
      );

      const row = await get(
        `SELECT COUNT(*)::int AS n, ROUND(SUM(total), 2)::float8 AS total,
                ROUND(AVG(total), 2)::float8 AS avg
         FROM orders WHERE manual_batch_id = $1`, [batchId]
      );
      expect(row.n).toBe(14);
      expect(row.total).toBe(2924);
      expect(row.avg).toBeCloseTo(208.86, 1); // the report's real avg ticket
    });
  });

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

describe('product-level consumption (inventory + COGS)', () => {
  // The whole point of the product import: money-per-product in, stock and
  // cost out. These check the two things that would be silently wrong —
  // deducting the recipe rather than the menu item, and failing to put it back.
  let menuItemId: number;
  let tortillaId: number;
  let carneId: number;

  beforeAll(async () => {
    await asTenant(tenant.id, async () => {
      const t = await run(
        `INSERT INTO inventory_items (tenant_id, name, unit, quantity, cost_price) VALUES ($1,$2,$3,$4,$5)`,
        [tenant.id, 'Tortilla Harina', 'pcs', 500, 2.5]
      );
      tortillaId = t.lastInsertRowid;
      const c = await run(
        `INSERT INTO inventory_items (tenant_id, name, unit, quantity, cost_price) VALUES ($1,$2,$3,$4,$5)`,
        [tenant.id, 'Carne Asada', 'kg', 40, 180]
      );
      carneId = c.lastInsertRowid;

      const cat = await run(
        `INSERT INTO menu_categories (tenant_id, name) VALUES ($1, 'Burritos')`, [tenant.id]
      );
      const mi = await run(
        `INSERT INTO menu_items (tenant_id, category_id, name, price, active) VALUES ($1,$2,$3,$4,true)`,
        [tenant.id, cat.lastInsertRowid, 'California', 250]
      );
      menuItemId = mi.lastInsertRowid;

      // One burrito = 1 tortilla ($2.50) + 0.2 kg carne ($36) => $38.50/unit.
      await run(
        `INSERT INTO menu_item_ingredients (tenant_id, menu_item_id, inventory_item_id, quantity_used) VALUES ($1,$2,$3,$4)`,
        [tenant.id, menuItemId, tortillaId, 1]
      );
      await run(
        `INSERT INTO menu_item_ingredients (tenant_id, menu_item_id, inventory_item_id, quantity_used) VALUES ($1,$2,$3,$4)`,
        [tenant.id, menuItemId, carneId, 0.2]
      );
    });
  });

  it('prices a unit from its recipe at current ingredient costs', async () => {
    await asTenant(tenant.id, async () => {
      const costs = await unitCostForMenuItems([menuItemId]);
      expect(costs.get(menuItemId)).toBeCloseTo(38.5, 2);
    });
  });

  it('reports no cost — not zero cost — for a menu item with no recipe', async () => {
    await asTenant(tenant.id, async () => {
      const cat = await get(`SELECT id FROM menu_categories WHERE name = 'Burritos'`);
      const bare = await run(
        `INSERT INTO menu_items (tenant_id, category_id, name, price, active) VALUES ($1,$2,$3,$4,true)`,
        [tenant.id, cat.id, 'Refresco', 49]
      );
      const costs = await unitCostForMenuItems([bare.lastInsertRowid]);
      // A missing recipe must be distinguishable from a free item, or the COGS
      // report quietly under-states itself.
      expect(costs.has(bare.lastInsertRowid)).toBe(false);
    });
  });

  it('deducts each ingredient by recipe x units sold', async () => {
    await asTenant(tenant.id, async () => {
      await adjustInventoryForMenuQuantities([{ menu_item_id: menuItemId, quantity: 17 }], -1);
      const t = await get('SELECT quantity FROM inventory_items WHERE id = $1', [tortillaId]);
      const c = await get('SELECT quantity FROM inventory_items WHERE id = $1', [carneId]);
      expect(Number(t.quantity)).toBeCloseTo(500 - 17, 4);      // 1 each
      expect(Number(c.quantity)).toBeCloseTo(40 - 17 * 0.2, 4); // 0.2 kg each
    });
  });

  it('restores exactly what it took when the batch is undone', async () => {
    await asTenant(tenant.id, async () => {
      await adjustInventoryForMenuQuantities([{ menu_item_id: menuItemId, quantity: 17 }], 1);
      const t = await get('SELECT quantity FROM inventory_items WHERE id = $1', [tortillaId]);
      const c = await get('SELECT quantity FROM inventory_items WHERE id = $1', [carneId]);
      expect(Number(t.quantity)).toBeCloseTo(500, 4);
      expect(Number(c.quantity)).toBeCloseTo(40, 4);
    });
  });

  it('ignores lines with no menu item instead of throwing', async () => {
    await asTenant(tenant.id, async () => {
      // Platform-only products (no POS row) reach this with menu_item_id null.
      await adjustInventoryForMenuQuantities([
        { menu_item_id: null as any, quantity: 9 },
        { menu_item_id: menuItemId, quantity: 0 },
      ], -1);
      const t = await get('SELECT quantity FROM inventory_items WHERE id = $1', [tortillaId]);
      expect(Number(t.quantity)).toBeCloseTo(500, 4);
    });
  });

  it('never drives stock negative on a deduct', async () => {
    await asTenant(tenant.id, async () => {
      await adjustInventoryForMenuQuantities([{ menu_item_id: menuItemId, quantity: 100000 }], -1);
      const t = await get('SELECT quantity FROM inventory_items WHERE id = $1', [tortillaId]);
      expect(Number(t.quantity)).toBe(0);
      // Put the fixture back for any later test in this file.
      await run('UPDATE inventory_items SET quantity = 500 WHERE id = $1', [tortillaId]);
      await run('UPDATE inventory_items SET quantity = 40 WHERE id = $1', [carneId]);
    });
  });

  it('keeps product sales inside the tenant boundary', async () => {
    const other = await createTestTenant('manualsales-c');
    try {
      await asTenant(tenant.id, async () => {
        const platform = await resolvePlatform('didi_food');
        const batchId = await createBatch({
          channel: 'didi_food', platform_id: platform.id, entry_mode: 'products',
          business_date: '2026-07-28', order_count: 0, gross_total: 2363,
          commission_total: 0, net_total: 0, commission_percent: 0, created_by: employeeId,
        });
        await run(
          `INSERT INTO platform_product_sales (tenant_id, batch_id, platform_id, business_date, platform_item_name, menu_item_id, quantity, gross, unit_cost, cogs)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [tenant.id, batchId, platform.id, '2026-07-28', 'CALIFORNIA BURRITO', menuItemId, 17, 2363, 38.5, 654.5]
        );
      });
      const mine = await asTenant(tenant.id, () => all('SELECT id FROM platform_product_sales'));
      expect(mine.length).toBeGreaterThan(0);
      const theirs = await asTenant(other.id, () => all('SELECT id FROM platform_product_sales'));
      expect(theirs).toHaveLength(0);
    } finally {
      await dropTestTenant(other.id);
    }
  });
});

describe('shared format registry', () => {
  // These exist because the registry helpers are deliberately fail-open: a
  // lookup or write that throws is swallowed so it can never block an import.
  // That is right for resilience and terrible for detection — when this
  // migration first collided with another agent's (both claimed version 96),
  // the table was never created and the whole feature silently no-op'd while
  // 76 tests stayed green. A round-trip against the real table is the only
  // thing that catches that class of failure.
  const FP = 'test-fingerprint-' + 'a'.repeat(24);

  it('has the table — a missing one would fail open and hide itself', async () => {
    await asTenant(tenant.id, async () => {
      const row = await get(
        `SELECT to_regclass('public.import_formats') IS NOT NULL AS present`
      );
      expect(row.present).toBe(true);
    });
  });

  it('round-trips a mapping so a later upload of the same layout is pre-mapped', async () => {
    await asTenant(tenant.id, async () => {
      const mapping = { gross: 'Venta Bruta', business_date: 'Fecha', commission: null };
      await recordFormat(FP, 'settlement', ['Venta Bruta', 'Fecha'], mapping, 'heuristic', 'Test');
      const hit = await lookupFormat(FP);
      expect(hit?.mapping).toEqual(mapping);
      expect(hit?.confirmed_count).toBe(1);
    });
  });

  it('lets a human correction overwrite a weaker guess, and counts both', async () => {
    await asTenant(tenant.id, async () => {
      const corrected = { gross: 'Ventas totales', business_date: 'Fecha', commission: 'Comisión' };
      await recordFormat(FP, 'settlement', ['Ventas totales', 'Fecha', 'Comisión'], corrected, 'human');
      const hit = await lookupFormat(FP);
      expect(hit?.mapping).toEqual(corrected);
      expect(hit?.source).toBe('human');
      expect(hit?.confirmed_count).toBe(2);
    });
  });

  it('does not let a weaker guess clobber a confirmed mapping', async () => {
    await asTenant(tenant.id, async () => {
      // The exact regression that would silently re-break a format for every
      // tenant: one bad heuristic run overwriting a human's correction.
      await recordFormat(FP, 'settlement', ['x'], { gross: 'WRONG', business_date: null }, 'heuristic');
      const hit = await lookupFormat(FP);
      expect(hit?.mapping.gross).toBe('Ventas totales');
      expect(hit?.source).toBe('human');
      expect(hit?.confirmed_count).toBe(3); // still counted, just not applied
    });
  });

  it('is visible across tenants — that is the whole point of the table', async () => {
    const other = await createTestTenant('manualsales-fmt');
    try {
      const seen = await asTenant(other.id, () => lookupFormat(FP));
      expect(seen?.mapping.gross).toBe('Ventas totales');
    } finally {
      await asTenant(tenant.id, () => run('DELETE FROM import_formats WHERE fingerprint = $1', [FP]));
      await dropTestTenant(other.id);
    }
  });

  it('flags a user edit so the commit path records it as human', () => {
    expect(mappingDiffers({ gross: 'A' }, { gross: 'A' })).toBe(false);
    expect(mappingDiffers({ gross: 'A' }, { gross: 'B' })).toBe(true);
    expect(mappingDiffers({ gross: 'A', net: null }, { gross: 'A' })).toBe(false);
    expect(mappingDiffers({ gross: 'A' }, { gross: 'A', net: 'N' })).toBe(true);
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
