import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { adminSql, tenantContext, tenantSql } from '../db/index.js';
import {
  createInvoice,
  mapOrderItemsToCFDI,
  mapPaymentToFormaPago,
} from '../helpers/facturapi.js';

const router = Router();

// Rate limit: 10 requests per IP per 15 minutes
const publicLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

router.use(publicLimiter);

// RFC validation regex
const RFC_REGEX = /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/i;
const SPECIAL_RFCS = ['XAXX010101000', 'XEXX010101000'];

/**
 * Helper: look up token via adminSql (no RLS), validate it,
 * and return { token row, tenant, config } or respond with error.
 */
async function resolveToken(tokenStr, res) {
  const tokenRow = await adminSql`
    SELECT * FROM cfdi_invoice_tokens WHERE token = ${tokenStr}
  `.then(rows => rows[0]);

  if (!tokenRow) {
    res.status(404).json({ error: 'Invalid invoice link' });
    return null;
  }

  if (tokenRow.used) {
    res.status(410).json({ error: 'This invoice link has already been used' });
    return null;
  }

  if (new Date(tokenRow.expires_at) < new Date()) {
    res.status(410).json({ error: 'This invoice link has expired' });
    return null;
  }

  // Load tenant info
  const tenant = await adminSql`
    SELECT id, name, subdomain, branding_json FROM tenants WHERE id = ${tokenRow.tenant_id}
  `.then(rows => rows[0]);

  if (!tenant) {
    res.status(404).json({ error: 'Restaurant not found' });
    return null;
  }

  // Load CFDI config (via adminSql, no RLS)
  const config = await adminSql`
    SELECT * FROM cfdi_config WHERE tenant_id = ${tokenRow.tenant_id}
  `.then(rows => rows[0]);

  if (!config || !config.active || !config.facturapi_org_id) {
    res.status(400).json({ error: 'Invoicing is not available for this restaurant' });
    return null;
  }

  return { tokenRow, tenant, config };
}

/**
 * Helper: run a callback within a tenant context (sets RLS) using tenantSql.
 */
async function withTenantContext(tenantId, fn) {
  const conn = await tenantSql.reserve();
  try {
    await conn`SELECT set_config('app.tenant_id', ${tenantId}, false)`;
    const store = { conn, tenantId };
    return await tenantContext.run(store, () => fn(conn));
  } finally {
    await conn`SELECT set_config('app.tenant_id', '', false)`;
    conn.release();
  }
}

// GET /api/cfdi-public/:token — validate token and return order summary
router.get('/:token', async (req, res) => {
  try {
    const resolved = await resolveToken(req.params.token, res);
    if (!resolved) return; // Response already sent

    const { tokenRow, tenant, config } = resolved;

    // Fetch order and items via adminSql (bypass RLS for cross-tenant access)
    const order = await adminSql`
      SELECT id, order_number, subtotal, tax, total, payment_method, created_at
      FROM orders WHERE id = ${tokenRow.order_id} AND tenant_id = ${tokenRow.tenant_id}
    `.then(rows => rows[0]);

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const items = await adminSql`
      SELECT item_name, quantity, unit_price
      FROM order_items WHERE order_id = ${order.id} AND tenant_id = ${tokenRow.tenant_id}
    `;

    // Parse branding
    let branding = null;
    try {
      branding = tenant.branding_json ? JSON.parse(tenant.branding_json) : null;
    } catch { /* ignore parse errors */ }

    res.json({
      order_number: order.order_number,
      date: order.created_at,
      items: Array.from(items),
      subtotal: order.subtotal,
      tax: order.tax,
      total: order.total,
      tenant_name: tenant.name,
      tenant_logo: branding?.logoUrl || null,
      tenant_color: branding?.primaryColor || '#0d9488',
      emisor_postal_code: config.postal_code,
    });
  } catch (err) {
    console.error('[CFDI-Public] Error fetching order:', err.message);
    res.status(500).json({ error: 'Failed to load order data' });
  }
});

