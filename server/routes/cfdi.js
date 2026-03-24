import { Router } from 'express';
import multer from 'multer';
import { run, get, all, getTenantId } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import {
  isFacturapiConfigured,
  createOrganization,
  uploadCSD,
  testStamp,
  createInvoice,
  cancelInvoice,
  getInvoiceFiles,
  mapPaymentToFormaPago,
  mapOrderItemsToCFDI,
  generateInvoiceToken,
} from '../helpers/facturapi.js';
import { taxRegimes, usoCfdi, formaPago, cancellationMotives } from '../data/sat-catalogs.js';

const router = Router();

// Multer: memory storage for CSD file uploads (no disk writes)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 } });

// ==================== SAT Catalogs ====================

// GET /api/cfdi/catalogs — public data for frontend dropdowns
router.get('/catalogs', requireAuth(), async (req, res) => {
  res.json({ taxRegimes, usoCfdi, formaPago, cancellationMotives });
});

// ==================== Configuration ====================

// GET /api/cfdi/config
router.get('/config', requireAuth('manage_invoicing'), async (req, res) => {
  try {
    const config = await get('SELECT * FROM cfdi_config WHERE tenant_id = current_setting($1, true)', ['app.tenant_id']);
    res.json({
      config: config || null,
      facturapi_configured: isFacturapiConfigured(),
    });
  } catch (err) {
    console.error('[CFDI] Error fetching config:', err.message);
    res.status(500).json({ error: 'Failed to fetch CFDI config' });
  }
});

// POST /api/cfdi/config — save/update fiscal data; creates FacturAPI org if needed
router.post('/config', requireAuth('manage_invoicing'), async (req, res) => {
  try {
    const { rfc, legal_name, tax_regime, postal_code, default_uso_cfdi, invoice_series, invoice_link_expiry_hours } = req.body;

    if (!rfc || !legal_name || !tax_regime || !postal_code) {
      return res.status(400).json({ error: 'RFC, legal name, tax regime, and postal code are required' });
    }

    // Check existing config
    const existing = await get('SELECT * FROM cfdi_config WHERE tenant_id = current_setting($1, true)', ['app.tenant_id']);

    let facturapi_org_id = existing?.facturapi_org_id || null;

    // Create FacturAPI organization if not yet created and API is configured
    if (!facturapi_org_id && isFacturapiConfigured()) {
      const org = await createOrganization({ legal_name, rfc, tax_regime, postal_code });
      facturapi_org_id = org.id;
    }

    if (existing) {
      await run(`
        UPDATE cfdi_config SET
          rfc = $1, legal_name = $2, tax_regime = $3, postal_code = $4,
          facturapi_org_id = $5, default_uso_cfdi = $6, invoice_series = $7,
          invoice_link_expiry_hours = $8, updated_at = NOW()
        WHERE tenant_id = current_setting('app.tenant_id', true)
      `, [
        rfc, legal_name, tax_regime, postal_code,
        facturapi_org_id,
        default_uso_cfdi || 'G03',
        invoice_series || 'DK',
        invoice_link_expiry_hours || 72,
      ]);
    } else {
      await run(`
        INSERT INTO cfdi_config (tenant_id, rfc, legal_name, tax_regime, postal_code, facturapi_org_id, default_uso_cfdi, invoice_series, invoice_link_expiry_hours)
        VALUES (current_setting('app.tenant_id', true), $1, $2, $3, $4, $5, $6, $7, $8)
      `, [
        rfc, legal_name, tax_regime, postal_code,
        facturapi_org_id,
        default_uso_cfdi || 'G03',
        invoice_series || 'DK',
        invoice_link_expiry_hours || 72,
      ]);
    }

    const config = await get('SELECT * FROM cfdi_config WHERE tenant_id = current_setting($1, true)', ['app.tenant_id']);
    res.json({ config });
  } catch (err) {
    console.error('[CFDI] Error saving config:', err.message);
    res.status(500).json({ error: 'Failed to save CFDI config' });
  }
});

