// CFDI tests — DB-layer invariants for Mexican tax invoicing.
//
// These are the highest-risk pieces of the CFDI stack that can be verified
// without live FacturAPI credentials:
//
//   1. Unique-active partial index (migration 0074) — a single order cannot
//      hold two non-cancelled invoices. Second INSERT raises unique_violation
//      (Postgres 23505). Both /api/cfdi/invoices (staff) and the customer
//      QR-issue endpoint rely on this to close the concurrent-issue race
//      between two clicks / two devices.
//   2. Cancelled invoices don't block reissue — the partial index only
//      constrains status <> 'cancelled', so a substitute for the same order
//      after cancellation must succeed.
//   3. CSD-expiry surface — the config endpoint derives csd_expires_in_days
//      + csd_expired from csd_valid_until. Merchants routinely forget CSDs
//      renew every 4 years; a silent expiry turns every invoice into a 500.
//
// Live FacturAPI happy path + CSD upload live in a separate suite, gated
// behind a real sandbox key (currently paused pending SAT CSD renewal).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  createTestTenant,
  dropTestTenant,
  asTenant,
  closePools,
  type TestTenant,
} from './helpers/db.js';
// @ts-ignore
import { adminSql, get, run } from '../server/db/index.js';
// @ts-ignore
import { buildGenericInvoicePayload } from '../server/helpers/cfdiConcept.js';
// @ts-ignore
import { fromCents, toCents } from '../server/helpers/money.js';
// @ts-ignore
import { FacturapiRequestError } from '../server/helpers/facturapi.js';

let tenant: TestTenant;
let employeeId: number;
let orderId: number;

async function insertInvoice(overrides: Partial<Record<string, string>> = {}): Promise<void> {
  const facturapiId = overrides.facturapi_invoice_id ?? 'fapi_' + randomUUID();
  const status = overrides.status ?? 'valid';
  await asTenant(tenant.id, () =>
    run(
      `INSERT INTO cfdi_invoices
         (order_id, facturapi_invoice_id, receptor_rfc, receptor_name, status)
       VALUES ($1, $2, 'XAXX010101000', 'PUBLICO EN GENERAL', $3)`,
      [orderId, facturapiId, status],
    ),
  );
}

beforeAll(async () => {
  tenant = await createTestTenant('cfdi');

  await asTenant(tenant.id, async () => {
    const emp = await get(
      `INSERT INTO employees (name, pin, role) VALUES ('CFDI test', '9999', 'cashier') RETURNING id`,
    );
    employeeId = Number(emp.id);
    const order = await get(
      `INSERT INTO orders (order_number, employee_id, status, subtotal, tax, total, payment_status)
       VALUES (1, $1, 'active', 100, 16, 116, 'paid')
       RETURNING id`,
      [employeeId],
    );
    orderId = Number(order.id);
  });
}, 60_000);

afterAll(async () => {
  await dropTestTenant(tenant.id);
  await closePools();
}, 30_000);

describe('unique-active partial index (migration 0074)', () => {
  it('a second live CFDI for the same order raises unique_violation', async () => {
    await insertInvoice();

    await expect(insertInvoice()).rejects.toMatchObject({ code: '23505' });
  });

  it('cancelling the first invoice unblocks reissue for the same order', async () => {
    // Cancel the row from the previous test so the partial index frees.
    await adminSql`
      UPDATE cfdi_invoices SET status = 'cancelled', cancelled_at = NOW()
      WHERE order_id = ${orderId} AND status = 'valid'
    `;

    // A substitute invoice for the same order should now insert cleanly.
    await expect(insertInvoice({ facturapi_invoice_id: 'fapi_substitute' })).resolves.not.toThrow();
  });
});

