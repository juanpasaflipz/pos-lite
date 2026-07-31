// Pure parsing helpers for manual / imported sales entry.
//
// Deliberately free of DB imports so the risky part — reading a Rappi or DiDi
// settlement export whose exact column set we have never seen — can be unit
// tested without a Postgres branch. server/routes/manual-sales.js owns the
// writes; this file owns "what does this cell mean".
//
// Header detection is a HINT, never truth: the route returns the detected
// mapping to the client for confirmation, because both portals change their
// exports without notice and a silently mis-read column would post wrong
// revenue.

import Papa from 'papaparse';
import { createHash } from 'node:crypto';

export const TAX_RATE = 0.16; // 16% IVA (Mexico) — platform prices are tax-inclusive

// ==================== Amount / date parsing ====================

/**
 * Parse a money cell out of a portal export. Handles "$1,234.56",
 * "1.234,56" (European), "(123.45)" for negatives, and bare numbers.
 * Returns 0 for anything unparseable — callers validate totals separately.
 */
export function parseAmount(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : 0;
  if (raw == null) return 0;

  let s = String(raw).trim();
  if (!s) return 0;

  const negative = /^\(.*\)$/.test(s) || s.startsWith('-');
  s = s.replace(/[()]/g, '').replace(/[^0-9.,-]/g, '').replace(/-/g, '');
  if (!s) return 0;

  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');

  if (lastComma >= 0 && lastDot >= 0) {
    // Both present — whichever comes last is the decimal separator.
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (lastComma >= 0) {
    // Only commas. "1,234" is thousands; "1,23" is decimal.
    const tail = s.length - lastComma - 1;
    if (tail === 3 && s.indexOf(',') === lastComma && s.length > 4) s = s.replace(/,/g, '');
    else if (tail === 3) s = s.replace(/,/g, '');
    else s = s.replace(',', '.');
  }

  const n = parseFloat(s);
  if (!Number.isFinite(n)) return 0;
  return negative ? -n : n;
}

// Abbreviated month names, Spanish and English. Keyed on the first 3-4 letters
// so "sep", "sept", "sepr" and "september" all land on the same month.
const MONTH_ABBR = {
  ene: '01', jan: '01', feb: '02', mar: '03', abr: '04', apr: '04',
  may: '05', jun: '06', jul: '07', ago: '08', aug: '08',
  sep: '09', sept: '09', oct: '10', nov: '11', dic: '12', dec: '12',
};

/**
 * Coerce a portal date cell to YYYY-MM-DD. Handles ISO, "DD/MM/YYYY" (the
 * Mexican convention both portals use), "YYYY/MM/DD", and Excel serial dates
 * (exceljs hands back a Date, but a CSV round-trip can leave the serial).
 */
export function parseBusinessDate(raw) {
  if (raw == null) return null;
  if (raw instanceof Date && !isNaN(raw.getTime())) {
    return raw.toISOString().slice(0, 10);
  }

  const s = String(raw).trim();
  if (!s) return null;

  const iso = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;

  // DD/MM/YYYY or DD-MM-YYYY. Day-first: both portals are es-MX.
  const dmy = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;

  // "jue. 25 jun. 2026, 1:08:47 p. m." — Rappi's Detalle tab writes dates as
  // localized long form with an abbreviated day and month name. Match on the
  // DD MON YYYY core and ignore the day name and clock time entirely.
  const named = normalizeHeader(s).match(/(?:^|\s)(\d{1,2})\s+([a-z]{3,10})\.?\s+(\d{4})/);
  if (named) {
    const mon = MONTH_ABBR[named[2].slice(0, 4)] ?? MONTH_ABBR[named[2].slice(0, 3)];
    if (mon) return `${named[3]}-${mon}-${named[1].padStart(2, '0')}`;
  }

  // Compact YYYYMMDD — DiDi's settlement receipt writes "20260724".
  const compact = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) {
    const [, y, mo, d] = compact;
    if (+mo >= 1 && +mo <= 12 && +d >= 1 && +d <= 31) return `${y}-${mo}-${d}`;
  }

  // Excel serial (days since 1899-12-30).
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const ms = (parseFloat(s) - 25569) * 86400000;
    const d = new Date(ms);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }

  const parsed = new Date(s);
  if (!isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return null;
}