// POST /api/cfdi/config/csd — upload CSD certificate files
router.post('/config/csd', requireAuth('manage_invoicing'), upload.fields([
  { name: 'cer', maxCount: 1 },
  { name: 'key', maxCount: 1 },
]), async (req, res) => {
  try {
    const config = await get('SELECT * FROM cfdi_config WHERE tenant_id = current_setting($1, true)', ['app.tenant_id']);
    if (!config || !config.facturapi_org_id) {
      return res.status(400).json({ error: 'CFDI config must be saved first (need FacturAPI org)' });
    }

    const cerFile = req.files?.cer?.[0];
    const keyFile = req.files?.key?.[0];
    const { password } = req.body;

    if (!cerFile || !keyFile || !password) {
      return res.status(400).json({ error: 'CSD .cer file, .key file, and password are required' });
    }

    await uploadCSD(config.facturapi_org_id, cerFile.buffer, keyFile.buffer, password);

    await run(`
      UPDATE cfdi_config SET csd_uploaded = true, active = true, updated_at = NOW()
      WHERE tenant_id = current_setting('app.tenant_id', true)
    `);

    const updated = await get('SELECT * FROM cfdi_config WHERE tenant_id = current_setting($1, true)', ['app.tenant_id']);
    res.json({ config: updated, message: 'CSD uploaded and CFDI activated' });
  } catch (err) {
    console.error('[CFDI] Error uploading CSD:', err.message);
    res.status(500).json({ error: 'Failed to upload CSD' });
  }
});

// POST /api/cfdi/config/test — test stamp capability
router.post('/config/test', requireAuth('manage_invoicing'), async (req, res) => {
  try {
    const config = await get('SELECT * FROM cfdi_config WHERE tenant_id = current_setting($1, true)', ['app.tenant_id']);
    if (!config || !config.facturapi_org_id) {
      return res.status(400).json({ error: 'CFDI not configured' });
    }

    const result = await testStamp(config.facturapi_org_id);
    res.json(result);
  } catch (err) {
    console.error('[CFDI] Test stamp error:', err.message);
    res.status(500).json({ error: 'Test stamp failed' });
  }
});

// ==================== Invoice Issuance ====================

// POST /api/cfdi/invoices — issue a CFDI for an order
router.post('/invoices', requireAuth('manage_invoicing'), async (req, res) => {
  try {
    const { order_id, receptor, publico_general } = req.body;

    if (!order_id) {
      return res.status(400).json({ error: 'order_id is required' });
    }

    // Verify CFDI is configured and active
    const config = await get('SELECT * FROM cfdi_config WHERE tenant_id = current_setting($1, true)', ['app.tenant_id']);
    if (!config || !config.active || !config.facturapi_org_id) {
      return res.status(400).json({ error: 'CFDI invoicing is not configured or active' });
    }

    // Check if order already has an invoice
    const existingInvoice = await get('SELECT id FROM cfdi_invoices WHERE order_id = $1', [order_id]);
    if (existingInvoice) {
      return res.status(400).json({ error: 'This order already has an invoice' });
    }

    // Fetch order with items
    const order = await get(`
      SELECT id, order_number, subtotal, tax, total, payment_method, payment_status
      FROM orders WHERE id = $1
    `, [order_id]);

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (order.payment_status !== 'paid' && order.payment_status !== 'completed') {
      return res.status(400).json({ error: 'Order must be paid before invoicing' });
    }

    const items = await all('SELECT * FROM order_items WHERE order_id = $1', [order_id]);
    if (items.length === 0) {
      return res.status(400).json({ error: 'Order has no items' });
    }

    // Build receptor data
    let receptorData;
    if (publico_general) {
      receptorData = {
        rfc: 'XAXX010101000',
        name: 'PUBLICO EN GENERAL',
        tax_regime: '616',
        postal_code: config.postal_code,
        uso_cfdi: 'S01',
      };
    } else {
      if (!receptor || !receptor.rfc || !receptor.name || !receptor.tax_regime || !receptor.postal_code) {
        return res.status(400).json({ error: 'Receptor RFC, name, tax regime, and postal code are required' });
      }
      receptorData = {
        rfc: receptor.rfc.toUpperCase().trim(),
        name: receptor.name.toUpperCase().trim(),
        tax_regime: receptor.tax_regime,
        postal_code: receptor.postal_code,
        uso_cfdi: receptor.uso_cfdi || config.default_uso_cfdi || 'G03',
      };
    }

    // Validate RFC format
    const rfcRegex = /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/i;
    const specialRFCs = ['XAXX010101000', 'XEXX010101000'];
    if (!specialRFCs.includes(receptorData.rfc) && !rfcRegex.test(receptorData.rfc)) {
      return res.status(400).json({ error: 'Invalid RFC format' });
    }

    // Map order items to CFDI format
    const cfdiItems = mapOrderItemsToCFDI(items);
    const formaPago = mapPaymentToFormaPago(order.payment_method);

    // Create invoice via FacturAPI
    const invoice = await createInvoice(config.facturapi_org_id, {
      receptor: receptorData,
      items: cfdiItems,
      forma_pago: formaPago,
      metodo_pago: 'PUE',
      series: config.invoice_series,
    });

    // Save invoice record
    const tid = getTenantId();
    const result = await run(`
      INSERT INTO cfdi_invoices (
        tenant_id, order_id, facturapi_invoice_id, uuid_fiscal, series, folio,
        receptor_rfc, receptor_name, receptor_tax_regime, receptor_postal_code, receptor_uso_cfdi,
        subtotal, tax_total, total, forma_pago, metodo_pago,
        xml_url, pdf_url, requested_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
    `, [
      tid, order_id, invoice.id, invoice.uuid, invoice.series, invoice.folio_number,
      receptorData.rfc, receptorData.name, receptorData.tax_regime, receptorData.postal_code, receptorData.uso_cfdi,
      order.subtotal, order.tax, order.total, formaPago, 'PUE',
      invoice.xml_url || null, invoice.pdf_url || null, 'staff',
    ]);

    // Update order with invoice reference
    await run('UPDATE orders SET cfdi_invoice_id = $1 WHERE id = $2', [result.lastInsertRowid, order_id]);

    const saved = await get('SELECT * FROM cfdi_invoices WHERE id = $1', [result.lastInsertRowid]);
    res.json(saved);
  } catch (err) {
    console.error('[CFDI] Error issuing invoice:', err.message);
    res.status(500).json({ error: 'Failed to issue invoice' });
  }
});

