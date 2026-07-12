import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { adminSql, tenantContext, tenantSql } from '../db/index.js';
import {
  createInvoice,
  cancelInvoice,
  getInvoiceXml,
  mapPaymentToFormaPago,
} from '../helpers/facturapi.js';
import { buildGenericInvoicePayload, verifyStampedTotal, extractCfdiTotals } from '../helpers/cfdiConcept.js';
import { validateReceptor } from '../helpers/cfdiValidation.js';
import { fromCents } from '../helpers/money.js';
import { audit } from '../lib/auditLog.js';

const router = Router();

const PG_UNIQUE_VIOLATION = '23505';

// Rate limit: 10 requests per IP per 15 minutes
const publicLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

router.use(publicLimiter);

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

    const v = validateReceptor(req.body, { defaultUsoCfdi: 'G03' });
    if (!v.ok) return res.status(400).json({ error: v.error });
    const receptorData = v.receptor;

    // Check if order already has an invoice
    const existingInvoice = await adminSql`
      SELECT id FROM cfdi_invoices WHERE order_id = ${tokenRow.order_id} AND tenant_id = ${tokenRow.tenant_id}
    `.then(rows => rows[0]);

    if (existingInvoice) {
      return res.status(400).json({ error: 'This order already has an invoice' });
    }

    // Fetch order. Line items no longer feed the CFDI concept (generic
    // "Consumo de alimentos y bebidas") — only order.total is authoritative.
    const order = await adminSql`
      SELECT id, order_number, subtotal, tax, total, payment_method
      FROM orders WHERE id = ${tokenRow.order_id} AND tenant_id = ${tokenRow.tenant_id}
    `.then(rows => rows[0]);

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const formaPago = mapPaymentToFormaPago(order.payment_method);

    // Build generic-concept payload (pure). Cents math guarantees the
    // subtotal/IVA split reconciles back to order.total exactly.
    const { payload, subtotalCents, taxCents, totalCents } = buildGenericInvoicePayload({
      order,
      receptor: receptorData,
      config,
      formaPago,
      metodoPago: 'PUE',
    });

    // Stamp via FacturAPI.
    const invoice = await createInvoice(config.facturapi_org_id, {
      receptor: receptorData,
      items: payload.items,
      forma_pago: payload.payment_form,
      metodo_pago: payload.payment_method,
      series: config.invoice_series,
    });

    // Post-stamp verification: if Facturapi's Total ≠ ticket total (rounding
    // divergence on IVA recompute), the document is legally unusable.
    //
    // Persist FIRST with status='stamped_mismatch', THEN cancel. If cancel
    // fails, the row keeps the partial unique index engaged so a retry
    // can't double-stamp; a reconciler / admin resolves the orphan later.
    // Values persisted are the RESPONSE totals — that's what's actually on
    // the SAT stamp.
    const check = verifyStampedTotal(invoice, totalCents);
    if (!check.ok) {
      console.error(
        `[CFDI-Public] STAMPED TOTAL MISMATCH order=${order.id} facturapi=${invoice.id} ` +
        `expected_cents=${check.expected} actual_cents=${check.actual} delta=${check.deltaCents}`
      );

      const stampedTotalCents = Number.isFinite(check.actual) ? check.actual : null;
      try {
        await adminSql`
          INSERT INTO cfdi_invoices (
            tenant_id, order_id, facturapi_invoice_id, uuid_fiscal, series, folio,
            receptor_rfc, receptor_name, receptor_tax_regime, receptor_postal_code, receptor_uso_cfdi,
            subtotal, tax_total, total, forma_pago, metodo_pago,
            xml_url, pdf_url, requested_by, status, provider_response
          ) VALUES (
            ${tokenRow.tenant_id}, ${order.id}, ${invoice.id}, ${invoice.uuid || null},
            ${invoice.series || null}, ${invoice.folio_number || null},
            ${receptorData.rfc}, ${receptorData.name}, ${receptorData.tax_regime},
            ${receptorData.postal_code}, ${receptorData.uso_cfdi},
            ${invoice.subtotal ?? null}, ${invoice.taxes_transferred ?? invoice.total_taxes ?? null},
            ${stampedTotalCents != null ? fromCents(stampedTotalCents) : null},
            ${formaPago}, 'PUE',
            ${invoice.xml_url || null}, ${invoice.pdf_url || null}, 'customer', 'stamped_mismatch',
            ${adminSql.json(invoice)}
          )
        `;
      } catch (mismatchInsertErr) {
        console.error(`[CFDI-Public] Failed to persist mismatch row for orphan ${invoice.id}:`, mismatchInsertErr.message);
      }

      let cancelled = false;
      try {
        await cancelInvoice(config.facturapi_org_id, invoice.id, '02');
        cancelled = true;
        await adminSql`
          UPDATE cfdi_invoices
          SET status = 'cancelled', cancellation_reason = 'total_mismatch_auto_cancelled', cancelled_at = NOW()
          WHERE facturapi_invoice_id = ${invoice.id}
        `;
      } catch (cancelErr) {
        console.error(`[CFDI-Public] Failed to auto-cancel mismatch invoice ${invoice.id}:`, cancelErr.message);
      }

      audit({
        tenantId: tokenRow.tenant_id,
        actorType: 'system',
        actorId: 'cfdi-public-token',
        action: 'stamp_mismatch',
        resource: 'cfdi_invoices',
        resourceId: invoice.id,
        details: {
          order_id: order.id,
          expected_total_cents: check.expected,
          actual_total_cents: check.actual,
          delta_cents: check.deltaCents,
          facturapi_invoice_id: invoice.id,
          uuid_fiscal: invoice.uuid || null,
          auto_cancelled: cancelled,
          via: 'customer_token',
        },
        ip: req.ip,
      });
      return res.status(502).json({
        error: cancelled
          ? 'Invoice total mismatch. Please try again or contact the restaurant.'
          : 'Invoice total mismatch — orphaned stamp requires manual resolution. Please contact the restaurant.',
      });
    }

    // Extract SAT-authoritative SubTotal + IVA from the stamped XML.
    // Falls back to advisory local split if fetch/parse fails; the stamp
    // itself is still valid either way.
    let stampedSubtotalCents = subtotalCents;
    let stampedTaxCents = taxCents;
    let extractSource = 'local_advisory';
    try {
      const xml = await getInvoiceXml(invoice.id);
      const stamped = extractCfdiTotals(xml);
      if (stamped) {
        if (stamped.totalCents !== totalCents) {
          console.warn(
            `[CFDI-Public] XML total (${stamped.totalCents}c) disagrees with response total (${totalCents}c) for ${invoice.id} — persisting XML values`,
          );
        }
        stampedSubtotalCents = stamped.subtotalCents;
        stampedTaxCents = stamped.taxCents;
        extractSource = 'xml';
      } else {
        console.warn(`[CFDI-Public] Could not parse SubTotal/Total from XML for ${invoice.id}; falling back to advisory split`);
      }
    } catch (xmlErr) {
      console.warn(`[CFDI-Public] XML fetch failed for ${invoice.id}: ${xmlErr.message}; falling back to advisory split`);
    }

    // Save invoice record (via adminSql, setting tenant_id explicitly).
    // Partial unique index (mig 0074) will 23505 if the staff path or a
    // parallel token request already inserted. The CFDI was still stamped
    // at FacturAPI in that case; surface as 409 so the client shows
    // "already invoiced" instead of retrying and double-stamping.
    //
    // subtotal/tax_total = SAT-authoritative XML values when available,
    // advisory local split as fallback. total = ticket total (verified).
    let invoiceId;
    try {
      const insertResult = await adminSql`
        INSERT INTO cfdi_invoices (
          tenant_id, order_id, facturapi_invoice_id, uuid_fiscal, series, folio,
          receptor_rfc, receptor_name, receptor_tax_regime, receptor_postal_code, receptor_uso_cfdi,
          subtotal, tax_total, total, forma_pago, metodo_pago,
          xml_url, pdf_url, requested_by, provider_response
        ) VALUES (
          ${tokenRow.tenant_id}, ${order.id}, ${invoice.id}, ${invoice.uuid},
          ${invoice.series || null}, ${invoice.folio_number || null},
          ${receptorData.rfc}, ${receptorData.name}, ${receptorData.tax_regime},
          ${receptorData.postal_code}, ${receptorData.uso_cfdi},
          ${fromCents(stampedSubtotalCents)}, ${fromCents(stampedTaxCents)}, ${fromCents(totalCents)},
          ${formaPago}, 'PUE',
          ${invoice.xml_url || null}, ${invoice.pdf_url || null}, 'customer',
          ${adminSql.json(invoice)}
        ) RETURNING id
      `;
      invoiceId = insertResult[0]?.id;
    } catch (insertErr) {
      if (insertErr.code === PG_UNIQUE_VIOLATION) {
        console.warn(`[CFDI-Public] Race: order ${order.id} was already invoiced (FacturAPI id ${invoice.id} orphaned)`);
        return res.status(409).json({ error: 'This order already has an invoice' });
      }
      throw insertErr;
    }

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

    audit({
      tenantId: tokenRow.tenant_id,
      actorType: 'system',
      actorId: 'cfdi-public-token',
      action: 'create',
      resource: 'cfdi_invoices',
      resourceId: String(invoiceId),
      details: {
        order_id: order.id,
        facturapi_invoice_id: invoice.id,
        uuid_fiscal: invoice.uuid,
        receptor_rfc: receptorData.rfc,
        subtotal_cents: stampedSubtotalCents,
        tax_cents: stampedTaxCents,
        total_cents: totalCents,
        extract_source: extractSource,
        via: 'customer_token',
      },
      ip: req.ip,
    });

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