export const isValidDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s).getTime());

// ==================== Column detection ====================

export const normalizeHeader = (h) => String(h ?? '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Candidate header names per logical field, best match first. Sourced from
// Rappi's published "Relación de ventas" data dictionary and DiDi's merchant
// "ganancias" column list — but treated as hints, not truth: detection is
// returned to the client for confirmation because neither real file has been
// inspected end-to-end and both portals change columns without notice.
const COLUMN_CANDIDATES = {
  // Field order matters: detection claims columns first-come, so the most
  // specific fields run before the loosest ('gross' ends with 'total', which
  // would otherwise steal a column a narrower field wanted).
  external_order_id: [
    'id de la orden', 'id de la order', 'id orden', 'id del pedido', 'id de pedido',
    'numero de pedido', 'no de pedido', 'folio', 'order id', 'order number',
    // NOTE: bare 'id' was deliberately removed. On DiDi's daily operations
    // report it matched "Núm. de id. de la tienda" — the STORE id, identical
    // on every row — which would have collapsed the whole file to one
    // deduped order. A wrong order id is worse than no order id.
  ],
  business_date: [
    'fecha de la orden', 'fecha del pedido', 'fecha de facturacion', 'fecha de creacion',
    'fecha de entrega', 'fecha de pago', 'fecha', 'order date', 'date', 'created at',
  ],
  // Presence of this column is what marks a file as one-row-per-DAY rather
  // than one-row-per-order (DiDi's "Reporte diario de operaciones").
  order_count: [
    'pedidos validos', 'pedidos completados', 'total de pedidos', 'numero de pedidos',
    'cantidad de pedidos', 'ordenes completadas', 'valid orders', 'order count',
    'ordenes', 'orders',
  ],
  avg_ticket: [
    'valor promedio de un pedido', 'valor promedio del pedido', 'ticket promedio',
    'average order value', 'avg order value',
  ],
  gross: [
    'venta bruta', 'precio total del producto sin promocion', 'ganancias diarias promedio',
    'precio original del producto', 'valor bruto', 'ventas totales', 'total de la orden',
    'subtotal de productos', 'importe total', 'gross sales', 'gross', 'importe', 'total',
  ],
  commission: [
    // 'comision y distribucion' must lead: on DiDi's settlement receipt the
    // looser 'tarifa de servicio' substring-matches "Tarifa de servicio de
    // penalización" — the penalty column, not the commission.
    // Rappi's Detalle tab writes "Uso y alquiler de plataforma Rappi" (no
    // "la"), and the sheet also carries "Ventas base por Uso y alquiler...",
    // "...Prime" and "IVA Uso y alquiler..." — so the exact form must lead or
    // a substring match grabs the sales base instead of the fee.
    'comision y distribucion', 'uso y alquiler de plataforma rappi',
    'uso y alquiler de la plataforma', 'uso y alquiler de plataforma',
    'tarifa de servicio', 'comision de la plataforma', 'comision',
    'tarifa transaccional', 'service fee', 'commission',
  ],
  // Platforms that charge commission and hand it straight back during a
  // promo period. DiDi's "Premio de comisión ... para la tienda" cancels
  // "Comisión y distribución" to within a few centavos — booking the gross
  // commission without this would invent a ~25% cost that was never charged.
  commission_rebate: [
    'premio de comision', 'bonificacion de comision', 'reembolso de comision',
    'commission rebate', 'commission credit',
  ],
  net: [
    'monto de facturacion', 'valor a transferir', 'ganancias por pedidos',
    'valor neto', 'total a depositar', 'neto', 'net payout', 'net',
  ],
};

/**
 * Guess which spreadsheet column feeds which logical field. Exact normalized
 * match wins; then "header contains candidate"; then "candidate contains
 * header". Never guesses the same column for two fields.
 */
export function detectMapping(headers) {
  const norm = headers.map(normalizeHeader);
  const mapping = {};
  const taken = new Set();

  for (const [field, candidates] of Object.entries(COLUMN_CANDIDATES)) {
    let hit = -1;
    for (const cand of candidates) {
      const c = normalizeHeader(cand);
      hit = norm.findIndex((h, i) => !taken.has(i) && h === c);
      if (hit >= 0) break;
      hit = norm.findIndex((h, i) => !taken.has(i) && h.includes(c));
      if (hit >= 0) break;
      hit = norm.findIndex((h, i) => !taken.has(i) && h.length > 3 && c.includes(h));
      if (hit >= 0) break;
    }
    if (hit >= 0) {
      mapping[field] = headers[hit];
      taken.add(hit);
    } else {
      mapping[field] = null;
    }
  }
  return mapping;
}

// ==================== File parsing ====================

/**
 * Choose which sheet actually holds the records.
 *
 * Rappi's "Relación de ventas" ships five sheets and the FIRST one is
 * "Indice" — a 129-row data dictionary. Blindly taking worksheets[0] parsed
 * the glossary and imported nothing. Score on data volume (rows x columns,
 * since a glossary is tall and narrow while a detail tab is wide), then bias
 * by sheet name.
 */
function pickDataSheet(worksheets) {
  const PREFER = /(detalle|detail|orden|order|pedido|transaccion|transaction|resumen diario|daily)/;
  const AVOID = /(indice|index|glosario|diccionario|definicion|instruccion|readme|portada|cover)/;

  let best = 0;
  let bestScore = -1;
  worksheets.forEach((w, i) => {
    const rows = Math.max(0, (w.actualRowCount ?? w.rowCount ?? 0) - 1);
    const cols = w.actualColumnCount ?? w.columnCount ?? 0;
    if (!rows || !cols) return;
    const name = normalizeHeader(w.name);
    let score = rows * Math.min(cols, 60);
    if (PREFER.test(name)) score *= 3;
    if (AVOID.test(name)) score *= 0.1;
    if (score > bestScore) { bestScore = score; best = i; }
  });
  return best;
}

/**
 * Make a header list safe to use as object keys.
 *
 * Real exports repeat header names — DiDi's daily operations report has TWO
 * columns literally called "Ganancias diarias promedio" (the first is gross,
 * the second is net-of-promo). Building row objects from those raw names makes
 * the LAST duplicate silently win, which read that file 26% low while looking
 * completely plausible. Duplicates get a " (2)", " (3)" suffix so both columns
 * survive and the user can pick between them.
 */
function uniquifyHeaders(cells) {
  const seen = new Map();
  return cells.map((h, i) => {
    const base = (h == null || String(h).trim() === '') ? `col_${i + 1}` : String(h).trim();
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base} (${n + 1})`;
  });
}

/**
 * Locate the real header row.
 *
 * "First row with 2+ non-empty cells" is not enough: DiDi's settlement receipt
 * opens with a sparse GROUP header ("Ingresos por ventas", "Impuestos", …)
 * spanning merged columns, with the actual column names on row 2. Taking row 1
 * made every real header get read as data and the file parsed to nothing.
 *
 * So: among the first few rows, take the densest one, earliest wins on a tie.
 * A group header is by construction sparser than the header it spans, while a
 * normal single-header file ties with its data rows and keeps row 0.
 */
function findHeaderRow(matrix) {
  const LOOKAHEAD = 5;
  const density = (r) => r.filter((c) => c != null && String(c).trim() !== '').length;
  let best = -1;
  let bestDensity = 1; // require 2+ non-empty cells to qualify
  for (let i = 0; i < Math.min(LOOKAHEAD, matrix.length); i++) {
    const d = density(matrix[i]);
    if (d > bestDensity) { best = i; bestDensity = d; }
  }
  return best;
}

function matrixToRows(matrix) {
  const headerIdx = findHeaderRow(matrix);
  if (headerIdx < 0) {
    throw Object.assign(new Error('Could not find a header row in that file.'), { statusCode: 400 });
  }
  const headers = uniquifyHeaders(matrix[headerIdx]);
  const rows = matrix.slice(headerIdx + 1)
    .filter((r) => r.some((c) => c != null && String(c).trim() !== ''))
    .map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
  return { headers, rows };
}

/**
 * Turn an uploaded buffer into { headers, rows } of raw cell values.
 * CSV/TSV parses natively via papaparse. XLSX needs `exceljs`, which is
 * imported dynamically: if the dependency isn't installed the endpoint returns
 * an actionable 400 (save-as-CSV) instead of a 500, and the XLSX path lights
 * up on its own once `npm install exceljs` lands.
 *
 * Both formats go through matrixToRows so duplicate-header handling and
 * title-row skipping behave identically either way.
 */
export async function parseUpload(buffer, filename, sheetName = null) {
  const isZip = buffer.length > 1 && buffer[0] === 0x50 && buffer[1] === 0x4b; // 'PK' -> xlsx
  const looksXlsx = isZip || /\.xlsx?$/i.test(filename || '');

  if (looksXlsx) {
    let ExcelJS;
    try {
      ExcelJS = (await import('exceljs')).default;
    } catch {
      throw Object.assign(
        new Error('XLSX support is not installed on this server yet. Open the file in Excel / Numbers / Google Sheets and export it as CSV, then upload that.'),
        { statusCode: 400 }
      );
    }
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(buffer);
    } catch {
      // ExcelJS throws bare Errors on truncated / corrupt archives; wrap so
      // the route returns a 400 with an actionable message rather than a 500.
      throw Object.assign(
        new Error('That file is not a readable spreadsheet. Re-download and try again, or save it as CSV.'),
        { statusCode: 400 }
      );
    }
    if (!wb.worksheets.length) {
      throw Object.assign(new Error('That spreadsheet has no sheets.'), { statusCode: 400 });
    }

    const sheets = wb.worksheets.map((w) => w.name);
    const ws = sheetName
      ? wb.worksheets.find((w) => w.name === sheetName)
      : wb.worksheets[pickDataSheet(wb.worksheets)];
    if (!ws) {
      throw Object.assign(
        new Error(`That workbook has no sheet named "${sheetName}". Available: ${sheets.join(', ')}`),
        { statusCode: 400 }
      );
    }

    const matrix = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const vals = [];
      row.eachCell({ includeEmpty: true }, (cell) => {
        const v = cell.value;
        if (v && typeof v === 'object' && 'result' in v) vals.push(v.result);
        else if (v && typeof v === 'object' && 'text' in v) vals.push(v.text);
        else vals.push(v);
      });
      matrix.push(vals);
    });
    return { ...matrixToRows(matrix), sheets, sheet: ws.name };
  }

  const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  // header:false + our own header handling, so CSV and XLSX share one code
  // path (papaparse's header mode collapses duplicate names).
  const parsed = Papa.parse(text, { header: false, skipEmptyLines: 'greedy', dynamicTyping: false });
  const matrix = (parsed.data || []).filter((r) => Array.isArray(r));
  if (!matrix.length) {
    throw Object.assign(new Error('Could not read any rows from that file.'), { statusCode: 400 });
  }
  return { ...matrixToRows(matrix), sheets: [], sheet: null };
}

/**
 * Apply a mapping to raw rows -> normalized sale rows.
 *
 * A row carries `order_count`. It is 1 for a per-order file, and the day's
 * real order count for a daily-summary file (DiDi's operations report). The
 * caller fans each row out into that many orders — importing a 248-order month
 * as 24 day-rows would report a $1,646 average ticket instead of $159 and
 * wreck the break-even calculator.
 */
export function normalizeRows(rows, mapping, fallbackDate) {
  const out = [];
  const skipped = [];

  rows.forEach((raw, i) => {
    const rowNo = i + 2; // 1-indexed, +1 for the header row

    const count = mapping.order_count
      ? Math.max(0, Math.round(parseAmount(raw[mapping.order_count])))
      : null;

    let gross = mapping.gross ? parseAmount(raw[mapping.gross]) : 0;
    const avg = mapping.avg_ticket ? parseAmount(raw[mapping.avg_ticket]) : 0;
    // Daily reports sometimes carry avg ticket but no gross column.
    if (!(gross > 0) && avg > 0 && count > 0) gross = Math.round(avg * count * 100) / 100;

    let commission = mapping.commission ? Math.abs(parseAmount(raw[mapping.commission])) : null;
    // A rebate column cancels part (often all) of the headline commission.
    if (commission != null && mapping.commission_rebate) {
      const rebate = Math.abs(parseAmount(raw[mapping.commission_rebate]));
      commission = Math.max(0, Math.round((commission - rebate) * 100) / 100);
    }
    const net = mapping.net ? parseAmount(raw[mapping.net]) : null;
    const date = (mapping.business_date ? parseBusinessDate(raw[mapping.business_date]) : null) || fallbackDate;
    // Numeric order ids come back as floats ("2452095771.0"); keep the id
    // stable so re-imports dedup against the same string.
    const extId = mapping.external_order_id
      ? String(raw[mapping.external_order_id] ?? '').trim().replace(/^(\d+)\.0+$/, '$1')
      : '';

    // A daily file's closed/zero days are normal, not errors.
    if (mapping.order_count && !(count > 0)) { skipped.push({ row: rowNo, reason: 'no orders that day' }); return; }
    if (!(gross > 0)) { skipped.push({ row: rowNo, reason: 'no positive gross amount' }); return; }
    if (!isValidDate(date)) { skipped.push({ row: rowNo, reason: 'unreadable date' }); return; }

    out.push({
      // One external id cannot identify N orders, so a daily row carries none.
      external_order_id: (count != null && count > 1) ? null : (extId || null),
      business_date: date,
      order_count: count != null ? count : 1,
      gross: Math.round(gross * 100) / 100,
      // Preserve a real 0 when the column was mapped — a promo-period Rappi
      // row genuinely carries 0 commission, and collapsing that to null makes
      // the commit path fall back to the platform default (25%) and book a
      // charge the platform never made. Only leave commission null when the
      // column wasn't mapped at all.
      commission: mapping.commission ? (commission != null ? Math.round(commission * 100) / 100 : 0) : null,
      net: net != null && net !== 0 ? Math.round(net * 100) / 100 : null,
    });
  });

  return { rows: out, skipped };
}

export function splitAmount(total, count) {
  const cents = Math.round(total * 100);
  const base = Math.floor(cents / count);
  const extra = cents - base * count;
  return Array.from({ length: count }, (_, i) => (base + (i < extra ? 1 : 0)) / 100);
}

// ==================== Format fingerprinting ====================

/**
 * Stable identity for a file LAYOUT, independent of which merchant exported it.
 *
 * Rappi's "Relación de ventas" ships the same 71 columns to every restaurant in
 * Mexico, so the same normalized header set must hash identically no matter
 * whose file it is — that is what lets one tenant's confirmed mapping serve
 * everyone else (see migration 0096).
 *
 * Sorted, so a platform reordering its columns without renaming them still
 * matches. Normalized, so accents and casing don't fork the entry. `kind` is
 * folded in because the settlement and product parsers map to different
 * logical fields and must never share a mapping.
 *
 * Header NAMES only — never cell values. The registry is shared across
 * tenants and must not carry merchant data.
 */
export function fingerprintHeaders(headers, kind) {
  const normalized = (headers || [])
    .map(normalizeHeader)
    .filter(Boolean)
    .sort();
  if (!normalized.length) return null;
  return createHash('sha256')
    .update(`${kind}\n${normalized.join(' ')}`)
    .digest('hex');
}

// ==================== Product-level reports ====================
//
// A different file shape from the settlement/operations exports above: one row
// per (date x product), e.g. DiDi's "Reporte diario de productos". This is the
// only export either platform publishes that can feed inventory and COGS.
//
// It does NOT feed revenue — see migration 0095 for why (the settlement import
// already booked that money; counting it twice is the failure mode).

const PRODUCT_COLUMN_CANDIDATES = {
  // Most specific first — detection claims columns first-come.
  business_date: [
    'fecha de la orden', 'fecha del pedido', 'fecha de venta', 'fecha', 'order date', 'date',
  ],
  item_name: [
    'nombre del articulo', 'nombre del producto', 'nombre de producto', 'nombre del item',
    'articulo', 'producto', 'item name', 'product name', 'menu item', 'item', 'product',
    // NOTE: bare 'nombre' is deliberately absent. DiDi's product report also
    // carries "Nombre de la tienda" and "Nombre del firmante", both constant on
    // every row — matching either collapses the whole file to one product.
  ],
  // Some platforms do publish a real count. When present it wins outright and
  // no price derivation is needed.
  quantity: [
    'cantidad vendida', 'unidades vendidas', 'articulos vendidos', 'productos vendidos',
    'cantidad', 'unidades', 'units sold', 'quantity sold', 'quantity', 'units', 'qty',
  ],
  gross: [
    // 'sin descuento' must lead: it is list-price x quantity, which divides
    // cleanly by the unit price. 'Ventas finales' is net of per-order discounts
    // and does NOT, so deriving quantity from it yields fractions.
    'ventas con precios sin descuento', 'precio total del producto sin promocion',
    'precio original del producto', 'ventas brutas del producto', 'venta bruta',
    'ventas finales', 'ventas totales', 'ventas', 'importe', 'total',
  ],
};

/** Same matching rules as detectMapping, over the product-report field set. */
export function detectProductMapping(headers) {
  const norm = headers.map(normalizeHeader);
  const mapping = {};
  const taken = new Set();

  for (const [field, candidates] of Object.entries(PRODUCT_COLUMN_CANDIDATES)) {
    let hit = -1;
    for (const cand of candidates) {
      const c = normalizeHeader(cand);
      hit = norm.findIndex((h, i) => !taken.has(i) && h === c);
      if (hit >= 0) break;
      hit = norm.findIndex((h, i) => !taken.has(i) && h.includes(c));
      if (hit >= 0) break;
      hit = norm.findIndex((h, i) => !taken.has(i) && h.length > 3 && c.includes(h));
      if (hit >= 0) break;
    }
    if (hit >= 0) {
      mapping[field] = headers[hit];
      taken.add(hit);
    } else {
      mapping[field] = null;
    }
  }
  return mapping;
}

/** Accent/case-folded key used to match a platform product name across imports. */
export const normProductName = (s) => String(s ?? '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Apply a product mapping to raw rows, collapsing to one entry per
 * (business_date, product). A platform can emit the same product twice on one
 * day (per store, per channel); summing is correct, taking the last is not.
 */
export function aggregateProductRows(rows, mapping, fallbackDate) {
  const byKey = new Map();
  const skipped = [];

  rows.forEach((raw, i) => {
    const rowNo = i + 2; // 1-indexed, +1 for the header row
    const name = mapping.item_name ? String(raw[mapping.item_name] ?? '').trim() : '';
    const date = (mapping.business_date ? parseBusinessDate(raw[mapping.business_date]) : null) || fallbackDate;
    const gross = mapping.gross ? parseAmount(raw[mapping.gross]) : 0;
    const qty = mapping.quantity ? parseAmount(raw[mapping.quantity]) : null;

    if (!name) { skipped.push({ row: rowNo, reason: 'no product name' }); return; }
    if (!isValidDate(date)) { skipped.push({ row: rowNo, reason: 'unreadable date' }); return; }
    // A zero-gross row with no quantity carries no information at all. This is
    // the free-modifier case (DiDi bills salsas at 0.00) — not an error.
    if (!(gross > 0) && !(qty > 0)) { skipped.push({ row: rowNo, reason: 'no sales and no quantity', item_name: name }); return; }

    const key = `${date}::${normProductName(name)}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.gross = Math.round((existing.gross + gross) * 100) / 100;
      if (qty != null) existing.quantity = (existing.quantity ?? 0) + qty;
    } else {
      byKey.set(key, {
        business_date: date,
        platform_item_name: name,
        norm_name: normProductName(name),
        gross: Math.round(gross * 100) / 100,
        quantity: qty != null && qty > 0 ? qty : null,
      });
    }
  });

  const out = [...byKey.values()].sort((a, b) =>
    (a.business_date < b.business_date ? 1 : a.business_date > b.business_date ? -1 : 0)
    || a.platform_item_name.localeCompare(b.platform_item_name));

  return { rows: out, skipped };
}