// POST /api/cfdi-public/:token/issue — customer submits RFC data to issue invoice
router.post('/:token/issue', async (req, res) => {
  try {
    const resolved = await resolveToken(req.params.token, res);
    if (!resolved) return;

    const { tokenRow, tenant, config } = resolved;
    const { rfc, name, tax_regime, postal_code, uso_cfdi } = req.body;

    if (!rfc || !name || !tax_regime || !postal_code) {
      return res.status(400).json({ error: 'RFC, name, tax regime, and postal code are required' });
    }

    // Validate RFC
    const cleanRfc = rfc.toUpperCase().trim();
    if (!SPECIAL_RFCS.includes(cleanRfc) && !RFC_REGEX.test(cleanRfc)) {
      return res.status(400).json({ error: 'Invalid RFC format' });
    }

    // Check if order already has an invoice
    const existingInvoice = await adminSql`
      SELECT id FROM cfdi_invoices WHERE order_id = ${tokenRow.order_id} AND tenant_id = ${tokenRow.tenant_id}
    `.then(rows => rows[0]);

    if (existingInvoice) {
      return res.status(400).json({ error: 'This order already has an invoice' });
    }

    // Fetch order and items
    const order = await adminSql`
      SELECT id, order_number, subtotal, tax, total, payment_method
      FROM orders WHERE id = ${tokenRow.order_id} AND tenant_id = ${tokenRow.tenant_id}
    `.then(rows => rows[0]);

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const items = await adminSql`
      SELECT item_name, quantity, unit_price
      FROM order_items WHERE order_id = ${order.id} AND tenant_id = ${tokenRow.tenant_id}
    `;

    const receptorData = {
      rfc: cleanRfc,
      name: name.toUpperCase().trim(),
      tax_regime,
      postal_code,
      uso_cfdi: uso_cfdi || 'G03',
    };

    const cfdiItems = mapOrderItemsToCFDI(Array.from(items));
    const formaPago = mapPaymentToFormaPago(order.payment_method);

    // Create invoice via FacturAPI
    const invoice = await createInvoice(config.facturapi_org_id, {
      receptor: receptorData,
      items: cfdiItems,
      forma_pago: formaPago,
      metodo_pago: 'PUE',
      series: config.invoice_series,
    });

    // Save invoice record (via adminSql, setting tenant_id explicitly)
    const insertResult = await adminSql`
      INSERT INTO cfdi_invoices (
        tenant_id, order_id, facturapi_invoice_id, uuid_fiscal, series, folio,
        receptor_rfc, receptor_name, receptor_tax_regime, receptor_postal_code, receptor_uso_cfdi,
        subtotal, tax_total, total, forma_pago, metodo_pago,
        xml_url, pdf_url, requested_by
      ) VALUES (
        ${tokenRow.tenant_id}, ${order.id}, ${invoice.id}, ${invoice.uuid},
        ${invoice.series || null}, ${invoice.folio_number || null},
        ${receptorData.rfc}, ${receptorData.name}, ${receptorData.tax_regime},
        ${receptorData.postal_code}, ${receptorData.uso_cfdi},
        ${order.subtotal}, ${order.tax}, ${order.total},
        ${formaPago}, 'PUE',
        ${invoice.xml_url || null}, ${invoice.pdf_url || null}, 'customer'
      ) RETURNING id
    `;

    const invoiceId = insertResult[0]?.id;

    // Mark token as used
    await adminSql`
      UPDATE cfdi_invoice_tokens SET used = true, used_at = NOW(), cfdi_invoice_id = ${invoiceId}
      WHERE token = ${req.params.token}
    `;

    // Update order
    await adminSql`
      UPDATE orders SET cfdi_invoice_id = ${invoiceId}
      WHERE id = ${order.id} AND tenant_id = ${tokenRow.tenant_id}
    `;

    res.json({
      uuid_fiscal: invoice.uuid,
      pdf_url: invoice.pdf_url || null,
      xml_url: invoice.xml_url || null,
      invoice_id: invoiceId,
    });
  } catch (err) {
    console.error('[CFDI-Public] Error issuing invoice:', err.message);
    res.status(500).json({ error: 'Failed to issue invoice. Please try again or contact the restaurant.' });
  }
});

// GET /api/cfdi-public/:token/download — download PDF or XML
router.get('/:token/download', async (req, res) => {
  try {
    const { format } = req.query;
    if (!format || !['pdf', 'xml'].includes(format)) {
      return res.status(400).json({ error: 'format query param must be pdf or xml' });
    }

    const tokenRow = await adminSql`
      SELECT * FROM cfdi_invoice_tokens WHERE token = ${req.params.token}
    `.then(rows => rows[0]);

    if (!tokenRow || !tokenRow.cfdi_invoice_id) {
      return res.status(404).json({ error: 'Invoice not found for this token' });
    }

    const invoice = await adminSql`
      SELECT pdf_url, xml_url FROM cfdi_invoices WHERE id = ${tokenRow.cfdi_invoice_id}
    `.then(rows => rows[0]);

    if (!invoice) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    const url = format === 'pdf' ? invoice.pdf_url : invoice.xml_url;
    if (!url) {
      return res.status(404).json({ error: `${format.toUpperCase()} not available` });
    }

    res.redirect(url);
  } catch (err) {
    console.error('[CFDI-Public] Error downloading:', err.message);
    res.status(500).json({ error: 'Failed to download file' });
  }
});

export default router;