// ==================== Invoice List & Details ====================

// GET /api/cfdi/invoices — paginated list
router.get('/invoices', requireAuth('manage_invoicing'), async (req, res) => {
  try {
    const { page = 1, limit = 20, search, status } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const params = [];
    let paramIdx = 1;

    let where = 'WHERE 1=1';
    if (status && status !== 'all') {
      where += ` AND ci.status = $${paramIdx++}`;
      params.push(status);
    }
    if (search) {
      where += ` AND (ci.receptor_rfc ILIKE $${paramIdx} OR ci.receptor_name ILIKE $${paramIdx} OR ci.folio ILIKE $${paramIdx} OR o.order_number::text ILIKE $${paramIdx})`;
      paramIdx++;
      params.push(`%${search}%`);
    }

    const countResult = await get(`
      SELECT COUNT(*) as total FROM cfdi_invoices ci
      LEFT JOIN orders o ON ci.order_id = o.id
      ${where}
    `, params);

    params.push(parseInt(limit), offset);
    const invoices = await all(`
      SELECT ci.*, o.order_number
      FROM cfdi_invoices ci
      LEFT JOIN orders o ON ci.order_id = o.id
      ${where}
      ORDER BY ci.issued_at DESC
      LIMIT $${paramIdx++} OFFSET $${paramIdx}
    `, params);

    res.json({
      invoices,
      total: parseInt(countResult?.total || 0),
      page: parseInt(page),
      limit: parseInt(limit),
    });
  } catch (err) {
    console.error('[CFDI] Error listing invoices:', err.message);
    res.status(500).json({ error: 'Failed to list invoices' });
  }
});

// GET /api/cfdi/invoices/:id
router.get('/invoices/:id', requireAuth('manage_invoicing'), async (req, res) => {
  try {
    const invoice = await get(`
      SELECT ci.*, o.order_number
      FROM cfdi_invoices ci
      LEFT JOIN orders o ON ci.order_id = o.id
      WHERE ci.id = $1
    `, [req.params.id]);

    if (!invoice) {
      return res.status(404).json({ error: 'Invoice not found' });
    }
    res.json(invoice);
  } catch (err) {
    console.error('[CFDI] Error fetching invoice:', err.message);
    res.status(500).json({ error: 'Failed to fetch invoice' });
  }
});

// GET /api/cfdi/invoices/:id/xml — redirect to XML download
router.get('/invoices/:id/xml', requireAuth('manage_invoicing'), async (req, res) => {
  try {
    const invoice = await get('SELECT facturapi_invoice_id, xml_url FROM cfdi_invoices WHERE id = $1', [req.params.id]);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

    if (invoice.xml_url) {
      return res.redirect(invoice.xml_url);
    }

    const config = await get('SELECT facturapi_org_id FROM cfdi_config WHERE tenant_id = current_setting($1, true)', ['app.tenant_id']);
    const files = await getInvoiceFiles(config.facturapi_org_id, invoice.facturapi_invoice_id);
    if (files.xml_url) return res.redirect(files.xml_url);
    res.status(404).json({ error: 'XML not available' });
  } catch (err) {
    console.error('[CFDI] Error fetching XML:', err.message);
    res.status(500).json({ error: 'Failed to fetch XML' });
  }
});

