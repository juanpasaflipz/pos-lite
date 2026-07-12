// Sandbox smoke for the generic-concept CFDI pipeline.
//
// Purpose: prove that Facturapi's own rounding of our (subtotal, IVA rate)
// pair produces a stamped Total equal to the ticket total, cent-for-cent,
// on the adversarial totals unit tests can't cover. Unit tests exercise
// splitTaxInclusive locally; this script exercises Facturapi's server-side
// recompute end-to-end.
//
// Run:
//   FACTURAPI_TEST_KEY=sk_test_... node scripts/smoke-cfdi-generic.mjs
//
// Every stamp is against Facturapi's sandbox. No SAT PAC round-trip happens
// in test mode, so nothing "real" is created — but the tax math is real.

import FacturapiPkg from 'facturapi';
import { buildGenericInvoicePayload, verifyStampedTotal, extractCfdiTotals } from '../server/helpers/cfdiConcept.js';
import { toCents } from '../server/helpers/money.js';

const Facturapi = FacturapiPkg?.default || FacturapiPkg;

const KEY = process.env.FACTURAPI_TEST_KEY;
if (!KEY || !KEY.startsWith('sk_test_')) {
  console.error('Refusing to run: FACTURAPI_TEST_KEY must be a Facturapi sandbox key (sk_test_...)');
  process.exit(2);
}

const client = new Facturapi(KEY);

// Adversarial ticket totals chosen to stress rounding:
//   - $100.01: forces splitTaxInclusive drift reconciliation (naive iva
//     would be 1 cent off).
//   - $73.37, $288.37, $99.99: from the spec's list, mixed rounding cases.
const TICKET_TOTALS = [100.01, 73.37, 288.37, 99.99];

// Público en general receptor + global periodicity node. XAXX010101000 is
// SAT-mandated for anonymous aggregations; Facturapi sandbox accepts it
// universally so this smoke doesn't depend on a real test customer being
// provisioned on the org.
const RECEPTOR = {
  rfc: 'XAXX010101000',
  name: 'PUBLICO EN GENERAL',
  tax_regime: '616',
  postal_code: '01000',
  uso_cfdi: 'S01',
};

const now = new Date();
const GLOBAL = {
  periodicity: 'day',
  months: String(now.getMonth() + 1).padStart(2, '0'),
  year: now.getFullYear(),
};

const CONFIG = {}; // no series override in sandbox

let passed = 0;
let failed = 0;
const results = [];

for (const total of TICKET_TOTALS) {
  const label = `$${total.toFixed(2)}`;
  process.stdout.write(`[smoke] ${label} … `);

  try {
    const { payload, subtotalCents, taxCents, totalCents } = buildGenericInvoicePayload({
      order: { total },
      receptor: RECEPTOR,
      config: CONFIG,
      formaPago: '01',
      metodoPago: 'PUE',
      global: GLOBAL,
    });

    const invoice = await client.invoices.create(payload);
    const check = verifyStampedTotal(invoice, totalCents);
    const stampedTotalCents = Number.isFinite(invoice.total) ? toCents(invoice.total) : null;

    // Pull the XML and extract SAT-authoritative SubTotal + IVA.
    let xmlExtract = null;
    try {
      const xmlStream = await client.invoices.downloadXml(invoice.id);
      const chunks = [];
      for await (const chunk of xmlStream) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      xmlExtract = extractCfdiTotals(Buffer.concat(chunks).toString('utf8'));
    } catch (xmlErr) {
      console.warn(`  (XML fetch failed for ${invoice.id}: ${xmlErr.message})`);
    }

    const line = {
      ticket_total: total,
      advisory_subtotal_cents: subtotalCents,
      advisory_tax_cents: taxCents,
      xml_subtotal_cents: xmlExtract?.subtotalCents ?? null,
      xml_tax_cents: xmlExtract?.taxCents ?? null,
      xml_total_cents: xmlExtract?.totalCents ?? null,
      advisory_matches_xml:
        xmlExtract != null &&
        xmlExtract.subtotalCents === subtotalCents &&
        xmlExtract.taxCents === taxCents,
      stamped_total: invoice.total,
      stamped_total_cents: stampedTotalCents,
      delta_cents: stampedTotalCents != null ? stampedTotalCents - totalCents : null,
      uuid: invoice.uuid || null,
      facturapi_id: invoice.id,
      verify_ok: check.ok,
    };
    results.push(line);

    if (check.ok) {
      passed += 1;
      console.log(`OK  stamped=${invoice.total} uuid=${invoice.uuid || '(sandbox)'}`);
    } else {
      failed += 1;
      console.log(
        `FAIL expected_cents=${check.expected} actual_cents=${check.actual} delta=${check.deltaCents}`,
      );
    }

    // Best-effort cancel of the sandbox stamp so we don't leave test docs
    // around. Sandbox cancels don't hit SAT; motive '02' is fine.
    try {
      await client.invoices.cancel(invoice.id, { motive: '02' });
    } catch (cancelErr) {
      console.warn(`  (couldn't cancel sandbox stamp ${invoice.id}: ${cancelErr.message})`);
    }
  } catch (err) {
    failed += 1;
    console.log(`ERROR ${err.message}`);
    results.push({ ticket_total: total, error: err.message });
  }
}

console.log('\n[smoke] summary');
console.table(results);
console.log(`\n[smoke] ${passed}/${TICKET_TOTALS.length} verified; ${failed} failed`);

process.exit(failed === 0 ? 0 : 1);