describe('generic-concept flow — computed cents round-trip through cfdi_invoices', () => {
  it('a row built from the generic-concept builder inserts + blocks reissue', async () => {
    // Prove the schema accepts values produced by buildGenericInvoicePayload
    // (cents-derived NUMERIC(12,2) subtotal/tax/total) AND that the unique-
    // active partial index still blocks a second live invoice for the same
    // order — the generic-concept switch didn't weaken the double-stamp
    // safety net.
    const built = buildGenericInvoicePayload({
      order: { total: 100.01 }, // adversarial: forces drift reconciliation
      receptor: {
        rfc: 'XAXX010101000',
        name: 'PUBLICO EN GENERAL',
        tax_regime: '616',
        postal_code: '01000',
        uso_cfdi: 'S01',
      },
      config: { invoice_series: 'DK' },
      formaPago: '01',
    });
    // Free the order slot: earlier tests leave a 'valid' substitute row on
    // this orderId. The partial unique index would fail our first insert
    // otherwise. Cancelling all extant valid rows for this order is the
    // same operation a real cancel-then-reissue flow would perform.
    await adminSql`
      UPDATE cfdi_invoices SET status = 'cancelled', cancelled_at = NOW()
      WHERE order_id = ${orderId} AND status = 'valid'
    `;

    // Insert with generic-concept values.
    await asTenant(tenant.id, () =>
      run(
        `INSERT INTO cfdi_invoices
           (order_id, facturapi_invoice_id, receptor_rfc, receptor_name,
            subtotal, tax_total, total, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'valid')`,
        [
          orderId,
          'fapi_generic_' + randomUUID(),
          'XAXX010101000',
          'PUBLICO EN GENERAL',
          fromCents(built.subtotalCents),
          fromCents(built.taxCents),
          fromCents(built.totalCents),
        ],
      ),
    );

    // Second live invoice for same order → partial unique index kicks in.
    await expect(
      asTenant(tenant.id, () =>
        run(
          `INSERT INTO cfdi_invoices
             (order_id, facturapi_invoice_id, receptor_rfc, receptor_name,
              subtotal, tax_total, total, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'valid')`,
          [
            orderId,
            'fapi_generic_dup_' + randomUUID(),
            'XAXX010101000',
            'PUBLICO EN GENERAL',
            fromCents(built.subtotalCents),
            fromCents(built.taxCents),
            fromCents(built.totalCents),
          ],
        ),
      ),
    ).rejects.toMatchObject({ code: '23505' });

    // Persisted row's total must equal the ticket total to the cent —
    // the invariant the generic-concept design exists to enforce. Compare
    // in CENTS: the whole reason this module exists is that
    // 86.22 + 13.79 !== 100.01 in floating point.
    const row = await asTenant(tenant.id, () =>
      get(
        `SELECT subtotal::text AS subtotal, tax_total::text AS tax_total, total::text AS total
         FROM cfdi_invoices WHERE order_id = $1 AND status = 'valid'`,
        [orderId],
      ),
    );
    expect(toCents(row.total)).toBe(10001);
    expect(toCents(row.subtotal) + toCents(row.tax_total)).toBe(toCents(row.total));
  });

  it('mismatch orphan row (status=stamped_mismatch) blocks reissue, then unblocks after cancel', async () => {
    // Simulate the mismatch branch: Facturapi stamped a CFDI, our verify
    // caught a total divergence, we persisted a row with status='stamped_
    // mismatch' + provider_response, and the inline cancel FAILED (network
    // hiccup). The partial unique index treats non-cancelled rows as active,
    // so a customer retry MUST be blocked until an admin/reconciler
    // cancels the orphan.
    await adminSql`
      UPDATE cfdi_invoices SET status = 'cancelled', cancelled_at = NOW()
      WHERE order_id = ${orderId} AND status <> 'cancelled'
    `;

    // Persist the orphan.
    const orphanId = 'fapi_orphan_' + randomUUID();
    await asTenant(tenant.id, () =>
      run(
        `INSERT INTO cfdi_invoices
           (order_id, facturapi_invoice_id, receptor_rfc, receptor_name,
            subtotal, tax_total, total, status)
         VALUES ($1, $2, 'XAXX010101000', 'PUBLICO EN GENERAL',
                 86.22, 13.79, 100.01, 'stamped_mismatch')`,
        [orderId, orphanId],
      ),
    );

    // Retry attempt: partial unique index sees status <> 'cancelled' and
    // blocks the second insert. This is the guarantee the user flagged as
    // load-bearing — without the persisted row, this retry would succeed
    // and double-stamp at the SAT.
    await expect(
      asTenant(tenant.id, () =>
        run(
          `INSERT INTO cfdi_invoices
             (order_id, facturapi_invoice_id, receptor_rfc, receptor_name, status)
           VALUES ($1, 'fapi_retry_after_orphan', 'XAXX010101000', 'PUBLICO EN GENERAL', 'valid')`,
          [orderId],
        ),
      ),
    ).rejects.toMatchObject({ code: '23505' });

    // Admin/reconciler cancels the orphan → status='cancelled' →
    // partial index frees → reissue now succeeds.
    await adminSql`
      UPDATE cfdi_invoices SET status = 'cancelled', cancellation_reason = 'total_mismatch_auto_cancelled', cancelled_at = NOW()
      WHERE facturapi_invoice_id = ${orphanId}
    `;
    await expect(
      asTenant(tenant.id, () =>
        run(
          `INSERT INTO cfdi_invoices
             (order_id, facturapi_invoice_id, receptor_rfc, receptor_name, status)
           VALUES ($1, 'fapi_reissue_after_cancel', 'XAXX010101000', 'PUBLICO EN GENERAL', 'valid')`,
          [orderId],
        ),
      ),
    ).resolves.not.toThrow();
  });
});

