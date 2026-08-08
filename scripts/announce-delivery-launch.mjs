#!/usr/bin/env node
// One-time launch announcement: Juanberto's is live on Uber Eats, Rappi and
// DiDi Food (plus direct ordering). SMS to opted-in loyalty customers.
//
// Modeled on server/lib/postOrderReviewReminders.js: same production gate,
// hard tenant allowlist, idempotency via the loyalty_messages ledger
// (message_type='delivery_launch' — sendSMS writes the row), sequential sends
// with pacing. Safe to re-run: already-messaged customers are skipped.
//
// Usage:
//   node scripts/announce-delivery-launch.mjs             # dry run (default)
//   node scripts/announce-delivery-launch.mjs --send      # real send
import 'dotenv/config';
import { adminSql, withTenant } from '../server/db/index.js';
import { sendSMS } from '../server/helpers/twilio.js';

const TENANTS = ['juanbertos'];
const MESSAGE_TYPE = 'delivery_launch';
const PACING_MS = 300;

const BODY =
  "Juanberto's ya está en Uber Eats, Rappi y DiDi Food 🚀 y siempre con pedido " +
  'directo en juanbertos.com. ¡Pide como prefieras! Responde BAJA para no recibir mensajes.';

const send = process.argv.includes('--send');

// Local `npm run dev` points at prod Neon; the gate keeps a stray local run
// from texting real customers unless explicitly armed.
if (send && process.env.NODE_ENV !== 'production' && process.env.ENABLE_BACKGROUND_SMS !== 'true') {
  console.error('Refusing to send outside production (set ENABLE_BACKGROUND_SMS=true to override).');
  process.exit(1);
}

const candidates = await adminSql`
  SELECT lc.id, lc.tenant_id, lc.name, lc.phone, lc.country_code
  FROM loyalty_customers lc
  WHERE lc.tenant_id = ANY(${TENANTS}::text[])
    AND lc.sms_opt_in = true
    AND lc.phone IS NOT NULL AND lc.phone <> ''
    AND NOT EXISTS (
      SELECT 1 FROM loyalty_messages lm
      WHERE lm.customer_id = lc.id AND lm.message_type = ${MESSAGE_TYPE}
    )
  ORDER BY lc.id
`;

console.log(`[delivery-launch] ${candidates.length} recipient(s) pending`);
console.log(`[delivery-launch] body (${BODY.length} chars): ${BODY}`);
for (const c of candidates.slice(0, 5)) {
  console.log(`  sample: #${c.id} ${c.name || '(sin nombre)'} · ${String(c.phone).slice(0, 4)}******`);
}

if (!send) {
  console.log('[delivery-launch] DRY RUN — nothing sent. Re-run with --send to fire.');
  process.exit(0);
}

let sent = 0;
let failed = 0;
for (const c of candidates) {
  try {
    // withTenant so sendSMS resolves per-tenant Twilio creds and the
    // loyalty_messages ledger row lands under the right tenant.
    const sid = await withTenant(c.tenant_id, () =>
      sendSMS(c.phone, BODY, c.id, MESSAGE_TYPE, c.country_code || 'MX'),
    );
    if (sid) sent++;
    else failed++;
  } catch (err) {
    failed++;
    console.error(`[delivery-launch] #${c.id} failed:`, err.message);
  }
  await new Promise((r) => setTimeout(r, PACING_MS));
}

console.log(`[delivery-launch] done — sent ${sent}, failed ${failed}, of ${candidates.length}`);
process.exit(failed > 0 ? 2 : 0);
