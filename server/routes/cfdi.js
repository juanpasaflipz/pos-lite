import { Router } from 'express';
import multer from 'multer';
import { run, get, all, getTenantId } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import {
  createOrganization,
  uploadCSD,
  testStamp,
  createInvoice,
  cancelInvoice,
  getInvoiceFiles,
  getInvoiceXml,
  sendInvoiceEmail,
  mapPaymentToFormaPago,
  generateInvoiceToken,
} from '../helpers/facturapi.js';
import { buildGenericInvoicePayload, verifyStampedTotal, extractCfdiTotals } from '../helpers/cfdiConcept.js';
import { validateReceptor, normalizeEmail } from '../helpers/cfdiValidation.js';
import { fromCents } from '../helpers/money.js';
import { getServiceCredentials } from '../helpers/tenantCredentials.js';
import { taxRegimes, usoCfdi, formaPago, cancellationMotives } from '../data/sat-catalogs.js';
import { audit } from '../lib/auditLog.js';

const router = Router();

// Postgres unique_violation. Both /invoices and cfdi-public rely on the
// partial unique index uniq_cfdi_invoices_order_active (migration 0074) to
// close the concurrent-issue race.
const PG_UNIQUE_VIOLATION = '23505';

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
    // Surface CSD expiry state so the UI can warn ~30 days out. Merchants
    // routinely forget their CSD needs renewal every 4 years; a silent expiry
    // turns every invoice attempt into a 500 with no owner-visible reason.
    let csd_expires_in_days = null;
    let csd_expired = null;
    if (config?.csd_valid_until) {
      const ms = new Date(config.csd_valid_until).getTime() - Date.now();
      csd_expires_in_days = Math.floor(ms / (1000 * 60 * 60 * 24));
      csd_expired = ms <= 0;
    }
    // Check whether a Facturapi key is actually resolvable for this tenant —
    // either they pasted one in Integrations (tenant_credentials) or the
    // platform env has one. This matches resolveClient() so the UI banner
    // doesn't nag merchants who've already added their own key.
    const creds = await getServiceCredentials(getTenantId(), 'facturapi', { api_key: 'FACTURAPI_API_KEY' });
    res.json({
      config: config || null,
      facturapi_configured: !!creds.api_key,
      csd_expires_in_days,
      csd_expired,
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

    // Create FacturAPI organization if not yet created and API is configured.
    // Same resolution logic as GET /config: tenant credential OR platform env.
    const creds = await getServiceCredentials(getTenantId(), 'facturapi', { api_key: 'FACTURAPI_API_KEY' });
    if (!facturapi_org_id && creds.api_key) {
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

    const uploadResult = await uploadCSD(config.facturapi_org_id, cerFile.buffer, keyFile.buffer, password);

    await run(`
      UPDATE cfdi_config SET csd_uploaded = true, active = true,
        csd_valid_until = $1, updated_at = NOW()
      WHERE tenant_id = current_setting('app.tenant_id', true)
    `, [uploadResult?.expires_at || null]);

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
    // Refresh the persisted expiry when the merchant runs the test — cheap
    // and keeps the expiry warning honest if they renew directly at FacturAPI.
    if (result?.success && result.expires_at) {
      await run(
        `UPDATE cfdi_config SET csd_valid_until = $1, updated_at = NOW()
         WHERE tenant_id = current_setting('app.tenant_id', true)`,
        [result.expires_at]
      );
    }
    res.json(result);
  } catch (err) {
    console.error('[CFDI] Test stamp error:', err.message);
    res.status(500).json({ error: 'Test stamp failed' });
  }
});

// ==================== Invoice Issuance ====================

