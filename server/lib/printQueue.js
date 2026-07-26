/**
 * Print queue helper — enqueues ESC/POS kitchen tickets into print_jobs.
 *
 * The cloud server can't reach the restaurant's LAN printer directly, so
 * jobs are queued here and a small print-bridge agent running on-site
 * (see /print-bridge) polls, claims and prints them.
 *
 * MUST be called inside tenant context (any /api route) — uses the
 * tenant-scoped db helpers so RLS applies.
 */

import jwt from 'jsonwebtoken';
import { all, get, run, getTenantId } from '../db/index.js';
import { adminSql } from '../db/index.js';
import { buildKitchenTicket, buildTestTicket, buildCustomerTicket } from './escpos.js';
import { getCredential } from '../helpers/tenantCredentials.js';
import { getTenant } from '../tenants.js';
import { getPlanLimits } from '../planLimits.js';
import { JWT_SECRET } from './constants.js';

/** Bridge counts as online if it has claimed/heartbeat within this window.
 *  Liveness writes are throttled to 30s (agentAuth), so allow 90s of slack. */
const BRIDGE_ONLINE_WINDOW_MS = 90_000;

/**
 * Bridge health for a tenant: is a print bridge configured, and has it
 * polled recently? Used by the ping endpoint (fail fast instead of letting
 * a check job sit in the queue) and by the POS print-status banner.
 */
export async function getBridgeHealth(tenantId) {
  const rows = await adminSql`
    SELECT key, value FROM tenant_credentials
    WHERE tenant_id = ${tenantId} AND service = 'print_agent' AND key IN ('token', 'last_seen')
  `;
  const creds = Object.fromEntries(rows.map(r => [r.key, r.value]));
  const lastSeen = creds.last_seen || null;
  return {
    configured: Boolean(creds.token),
    online: lastSeen ? (Date.now() - new Date(lastSeen).getTime()) < BRIDGE_ONLINE_WINDOW_MS : false,
    last_seen: lastSeen,
  };
}

/**
 * Pick the target printer for a kitchen ticket.
 * Preference: active 'kitchen' printer → any active printer → null (bridge default).
 */
async function pickKitchenPrinter() {
  const kitchen = await get(
    "SELECT id FROM printers WHERE active = true AND printer_type = 'kitchen' ORDER BY id LIMIT 1"
  );
  if (kitchen) return kitchen.id;
  const any = await get('SELECT id FROM printers WHERE active = true ORDER BY id LIMIT 1');
  return any?.id || null;
}

/**
 * Enqueue a kitchen ticket for an order that already exists in the DB.
 * Loads order + items (+ delivery info if present), renders ESC/POS, inserts a job.
 *
 * Never throws — printing must not break order ingestion. Returns the job id or null.
 *
 * @param {number} orderId
 * @param {object} [opts]
 * @param {string} [opts.source]   — override source label (defaults to orders.source)
 * @param {string} [opts.jobType]  — default 'kitchen'
 */