const QTY_TOLERANCE = 0.02; // 2% — absorbs rounding in the platform's own totals
const MAX_UNITS_PER_DAY = 60;

/** Is every gross value an integer multiple of `price`, within tolerance? */
function divisesCleanly(values, price) {
  if (!(price > 0)) return false;
  return values.every((v) => {
    const units = v / price;
    if (units < 0.98) return false;
    return Math.abs(units - Math.round(units)) <= QTY_TOLERANCE * Math.max(1, Math.round(units));
  });
}

/**
 * Infer the platform's list price for a product from its gross figures.
 *
 * The report gives money, not units, so the unit price is what turns one into
 * the other. Every exact divisor of the observed grosses is mathematically
 * valid ($516 and $258 divide by 258, 129, 86, 64.5 …), so the POS price is
 * used as an anchor: delivery menus are marked UP, never down, so the answer is
 * the SMALLEST valid divisor at or above the POS price. That picks $129 for a
 * $99 POS item — verified against a real juanbertos DiDi export, where it also
 * recovers $180 Breakfast, $250 California and $230 Porkbelly exactly.
 *
 * With no POS anchor (a platform-only item) it falls back to the largest valid
 * divisor, which is right when the product has several distinct daily totals to
 * constrain it and a guess when it has one. Either way the caller shows the
 * resulting quantity for confirmation — this is a suggestion, never a silent
 * decision.
 *
 * @returns {{ price: number, basis: 'pos_anchor'|'divisor'|'single' } | null}
 */
