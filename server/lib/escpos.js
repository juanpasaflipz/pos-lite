/**
 * Minimal ESC/POS ticket renderer for 80mm thermal printers (42 cols, Font A).
 * Targets Epson-ESC/POS-compatible printers (tested layout: GHIA GTP801).
 *
 * No dependencies. Produces a Buffer ready to be written to the printer
 * (raw TCP port 9100, USB pipe, etc.). Text is encoded as CP850 so Spanish
 * accents (á é í ó ú ñ ¿ ¡) print correctly.
 */

const COLS = 42; // 80mm paper, Font A

// ==================== CP850 encoding ====================

const CP850 = {
  'ü': 0x81, 'é': 0x82, 'â': 0x83, 'ä': 0x84, 'à': 0x85, 'ç': 0x87,
  'ê': 0x88, 'ë': 0x89, 'è': 0x8a, 'ï': 0x8b, 'î': 0x8c, 'ì': 0x8d,
  'Ä': 0x8e, 'É': 0x90, 'ô': 0x93, 'ö': 0x94, 'ò': 0x95, 'û': 0x96,
  'ù': 0x97, 'Ö': 0x99, 'Ü': 0x9a, 'á': 0xa0, 'í': 0xa1, 'ó': 0xa2,
  'ú': 0xa3, 'ñ': 0xa4, 'Ñ': 0xa5, 'ª': 0xa6, 'º': 0xa7, '¿': 0xa8,
  '¡': 0xad, 'Á': 0xb5, 'Â': 0xb6, 'À': 0xb7, 'Ê': 0xd2, 'Ë': 0xd3,
  'È': 0xd4, 'Í': 0xd6, 'Î': 0xd7, 'Ï': 0xd8, 'Ì': 0xde, 'Ó': 0xe0,
  'Ô': 0xe2, 'Ò': 0xe3, 'Ú': 0xe9, 'Û': 0xea, 'Ù': 0xeb, '°': 0xf8,
  '·': 0xfa, '€': 0xee, // 0xee is dotless i in strict CP850; many clones map €. Harmless fallback.
};

function encodeCP850(str) {
  const bytes = [];
  for (const ch of String(str)) {
    const code = ch.codePointAt(0);
    if (code < 0x80) {
      bytes.push(code);
    } else if (CP850[ch] !== undefined) {
      bytes.push(CP850[ch]);
    } else {
      bytes.push(0x3f); // '?'
    }
  }
  return Buffer.from(bytes);
}

// ==================== ESC/POS primitives ====================

const ESC = 0x1b;
const GS = 0x1d;

const CMD = {
  INIT: Buffer.from([ESC, 0x40]),               // ESC @  — reset
  CODEPAGE_850: Buffer.from([ESC, 0x74, 0x02]), // ESC t 2 — PC850
  ALIGN_LEFT: Buffer.from([ESC, 0x61, 0x00]),
  ALIGN_CENTER: Buffer.from([ESC, 0x61, 0x01]),
  BOLD_ON: Buffer.from([ESC, 0x45, 0x01]),
  BOLD_OFF: Buffer.from([ESC, 0x45, 0x00]),
  SIZE_NORMAL: Buffer.from([GS, 0x21, 0x00]),
  SIZE_DOUBLE_H: Buffer.from([GS, 0x21, 0x01]), // double height
  SIZE_DOUBLE: Buffer.from([GS, 0x21, 0x11]),   // double width + height
  FEED_3: Buffer.from([ESC, 0x64, 0x03]),
  CUT_PARTIAL: Buffer.from([GS, 0x56, 0x42, 0x00]), // feed + partial cut
  BEEP: Buffer.from([ESC, 0x42, 0x02, 0x02]),   // buzzer x2 (supported on many kitchen printers, ignored otherwise)
  LF: Buffer.from([0x0a]),
};

class TicketBuilder {
  constructor() {
    this.parts = [CMD.INIT, CMD.CODEPAGE_850];
  }
  raw(buf) { this.parts.push(buf); return this; }
  text(str) { this.parts.push(encodeCP850(str), CMD.LF); return this; }
  blank(n = 1) { for (let i = 0; i < n; i++) this.parts.push(CMD.LF); return this; }
  line(char = '-') { return this.text(char.repeat(COLS)); }
  center() { return this.raw(CMD.ALIGN_CENTER); }
  left() { return this.raw(CMD.ALIGN_LEFT); }
  bold(on = true) { return this.raw(on ? CMD.BOLD_ON : CMD.BOLD_OFF); }
  size(mode = 'normal') {
    const m = { normal: CMD.SIZE_NORMAL, tall: CMD.SIZE_DOUBLE_H, big: CMD.SIZE_DOUBLE };
    return this.raw(m[mode] || CMD.SIZE_NORMAL);
  }
  cut() { return this.raw(CMD.FEED_3).raw(CMD.CUT_PARTIAL); }
  beep() { return this.raw(CMD.BEEP); }
  build() { return Buffer.concat(this.parts); }
}

