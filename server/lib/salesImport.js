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
    'comision y distribucion', 'uso y alquiler de la plataforma', 'tarifa de servicio',
    'comision de la plataforma', 'comision', 'tarifa transaccional',
    'service fee', 'commission',
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
export async function parseUpload(buffer, filename) {
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
    await wb.xlsx.load(buffer);
    const ws = wb.worksheets[0];
    if (!ws) throw Object.assign(new Error('That spreadsheet has no sheets.'), { statusCode: 400 });

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
    return matrixToRows(matrix);
  }

  const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  // header:false + our own header handling, so CSV and XLSX share one code
  // path (papaparse's header mode collapses duplicate names).
  const parsed = Papa.parse(text, { header: false, skipEmptyLines: 'greedy', dynamicTyping: false });
  const matrix = (parsed.data || []).filter((r) => Array.isArray(r));
  if (!matrix.length) {
    throw Object.assign(new Error('Could not read any rows from that file.'), { statusCode: 400 });
  }
  return matrixToRows(matrix);
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
    const extId = mapping.external_order_id ? String(raw[mapping.external_order_id] ?? '').trim() : '';

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
      commission: commission != null && commission > 0 ? Math.round(commission * 100) / 100 : null,
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