// POST /api/cfdi/invoices — issue a CFDI for an order
router.post('/invoices', requireAuth('manage_invoicing', { allowApproval: true }), async (req, res) => {
  try {
    const { order_id, receptor, publico_general, email } = req.body;

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

    // Fetch order. We no longer read order_items — the CFDI is a single
    // generic concept ("Consumo de alimentos y bebidas") built from
    // order.total. The items check below is kept as a sanity gate against
    // stamping an empty ticket.
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

    const itemCount = await get('SELECT COUNT(*)::int AS n FROM order_items WHERE order_id = $1', [order_id]);
    if (!itemCount || itemCount.n === 0) {
      return res.status(400).json({ error: 'Order has no items' });
    }

    // Build + validate receptor data. Público-en-general short-circuits the
    // validator with the SAT-mandated XAXX fixture; regular customers go
    // through validateReceptor() which handles RFC shape, 5-digit zip, name
    // normalization, and uso_cfdi default.
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
      const v = validateReceptor(receptor, { defaultUsoCfdi: config.default_uso_cfdi || 'G03' });
      if (!v.ok) return res.status(400).json({ error: v.error });
      receptorData = v.receptor;
    }

    // Normalize and lightly validate the recipient email (optional).
    const emailResult = normalizeEmail(email);
    if (!emailResult.ok) return res.status(400).json({ error: emailResult.error });
    const emailNormalized = emailResult.email;

    const formaPago = mapPaymentToFormaPago(order.payment_method);

    // CFDI 4.0 requires a `global` node for Público en General (XAXX)
    // invoices. Per-order XAXX is treated as a daily aggregation of one sale.
    // Facturapi's SDK expects string enum values ('day', 'week', ...), not
    // SAT numeric codes ('01', '02', ...).
    let global = null;
    if (publico_general) {
      const now = new Date();
      global = {
        periodicity: 'day',
        months: String(now.getMonth() + 1).padStart(2, '0'),
        year: now.getFullYear(),
      };
    }

    // Build the generic-concept payload. Pure function — subtotal/IVA are
    // computed locally in cents so subtotal + iva === order.total exactly.
    const { payload, subtotalCents, taxCents, totalCents } = buildGenericInvoicePayload({
      order,
      receptor: receptorData,
      config,
      formaPago,
      metodoPago: 'PUE',
      global,
    });

    // Stamp via FacturAPI.
    const invoice = await createInvoice(config.facturapi_org_id, {
      receptor: receptorData,
      items: payload.items,
      forma_pago: payload.payment_form,
      metodo_pago: payload.payment_method,
      series: config.invoice_series,
      global,
    });

    // Post-stamp verification: Facturapi recomputes IVA from the subtotal we
    // sent. If their rounding disagrees with ours by even 1 cent, the
    // stamped Total won't equal what the customer paid — we cannot deliver
    // that document.
    //
    // Persist FIRST, cancel SECOND: the CFDI already exists at the SAT. If
    // we tried cancel-first and the cancel failed (network hiccup, provider
    // error), we'd have a live fiscal document with no local trace — the
    // partial unique index couldn't see it, and a retry would double-stamp.
    // Persisting with status='stamped_mismatch' means the index blocks
    // reissue until the orphan is cancelled (either by the inline cancel
    // below, or by a reconciler / admin). Values persisted are the RESPONSE
    // subtotal/tax/total — those reflect what's actually on the SAT stamp.
    const tid = getTenantId();
    const check = verifyStampedTotal(invoice, totalCents);
    if (!check.ok) {
      console.error(
        `[CFDI] STAMPED TOTAL MISMATCH order=${order_id} facturapi=${invoice.id} ` +
        `expected_cents=${check.expected} actual_cents=${check.actual} delta=${check.deltaCents}`
      );

      const stampedTotalCents = Number.isFinite(check.actual) ? check.actual : null;
      try {
        await run(`
          INSERT INTO cfdi_invoices (
            tenant_id, order_id, facturapi_invoice_id, uuid_fiscal, series, folio,
            receptor_rfc, receptor_name, receptor_tax_regime, receptor_postal_code, receptor_uso_cfdi, receptor_email,
            subtotal, tax_total, total, forma_pago, metodo_pago,
            xml_url, pdf_url, requested_by, status, provider_response
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, 'stamped_mismatch', $21::jsonb)
        `, [
          tid, order_id, invoice.id, invoice.uuid || null, invoice.series || null, invoice.folio_number || null,
          receptorData.rfc, receptorData.name, receptorData.tax_regime, receptorData.postal_code, receptorData.uso_cfdi, emailNormalized || null,
          invoice.subtotal ?? null, invoice.taxes_transferred ?? invoice.total_taxes ?? null,
          stampedTotalCents != null ? fromCents(stampedTotalCents) : null,
          formaPago, 'PUE',
          invoice.xml_url || null, invoice.pdf_url || null, 'staff', JSON.stringify(invoice),
        ]);
      } catch (mismatchInsertErr) {
        // Even if the row can't be persisted (23505 race, or hard DB error),
        // we still want to try to cancel the orphan and surface the alert.
        console.error(`[CFDI] Failed to persist mismatch row for orphan ${invoice.id}:`, mismatchInsertErr.message);
      }

      let cancelled = false;
      try {
        // SAT motive '02' = comprobantes con errores sin relación.
        await cancelInvoice(config.facturapi_org_id, invoice.id, '02');
        cancelled = true;
        await run(
          `UPDATE cfdi_invoices SET status = 'cancelled', cancellation_reason = 'total_mismatch_auto_cancelled', cancelled_at = NOW()
           WHERE facturapi_invoice_id = $1`,
          [invoice.id],
        );
      } catch (cancelErr) {
        console.error(`[CFDI] Failed to auto-cancel mismatch invoice ${invoice.id}:`, cancelErr.message);
      }

      audit({
        tenantId: tid,
        actorType: 'employee',
        actorId: req.employee?.id ? String(req.employee.id) : null,
        action: 'stamp_mismatch',
        resource: 'cfdi_invoices',
        resourceId: invoice.id,
        details: {
          order_id,
          expected_total_cents: check.expected,
          actual_total_cents: check.actual,
          delta_cents: check.deltaCents,
          facturapi_invoice_id: invoice.id,
          uuid_fiscal: invoice.uuid || null,
          auto_cancelled: cancelled,
        },
        ip: req.ip,
      });
      return res.status(502).json({
        error: cancelled
          ? 'Invoice total mismatch — invoice was cancelled at Facturapi. Please retry.'
          : 'Invoice total mismatch — orphaned stamp requires manual cancellation. Please contact support.',
      });
    }

    // Pull the stamped XML and extract SAT-authoritative SubTotal + IVA.
    // Facturapi's response doesn't surface its internal back-split, but
    // the XML carries the 2-decimal display values that appear on the
    // printed invoice and that the SAT records. Persisting those means
    // our cfdi_invoices row mirrors the legal document exactly — no
    // ±1-cent drift between our DB and IVA declarations.
    //
    // Fetch failure is non-fatal: the stamp is valid, we just fall back
    // to the advisory local split for persistence. Logged so recurring
    // fetch problems surface in Sentinel.
    let stampedSubtotalCents = subtotalCents;
    let stampedTaxCents = taxCents;
    let extractSource = 'local_advisory';
    try {
      const xml = await getInvoiceXml(invoice.id);
      const stamped = extractCfdiTotals(xml);
      if (stamped) {
        if (stamped.totalCents !== totalCents) {
          console.warn(
            `[CFDI] XML total (${stamped.totalCents}c) disagrees with response total (${totalCents}c) for ${invoice.id} — persisting XML values`,
          );
        }
        stampedSubtotalCents = stamped.subtotalCents;
        stampedTaxCents = stamped.taxCents;
        extractSource = 'xml';
      } else {
        console.warn(`[CFDI] Could not parse SubTotal/Total from XML for ${invoice.id}; falling back to advisory split`);
      }
    } catch (xmlErr) {
      console.warn(`[CFDI] XML fetch failed for ${invoice.id}: ${xmlErr.message}; falling back to advisory split`);
    }

    // Save invoice record. Partial unique index (mig 0074) will 23505 if
    // another request already inserted a live invoice for this order — the
    // CFDI was still stamped at FacturAPI, so we surface a 409 rather than a
    // 500 so the UI can render "already invoiced" instead of "try again"
    // (which would double-stamp).
    //
    // subtotal/tax_total = SAT-authoritative XML values when available,
    // advisory local split as fallback. total = ticket total (verified
    // equal to response total and, when XML available, to XML total).
    let result;
    try {
      result = await run(`
        INSERT INTO cfdi_invoices (
          tenant_id, order_id, facturapi_invoice_id, uuid_fiscal, series, folio,
          receptor_rfc, receptor_name, receptor_tax_regime, receptor_postal_code, receptor_uso_cfdi, receptor_email,
          subtotal, tax_total, total, forma_pago, metodo_pago,
          xml_url, pdf_url, requested_by, provider_response
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21::jsonb)
      `, [
        tid, order_id, invoice.id, invoice.uuid, invoice.series, invoice.folio_number,
        receptorData.rfc, receptorData.name, receptorData.tax_regime, receptorData.postal_code, receptorData.uso_cfdi, emailNormalized || null,
        fromCents(stampedSubtotalCents), fromCents(stampedTaxCents), fromCents(totalCents), formaPago, 'PUE',
        invoice.xml_url || null, invoice.pdf_url || null, 'staff', JSON.stringify(invoice),
      ]);
    } catch (insertErr) {
      if (insertErr.code === PG_UNIQUE_VIOLATION) {
        console.warn(`[CFDI] Race: order ${order_id} was already invoiced (FacturAPI id ${invoice.id} orphaned)`);
        return res.status(409).json({ error: 'This order already has an invoice', facturapi_invoice_id: invoice.id });
      }
      throw insertErr;
    }

    // Update order with invoice reference
    await run('UPDATE orders SET cfdi_invoice_id = $1 WHERE id = $2', [result.lastInsertRowid, order_id]);

    const saved = await get('SELECT * FROM cfdi_invoices WHERE id = $1', [result.lastInsertRowid]);

    audit({
      tenantId: tid,
      actorType: 'employee',
      actorId: req.employee?.id ? String(req.employee.id) : null,
      action: 'create',
      resource: 'cfdi_invoices',
      resourceId: String(result.lastInsertRowid),
      details: {
        order_id,
        facturapi_invoice_id: invoice.id,
        uuid_fiscal: invoice.uuid,
        receptor_rfc: receptorData.rfc,
        subtotal_cents: stampedSubtotalCents,
        tax_cents: stampedTaxCents,
        total_cents: totalCents,
        extract_source: extractSource,
        publico_general: !!publico_general,
        receptor_email: emailNormalized || null,
        ...(req.approver && {
          approved_by_employee_id: req.approver.id,
          approved_by_name: req.approver.name,
        }),
      },
      ip: req.ip,
    });

    // Fire-and-forget email delivery. Facturapi failures are logged but do
    // NOT roll back the stamp (invoice is already saved; merchant can resend).
    if (emailNormalized) {
      sendInvoiceEmail(invoice.id, emailNormalized).catch(() => {});
    }

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

// POST /api/cfdi/invoices/:id/resend-email — resend the stamped invoice to
// a (possibly corrected) address. Updates receptor_email on success so the
// row always reflects the last-known-good destination.
router.post('/invoices/:id/resend-email', requireAuth('manage_invoicing'), async (req, res) => {
  try {
    const { email } = req.body;
    const normalized = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (!normalized || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    const invoice = await get(
      'SELECT id, facturapi_invoice_id, status FROM cfdi_invoices WHERE id = $1',
      [req.params.id]
    );
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (invoice.status !== 'valid') {
      return res.status(400).json({ error: 'Cannot resend a cancelled invoice' });
    }

    const result = await sendInvoiceEmail(invoice.facturapi_invoice_id, normalized);
    if (!result.success) {
      return res.status(502).json({ error: result.error || 'Email send failed at Facturapi' });
    }

    await run(
      'UPDATE cfdi_invoices SET receptor_email = $1 WHERE id = $2',
      [normalized, invoice.id]
    );

    audit({
      tenantId: getTenantId(),
      actorType: 'employee',
      actorId: req.employee?.id ? String(req.employee.id) : null,
      action: 'resend_email',
      resource: 'cfdi_invoices',
      resourceId: String(invoice.id),
      details: { email: normalized },
      ip: req.ip,
    });

    const updated = await get('SELECT * FROM cfdi_invoices WHERE id = $1', [invoice.id]);
    res.json(updated);
  } catch (err) {
    console.error('[CFDI] Error resending invoice email:', err.message);
    res.status(500).json({ error: 'Failed to resend invoice email' });
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

    audit({
      tenantId: getTenantId(),
      actorType: 'employee',
      actorId: req.employee?.id ? String(req.employee.id) : null,
      action: 'delete',
      resource: 'cfdi_invoices',
      resourceId: String(req.params.id),
      details: {
        order_id: invoice.order_id,
        facturapi_invoice_id: invoice.facturapi_invoice_id,
        uuid_fiscal: invoice.uuid_fiscal,
        motive,
        substitute_uuid: substitute_uuid || null,
      },
      ip: req.ip,
    });

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

    // Pay-first restaurant model (Juan, 2026-07-20): a CFDI is a PUE (pago en
    // una sola exhibición) tax document — never mint an invoice link for an
    // order that hasn't settled, or you SAT-stamp a sale that never happened.
    // The stamp path (cfdi-public.js /:token/issue) enforces the same guard.
    if (!['paid', 'completed'].includes(order.payment_status)) {
      return res.status(409).json({
        error: 'La orden debe estar pagada antes de generar factura',
        code: 'ORDER_NOT_PAID',
        payment_status: order.payment_status,
      });
    }

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