// GET /api/cfdi/invoices/:id/pdf — redirect to PDF download
router.get('/invoices/:id/pdf', requireAuth('manage_invoicing'), async (req, res) => {
  try {
    const invoice = await get('SELECT facturapi_invoice_id, pdf_url FROM cfdi_invoices WHERE id = $1', [req.params.id]);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

    if (invoice.pdf_url) {
      return res.redirect(invoice.pdf_url);
    }

    const config = await get('SELECT facturapi_org_id FROM cfdi_config WHERE tenant_id = current_setting($1, true)', ['app.tenant_id']);
    const files = await getInvoiceFiles(config.facturapi_org_id, invoice.facturapi_invoice_id);
    if (files.pdf_url) return res.redirect(files.pdf_url);
    res.status(404).json({ error: 'PDF not available' });
  } catch (err) {
    console.error('[CFDI] Error fetching PDF:', err.message);
    res.status(500).json({ error: 'Failed to fetch PDF' });
  }
});

// ==================== Cancellation ====================

// POST /api/cfdi/invoices/:id/cancel
router.post('/invoices/:id/cancel', requireAuth('manage_invoicing'), async (req, res) => {
  try {
    const { motive, substitute_uuid } = req.body;

    if (!motive) {
      return res.status(400).json({ error: 'Cancellation motive is required' });
    }

    if (motive === '01' && !substitute_uuid) {
      return res.status(400).json({ error: 'Substitute UUID is required for motive 01' });
    }

    const invoice = await get('SELECT * FROM cfdi_invoices WHERE id = $1', [req.params.id]);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (invoice.status === 'cancelled') return res.status(400).json({ error: 'Invoice is already cancelled' });

    const config = await get('SELECT facturapi_org_id FROM cfdi_config WHERE tenant_id = current_setting($1, true)', ['app.tenant_id']);

    await cancelInvoice(config.facturapi_org_id, invoice.facturapi_invoice_id, motive, substitute_uuid);

    await run(`
      UPDATE cfdi_invoices SET
        status = 'cancelled', cancellation_reason = $1, cancelled_at = NOW()
      WHERE id = $2
    `, [motive, req.params.id]);

    // Clear order reference
    await run('UPDATE orders SET cfdi_invoice_id = NULL WHERE id = $1', [invoice.order_id]);

    const updated = await get('SELECT * FROM cfdi_invoices WHERE id = $1', [req.params.id]);
    res.json(updated);
  } catch (err) {
    console.error('[CFDI] Error cancelling invoice:', err.message);
    res.status(500).json({ error: 'Failed to cancel invoice' });
  }
});

// ==================== Invoice Token (for receipt QR) ====================

// GET /api/cfdi/orders/:orderId/token — get or create token for order
router.get('/orders/:orderId/token', requireAuth('pos_access'), async (req, res) => {
  try {
    const { orderId } = req.params;

    const order = await get('SELECT id, invoice_token, payment_status FROM orders WHERE id = $1', [orderId]);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    if (order.invoice_token) {
      const appUrl = process.env.APP_URL || 'https://pos.desktop.kitchen';
      return res.json({
        token: order.invoice_token,
        url: `${appUrl}/#/invoice/${order.invoice_token}`,
      });
    }

    // Generate new token
    const tenantId = req.tenant?.id || 'default';
    const config = await get('SELECT invoice_link_expiry_hours FROM cfdi_config WHERE tenant_id = current_setting($1, true)', ['app.tenant_id']);
    const expiryHours = config?.invoice_link_expiry_hours || 72;

    const token = await generateInvoiceToken(tenantId, parseInt(orderId), expiryHours);
    await run('UPDATE orders SET invoice_token = $1 WHERE id = $2', [token, orderId]);

    const appUrl = process.env.APP_URL || 'https://pos.desktop.kitchen';
    res.json({
      token,
      url: `${appUrl}/#/invoice/${token}`,
    });
  } catch (err) {
    console.error('[CFDI] Error getting/creating token:', err.message);
    res.status(500).json({ error: 'Failed to get invoice token' });
  }
});

export default router;
