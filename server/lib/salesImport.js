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
  external_order_id: [
    'id de la orden', 'id de la order', 'id orden', 'id del pedido', 'id de pedido',
    'numero de pedido', 'no de pedido', 'folio', 'order id', 'order number', 'id',
  ],
  business_date: [
    'fecha de la orden', 'fecha del pedido', 'fecha de creacion', 'fecha de entrega',
    'fecha de pago', 'fecha', 'order date', 'date', 'created at',
  ],
  gross: [
    'venta bruta', 'precio original del producto', 'valor bruto', 'total de la orden',
    'subtotal de productos', 'importe total', 'total', 'importe', 'gross sales', 'gross',
  ],
  commission: [
    'uso y alquiler de la plataforma', 'tarifa de servicio', 'comision de la plataforma',
    'comision', 'tarifa transaccional', 'service fee', 'commission',
  ],
  net: [
    'valor a transferir', 'ganancias por pedidos', 'valor neto', 'total a depositar',
    'neto', 'net payout', 'net',
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
 * Turn an uploaded buffer into { headers, rows } of raw cell values.
 * CSV/TSV parses natively via papaparse. XLSX needs `exceljs`, which is
 * imported dynamically: if the dependency isn't installed the endpoint returns
 * an actionable 400 (save-as-CSV) instead of a 500, and the XLSX path lights
 * up on its own once `npm install exceljs` lands.
 */
export async function parseUpload(buffer, filename) {
  const isZip = buffer.length > 1 && buffer[0] === 0x50 && buffer[1] === 0x4b; // 'PK' → xlsx
  const looksXlsx = isZip || /\.xlsx?$/i.test(filename || '');

  if (looksXlsx) {
    let ExcelJS;
    try {
      ExcelJS = (await import('exceljs')).default;
    } catch {
      const err = new Error(
        'XLSX support is not installed on this server yet. Open the file in Excel / Numbers / Google Sheets and export it as CSV, then upload that.'
      );
      err.statusCode = 400;
      throw err;
    }
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = wb.worksheets[0];
    if (!ws) throw Object.assign(new Error('The spreadsheet has no sheets.'), { statusCode: 400 });

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

    // Header row = first row with 2+ non-empty cells (portals like a title row).
    const headerIdx = matrix.findIndex((r) => r.filter((c) => c != null && String(c).trim() !== '').length >= 2);
    if (headerIdx < 0) throw Object.assign(new Error('Could not find a header row in the spreadsheet.'), { statusCode: 400 });

    const headers = matrix[headerIdx].map((h, i) => (h == null || String(h).trim() === '' ? `col_${i + 1}` : String(h).trim()));
    const rows = matrix.slice(headerIdx + 1)
      .filter((r) => r.some((c) => c != null && String(c).trim() !== ''))
      .map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
    return { headers, rows };
  }

  const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  const parsed = Papa.parse(text, { header: true, skipEmptyLines: 'greedy', dynamicTyping: false });
  const headers = (parsed.meta?.fields || []).map((h) => String(h).trim());
  if (!headers.length) throw Object.assign(new Error('Could not read any columns from that file.'), { statusCode: 400 });
  return { headers, rows: parsed.data || [] };
}

/** Apply a mapping to raw rows → normalized sale rows. */
export function normalizeRows(rows, mapping, fallbackDate) {
  const out = [];
  const skipped = [];

  rows.forEach((raw, i) => {
    const gross = mapping.gross ? parseAmount(raw[mapping.gross]) : 0;
    const commission = mapping.commission ? Math.abs(parseAmount(raw[mapping.commission])) : null;
    const net = mapping.net ? parseAmount(raw[mapping.net]) : null;
    const date = (mapping.business_date ? parseBusinessDate(raw[mapping.business_date]) : null) || fallbackDate;
    const extId = mapping.external_order_id ? String(raw[mapping.external_order_id] ?? '').trim() : '';

    if (!(gross > 0)) { skipped.push({ row: i + 2, reason: 'no positive gross amount' }); return; }
    if (!isValidDate(date)) { skipped.push({ row: i + 2, reason: 'unreadable date' }); return; }

    out.push({
      external_order_id: extId || null,
      business_date: date,
      gross: Math.round(gross * 100) / 100,
      commission: commission != null && commission > 0 ? Math.round(commission * 100) / 100 : null,
      net: net != null && net !== 0 ? Math.round(net * 100) / 100 : null,
    });
  });

  return { rows: out, skipped };
}

/**
 * Split `total` into `count` parts that sum back to `total` exactly.
 * Remainder cents ride on the first parts, so no penny evaporates.
 */
export function splitAmount(total, count) {
  const cents = Math.round(total * 100);
  const base = Math.floor(cents / count);
  const extra = cents - base * count;
  return Array.from({ length: count }, (_, i) => (base + (i < extra ? 1 : 0)) / 100);
}