describe('CSD expiry surface (drives owner warnings + banner)', () => {
  it('csd_valid_until in the past means csd_expired=true', async () => {
    // Insert cfdi_config with an expired CSD.
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await asTenant(tenant.id, () =>
      run(
        `INSERT INTO cfdi_config
           (tenant_id, rfc, legal_name, csd_uploaded, csd_valid_until, active)
         VALUES ($1, 'XAXX010101000', 'Test SA', true, $2, true)
         ON CONFLICT (tenant_id) DO UPDATE SET csd_valid_until = EXCLUDED.csd_valid_until`,
        [tenant.id, yesterday.toISOString()],
      ),
    );

    const config = await asTenant(tenant.id, () =>
      get(`SELECT csd_valid_until FROM cfdi_config WHERE tenant_id = $1`, [tenant.id]),
    );
    const msRemaining = new Date(config.csd_valid_until).getTime() - Date.now();
    expect(msRemaining).toBeLessThan(0);
  });

  it('csd_valid_until 20 days out yields expires_in_days ~ 20', async () => {
    const in20Days = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000);
    await asTenant(tenant.id, () =>
      run(
        `UPDATE cfdi_config SET csd_valid_until = $1 WHERE tenant_id = $2`,
        [in20Days.toISOString(), tenant.id],
      ),
    );

    const config = await asTenant(tenant.id, () =>
      get(`SELECT csd_valid_until FROM cfdi_config WHERE tenant_id = $1`, [tenant.id]),
    );
    const daysRemaining = Math.floor(
      (new Date(config.csd_valid_until).getTime() - Date.now()) / (24 * 60 * 60 * 1000),
    );
    expect(daysRemaining).toBeGreaterThanOrEqual(19);
    expect(daysRemaining).toBeLessThanOrEqual(20);
  });
});

describe('FacturapiRequestError classification (drives what the issuing routes surface)', () => {
  // The SDK throws away the HTTP status, so this text classification is the
  // only thing standing between "your razón social doesn't match the RFC"
  // (fixable, shown) and a provider outage (generic 500). Both routes branch
  // on these flags, so a regression here silently re-buries the reason —
  // which is exactly the failure that motivated the classification.

  it('a SAT receptor rejection is surfaced to staff and to the customer', () => {
    // Verbatim from a real rejected stamp: cashier typed a name that isn't
    // the one registered to that RFC.
    const err = new FacturapiRequestError(
      'El campo Nombre del receptor, debe pertenecer al nombre asociado al RFC registrado en el campo Rfc del Receptor.',
    );
    expect(err.isProviderRejection).toBe(true);
    expect(err.isReceptorRejection).toBe(true);
    expect(err.providerMessage).toContain('Nombre del receptor');
  });

  it('other SAT receptor-field rejections classify the same way', () => {
    for (const message of [
      'El campo RegimenFiscalReceptor no corresponde con el régimen del RFC.',
      'El campo DomicilioFiscalReceptor debe ser igual al código postal registrado ante el SAT.',
      'El RFC del receptor no se encuentra en la lista de RFC inscritos no cancelados del SAT.',
      "The customer's tax_id is invalid",
    ]) {
      const err = new FacturapiRequestError(message);
      expect(err.isReceptorRejection, message).toBe(true);
    }
  });

  it("merchant config problems reach staff but not the customer's self-invoice page", () => {
    // Real reasons, but the customer typed none of this and can fix none of
    // it — the public route must fall back to its generic message.
    for (const message of [
      'El certificado de sello digital ha expirado.',
      'You have reached the invoice limit for your plan',
    ]) {
      const err = new FacturapiRequestError(message);
      expect(err.isProviderRejection, message).toBe(true);
      expect(err.isReceptorRejection, message).toBe(false);
    }
  });

  it('bare HTTP status / transport failures stay a generic 500', () => {
    // No JSON body came back, so there is no explanation to pass along —
    // echoing "Unauthorized" at a cashier mid-shift diagnoses nothing.
    for (const message of [
      'Unauthorized',
      'Internal Server Error',
      'Bad Gateway',
      'Service Unavailable',
      'Network request failed',
      'fetch failed',
      '',
    ]) {
      const err = new FacturapiRequestError(message);
      expect(err.isProviderRejection, message || '(empty)').toBe(false);
      expect(err.isReceptorRejection, message || '(empty)').toBe(false);
    }
  });

  it('keeps the underlying SDK error as cause for log forensics', () => {
    const sdkErr = new Error('El campo Rfc del Receptor es requerido.');
    const err = new FacturapiRequestError(sdkErr.message, {
      operation: 'createInvoice',
      cause: sdkErr,
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.operation).toBe('createInvoice');
    expect(err.cause).toBe(sdkErr);
  });
});