export async function enqueueKitchenTicket(orderId, opts = {}) {
  try {
    const order = await get('SELECT * FROM orders WHERE id = $1', [orderId]);
    if (!order) {
      console.warn(`[PrintQueue] Order ${orderId} not found — skipping ticket`);
      return null;
    }

    const items = await all(`
      SELECT oi.item_name, oi.quantity, oi.notes,
             COALESCE(
               (SELECT json_agg(oim.modifier_name)
                FROM order_item_modifiers oim
                WHERE oim.order_item_id = oi.id),
               '[]'::json
             ) AS modifiers
      FROM order_items oi
      WHERE oi.order_id = $1
      ORDER BY oi.id
    `, [orderId]);

    let delivery = null;
    if (order.delivery_order_id) {
      delivery = await get(`
        SELECT d.external_order_id, d.customer_name, d.delivery_address, p.name AS platform_name
        FROM delivery_orders d
        LEFT JOIN delivery_platforms p ON p.id = d.platform_id
        WHERE d.id = $1
      `, [order.delivery_order_id]);
    }

    const ticket = {
      source: opts.source || delivery?.platform_name || order.source || 'pos',
      orderNumber: order.order_number,
      externalId: delivery?.external_order_id || null,
      customerName: delivery?.customer_name || null,
      deliveryAddress: delivery?.delivery_address || null,
      createdAt: order.created_at,
      items: items.map(i => ({
        name: i.item_name,
        quantity: Number(i.quantity) || 1,
        notes: i.notes || null,
        modifiers: Array.isArray(i.modifiers) ? i.modifiers : [],
      })),
    };

    const data = buildKitchenTicket(ticket).toString('base64');
    const printerId = await pickKitchenPrinter();

    const result = await run(`
      INSERT INTO print_jobs (tenant_id, order_id, printer_id, job_type, source, payload)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [
      getTenantId(),
      orderId,
      printerId,
      opts.jobType || 'kitchen',
      ticket.source,
      JSON.stringify({ format: 'escpos', encoding: 'base64', data, ticket }),
    ]);

    console.log(`[PrintQueue] Enqueued kitchen ticket job ${result.lastInsertRowid} for order ${orderId} (${ticket.source})`);
    return result.lastInsertRowid;
  } catch (err) {
    console.error(`[PrintQueue] Failed to enqueue ticket for order ${orderId}:`, err.message);
    return null;
  }
}

/**
 * Enqueue the customer-facing ticket (order summary + loyalty sign-up QR)
 * for a just-paid POS order — the raw-ESC/POS counterpart to ReceiptModal's
 * browser-printed receipt, printed on the same kitchen printer. Opt-in per
 * tenant (Printer Management → "Auto-print customer ticket" toggle,
 * tenant_credentials service='print_agent' key='auto_print_customer_ticket');
 * a cheap no-op if the tenant hasn't turned it on.
 *
 * Call this right after marking an order paid, from any completion path
 * (cash, card, split, terminal). Never throws — printing must not break
 * payment completion.
 *
 * @param {number} orderId
 */
export async function enqueueCustomerTicket(orderId) {
  try {
    const tenantId = getTenantId();
    const enabled = await getCredential(tenantId, 'print_agent', 'auto_print_customer_ticket', '');
    if (enabled !== 'true') return null;

    const order = await get(`
      SELECT o.*, COALESCE(lc.name, o.customer_call_name) AS customer_name
      FROM orders o
      LEFT JOIN loyalty_customers lc ON lc.id = o.loyalty_customer_id
      WHERE o.id = $1
    `, [orderId]);
    if (!order) {
      console.warn(`[PrintQueue] Order ${orderId} not found — skipping customer ticket`);
      return null;
    }

    const items = await all(`
      SELECT item_name, quantity, unit_price
      FROM order_items
      WHERE order_id = $1
      ORDER BY id
    `, [orderId]);

    const tenant = await getTenant(tenantId);

    // Loyalty QR — mirrors ReceiptModal's graceful degradation: skip silently
    // (rest of the ticket still prints) if loyalty is plan-locked, the tenant
    // has no subdomain, or minting fails for any reason.
    let loyaltyJoinUrl = null;
    try {
      const locked = getPlanLimits(tenant?.plan || 'free')?.loyalty?.locked === true;
      if (!locked && tenant?.subdomain) {
        const token = jwt.sign(
          { type: 'loyalty_join', tenantId, orderId },
          JWT_SECRET,
          { expiresIn: '7d' },
        );
        loyaltyJoinUrl = `https://${tenant.subdomain}.desktop.kitchen/#/loyalty/join/${token}`;
      }
    } catch (qrErr) {
      console.error(`[PrintQueue] Failed to mint loyalty QR for order ${orderId}:`, qrErr.message);
    }

    const ticket = {
      tenantName: tenant?.name || 'Ticket',
      orderNumber: order.order_number,
      customerName: order.customer_name || null,
      fulfillmentType: order.order_fulfillment_type || null,
      createdAt: order.paid_at || order.created_at,
      items: items.map(i => ({
        name: i.item_name,
        quantity: Number(i.quantity) || 1,
        unitPrice: Number(i.unit_price) || 0,
      })),
      subtotal: Number(order.subtotal) || 0,
      tax: Number(order.tax) || 0,
      total: Number(order.total) || 0,
      loyaltyJoinUrl,
    };

    const data = buildCustomerTicket(ticket).toString('base64');
    const printerId = await pickKitchenPrinter();

    const result = await run(`
      INSERT INTO print_jobs (tenant_id, order_id, printer_id, job_type, source, payload)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [
      tenantId,
      orderId,
      printerId,
      'customer_ticket',
      'pos',
      JSON.stringify({ format: 'escpos', encoding: 'base64', data, ticket }),
    ]);

    console.log(`[PrintQueue] Enqueued customer ticket job ${result.lastInsertRowid} for order ${orderId}`);
    return result.lastInsertRowid;
  } catch (err) {
    console.error(`[PrintQueue] Failed to enqueue customer ticket for order ${orderId}:`, err.message);
    return null;
  }
}

/**
 * Enqueue a test ticket (from the Printer Management screen).
 * @param {number|null} printerId
 * @param {string} [printerName]
 */
export async function enqueueTestTicket(printerId = null, printerName = '') {
  const data = buildTestTicket({ printerName }).toString('base64');
  const result = await run(`
    INSERT INTO print_jobs (tenant_id, printer_id, job_type, source, payload)
    VALUES ($1, $2, 'test', 'test', $3)
  `, [
    getTenantId(),
    printerId,
    JSON.stringify({ format: 'escpos', encoding: 'base64', data, ticket: { test: true } }),
  ]);
  return result.lastInsertRowid;
}

/**
 * Enqueue a connectivity check ("ping") for a printer. The bridge claims it
 * like any job but, instead of printing, opens a TCP socket to the printer
 * and reports ok/error — nothing comes out of the paper slot.
 *
 * Ping jobs fail hard on first error (no retry loop) so the UI gets an
 * answer in seconds; they are also excluded from bridge-status job counts.
 *
 * @param {number|null} printerId — printer to check; null = bridge default
 */
export async function enqueuePingJob(printerId = null) {
  const result = await run(`
    INSERT INTO print_jobs (tenant_id, printer_id, job_type, source, payload)
    VALUES ($1, $2, 'ping', 'ping', $3)
  `, [
    getTenantId(),
    printerId,
    JSON.stringify({ format: 'ping' }),
  ]);
  return result.lastInsertRowid;
}
