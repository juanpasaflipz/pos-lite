// Tenant-facing WhatsApp ops status.
//
// Backs the "WhatsApp" card in the owner cockpit. Answers the two questions an
// owner actually has: which number do we message, and who is allowed to.
//
// Only employees with a phone on file can drive voice/photo ops — the inbound
// engine matches the SENDER against employees.phone (see
// helpers/inboundVoiceOps.js). That is the single most common support
// question ("I sent a photo and nothing happened"), so the answer lives here
// next to the instructions rather than buried in staff management.
//
// Phones come back masked. The owner already sees full numbers in Staff; this
// endpoint is readable by any logged-in employee, so it shows enough to
// confirm "yes, my number is the one registered" and no more.

import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { all } from '../db/index.js';
import { cloudConfigFor, isCloudConfigured } from '../helpers/waCloud.js';
import { getServiceCredentials } from '../helpers/tenantCredentials.js';

const router = Router();

/** Keep the last 4 digits so a person can recognize their own number. */
export function maskPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 4) return '••••';
  return `•••• ${digits.slice(-4)}`;
}

/** Group a bare MX number into something readable: +52 55 1234 5678. */
export function prettyPhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return null;
  const local = digits.length > 10 ? digits.slice(-10) : digits;
  const country = digits.length > 10 ? digits.slice(0, digits.length - 10) : '';
  if (local.length !== 10) return `+${digits}`;
  return `${country ? '+' + country + ' ' : ''}${local.slice(0, 2)} ${local.slice(2, 6)} ${local.slice(6)}`.trim();
}

// GET /api/whatsapp/status
router.get('/status', requireAuth(), async (req, res) => {
  try {
    const tenantId = req.tenant?.id;

    // Deliberately DB-only (no envMap): `source` below keys on whether this
    // tenant has its own row, so an env fallback here would report every
    // platform-number tenant as 'tenant'.
    const creds = await getServiceCredentials(tenantId, 'whatsapp', {});
    const cfg = await cloudConfigFor(tenantId);
    const connected = isCloudConfigured(cfg);

    // Distinguish "this restaurant connected its own number" from "we're
    // falling back to the platform number" — the instructions differ.
    const source = creds.phone_number_id ? 'tenant' : (connected ? 'platform' : 'none');

    // A tenant on the platform number has no credential row to read the
    // display number from, so it comes from env. Without this the screen says
    // "connected" and shows no number to message — the one thing it exists to
    // answer. Unset env just hides the number; it never fakes one.
    const displayRaw = creds.display_phone_number
      || (source === 'platform' ? process.env.WA_CLOUD_DISPLAY_PHONE_NUMBER : '');

    const employees = await all(
      `SELECT id, name, role, phone
       FROM employees
       WHERE active = true
       ORDER BY name ASC`
    );

    const eligible = employees
      .filter((e) => e.phone && String(e.phone).trim())
      .map((e) => ({
        id: e.id,
        name: e.name,
        role: e.role,
        phone_masked: maskPhone(e.phone),
      }));

    res.json({
      connected,
      source,
      display_phone_number: prettyPhone(displayRaw) || null,
      eligible,
      eligible_count: eligible.length,
      missing_phone_count: employees.length - eligible.length,
    });
  } catch (error) {
    console.error('Error fetching WhatsApp status:', error);
    res.status(500).json({ error: 'Failed to fetch WhatsApp status' });
  }
});

export default router;