export function suggestPlatformPrice(grossValues, posPrice = null) {
  const values = (grossValues || []).filter((v) => v > 0);
  if (!values.length) return null;

  const gMin = Math.min(...values);
  const valid = [];
  for (let n = 1; n <= MAX_UNITS_PER_DAY; n++) {
    const p = Math.round((gMin / n) * 100) / 100;
    if (!(p > 0)) break;
    if (divisesCleanly(values, p)) valid.push(p);
  }
  if (!valid.length) return null;

  if (posPrice > 0) {
    // 0.99 slack so an unmarked-up item whose platform price rounds a cent
    // below the POS price still anchors to itself.
    const atOrAbove = valid.filter((p) => p >= posPrice * 0.99).sort((a, b) => a - b);
    if (atOrAbove.length) return { price: atOrAbove[0], basis: 'pos_anchor' };
  }

  const largest = valid.sort((a, b) => b - a)[0];
  return { price: largest, basis: values.length > 1 ? 'divisor' : 'single' };
}

/**
 * Quantity for one product-day. An explicit quantity column always wins; only
 * when the file has none is it derived from gross / platform price.
 *
 * `exact` is false when the division did not land on a whole number — the
 * price is probably wrong (or the day carried a discount), and the caller
 * surfaces it rather than silently deducting a bad quantity from stock.
 */
export function deriveQuantity({ gross, quantity, platform_price }) {
  if (quantity != null && quantity > 0) {
    return { quantity: Math.round(quantity), exact: true, source: 'column' };
  }
  if (!(platform_price > 0) || !(gross > 0)) {
    return { quantity: null, exact: false, source: 'none' };
  }
  const raw = gross / platform_price;
  const rounded = Math.round(raw);
  if (rounded < 1) return { quantity: null, exact: false, source: 'derived' };
  const drift = Math.abs(raw - rounded) / rounded;
  return { quantity: rounded, exact: drift <= QTY_TOLERANCE, source: 'derived' };
}