// ==================== Helpers ====================

/** Word-wrap a string to a given width, returning an array of lines. */
function wrap(str, width = COLS) {
  const words = String(str).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (!cur.length) { cur = w; continue; }
    if (cur.length + 1 + w.length <= width) cur += ' ' + w;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

/** Two-column line: left-pad right text to the end of the row. */
function twoCol(left, right, width = COLS) {
  left = String(left); right = String(right);
  const space = width - left.length - right.length;
  if (space < 1) return left + ' ' + right;
  return left + ' '.repeat(space) + right;
}

const SOURCE_LABELS = {
  didi_food: 'DIDI FOOD',
  rappi: 'RAPPI',
  uber_eats: 'UBER EATS',
  pos: 'MOSTRADOR',
  customer_qr: 'CLIENTE QR',
};

function formatTime(date) {
  return new Date(date).toLocaleString('es-MX', {
    timeZone: process.env.RESTAURANT_TZ || 'America/Mexico_City',
    day: '2-digit', month: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

// ==================== Public builders ====================

/**
 * Build a kitchen ticket.
 *
 * @param {object} ticket
 * @param {string} ticket.source          — 'didi_food' | 'rappi' | 'uber_eats' | 'pos' | ...
 * @param {string|number} ticket.orderNumber — internal order number
 * @param {string} [ticket.externalId]    — platform order id (short code shown big)
 * @param {string} [ticket.customerName]
 * @param {string} [ticket.deliveryAddress]
 * @param {string} [ticket.orderNotes]
 * @param {string|Date} [ticket.createdAt]
 * @param {Array<{quantity:number,name:string,notes?:string,modifiers?:string[]}>} ticket.items
 * @returns {Buffer}
 */
export function buildKitchenTicket(ticket) {
  const b = new TicketBuilder();
  const label = SOURCE_LABELS[ticket.source] || String(ticket.source || 'PEDIDO').toUpperCase();

  b.beep();
  b.center().size('big').bold(true).text(label);

  // The number the courier/customer knows: platform short id if present, else internal order number
  const shortExternal = ticket.externalId
    ? String(ticket.externalId).slice(-6).toUpperCase()
    : null;
  b.text(`# ${shortExternal || ticket.orderNumber}`);
  b.bold(false).size('normal');

  if (shortExternal) b.text(`Orden interna: ${ticket.orderNumber}`);
  b.text(formatTime(ticket.createdAt || Date.now()));
  b.left().line('=');

  if (ticket.customerName) {
    b.size('tall').bold(true);
    for (const l of wrap(`Cliente: ${ticket.customerName}`)) b.text(l);
    b.bold(false).size('normal');
  }

  b.blank();

  for (const item of (ticket.items || [])) {
    const qty = item.quantity || 1;
    b.size('tall').bold(true);
    const head = `${qty} x ${item.name}`;
    for (const l of wrap(head)) b.text(l);
    b.bold(false).size('normal');
    for (const mod of (item.modifiers || [])) {
      for (const l of wrap(`  + ${mod}`, COLS)) b.text(l);
    }
    if (item.notes) {
      for (const l of wrap(`  >> ${item.notes}`, COLS)) b.text(l);
    }
    b.blank();
  }

  if (ticket.orderNotes) {
    b.line('-');
    b.bold(true).text('NOTAS:').bold(false);
    for (const l of wrap(ticket.orderNotes)) b.text(l);
  }

  if (ticket.deliveryAddress) {
    b.line('-');
    b.text('Entrega:');
    for (const l of wrap(ticket.deliveryAddress)) b.text(l);
  }

  b.line('=');
  b.center().text(`${label}  #${shortExternal || ticket.orderNumber}`);
  b.left();
  b.cut();
  return b.build();
}

/**
 * Build a test ticket to verify printer connectivity + Spanish characters.
 * @param {object} [opts]
 * @param {string} [opts.printerName]
 * @param {string} [opts.tenantName]
 */
export function buildTestTicket(opts = {}) {
  const b = new TicketBuilder();
  b.beep();
  b.center().size('big').bold(true).text('PRUEBA OK');
  b.size('normal').bold(false);
  b.text(opts.tenantName || 'desktop.kitchen');
  if (opts.printerName) b.text(`Impresora: ${opts.printerName}`);
  b.text(formatTime(Date.now()));
  b.left().line('=');
  b.text('Acentos: á é í ó ú ñ Ñ ü ¿ ¡ °');
  b.size('tall').text('Texto doble altura').size('normal');
  b.size('big').text('GRANDE').size('normal');
  b.bold(true).text('Negritas').bold(false);
  b.line('=');
  b.center().text('Si puedes leer esto,');
  b.text('la impresora está lista.');
  b.left();
  b.cut();
  return b.build();
}

export { COLS, encodeCP850, twoCol, wrap };
