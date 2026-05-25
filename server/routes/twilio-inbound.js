// Inbound WhatsApp / SMS webhook → voice ops.
//
// Flow (new message):
//   verify Twilio signature → resolve employee by phone (cross-tenant lookup
//   via adminSql) → if media: fetch + Whisper → Claude intent parse → write
//   voice_intents row (status='pending_confirm') → reply with SI/NO prompt.
//
// Flow (confirmation reply):
//   verify signature → resolve employee → find most recent pending_confirm
//   row for this employee → if SI: executeIntent() inside withTenant() and
//   reply with success; if NO: mark cancelled; if unclear: re-prompt.
//
// Idempotency: twilio_message_sid is UNIQUE on voice_intents — if Twilio
// retries we no-op. WhatsApp/Twilio webhook timeout is 15s; the full flow
// (Whisper + Claude + reply send) fits inside that comfortably.

import { Router } from 'express';
import express from 'express';
import crypto from 'crypto';
import { adminSql, withTenant, get, run } from '../db/index.js';
import { fetchTwilioMedia, transcribeAudio } from '../helpers/whisper.js';
import {
  parseVoiceIntent,
  buildConfirmationMessage,
  parseConfirmReply,
  executeIntent,
  buildSuccessMessage,
} from '../helpers/voiceIntent.js';
import { sendWhatsAppText } from '../helpers/twilio.js';

const router = Router();

// Twilio sends application/x-www-form-urlencoded. Parser scoped to this router
// only so we don't disturb global JSON parsing.
router.use(express.urlencoded({ extended: false }));

const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const PENDING_TTL_MIN = 10;

function stripWaPrefix(addr) {
  return String(addr || '').replace(/^whatsapp:/, '').trim();
}

function isWhatsApp(addr) {
  return String(addr || '').startsWith('whatsapp:');
}

// Twilio webhook signature:
//   HMAC-SHA1(authToken, url + concat(sortedKey + sortedValue ...))  → base64
// docs: https://www.twilio.com/docs/usage/webhooks/webhooks-security
function verifyTwilioSignature(req, authToken) {
  if (!authToken) return false;
  const sig = req.get('x-twilio-signature');
  if (!sig) return false;
  const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
  const params = req.body || {};
  const keys = Object.keys(params).sort();
  let payload = url;
  for (const k of keys) payload += k + (params[k] == null ? '' : String(params[k]));
  const expected = crypto.createHmac('sha1', authToken).update(payload).digest('base64');
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// Cross-tenant employee lookup. Uses adminSql to bypass RLS — the inbound
// webhook is platform-level and doesn't yet have a tenant context. Tries the
// raw form first, then falls back to common MX variants (with/without the
// "1" mobile prefix). If multiple matches exist across tenants, picks the
// most recently active employee — see scope note: one-number-per-pilot in v1.
async function resolveEmployeeByPhone(rawPhone) {
  const tries = new Set();
  const raw = String(rawPhone || '').trim();
  if (!raw) return null;
  tries.add(raw);
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('52')) tries.add(`+521${digits.slice(2)}`);
  if (digits.length === 13 && digits.startsWith('521')) tries.add(`+52${digits.slice(3)}`);
  if (digits.length >= 10) tries.add(`+52${digits.slice(-10)}`);

  for (const phone of tries) {
    const rows = await adminSql`
      SELECT id, tenant_id, name, role, active
      FROM employees
      WHERE phone = ${phone} AND active = true
      ORDER BY id DESC LIMIT 1
    `;
    if (rows.length > 0) return rows[0];
  }
  return null;
}

async function findPendingIntent(tenantId, employeeId) {
  return withTenant(tenantId, async () => {
    const row = await get(
      `SELECT * FROM voice_intents
       WHERE employee_id = $1 AND status = 'pending_confirm'
         AND created_at > NOW() - INTERVAL '${PENDING_TTL_MIN} minutes'
       ORDER BY created_at DESC LIMIT 1`,
      [employeeId]
    );
    return row || null;
  });
}

async function expireStalePending(tenantId, employeeId) {
  await withTenant(tenantId, async () => {
    await run(
      `UPDATE voice_intents
       SET status = 'expired'
       WHERE employee_id = $1 AND status = 'pending_confirm'`,
      [employeeId]
    );
  });
}

router.post('/inbound', async (req, res) => {
  const ack = () => res.type('text/xml').send('<Response/>');

  if (!verifyTwilioSignature(req, TWILIO_TOKEN)) {
    console.warn('[TwilioInbound] Invalid signature');
    return res.status(403).send('Invalid signature');
  }

  const messageSid = req.body.MessageSid;
  const from = req.body.From;
  const to = req.body.To;
  const body = String(req.body.Body || '').trim();
  const numMedia = parseInt(req.body.NumMedia || '0', 10);
  const mediaUrl0 = req.body.MediaUrl0;
  const mediaType0 = req.body.MediaContentType0;

  if (!isWhatsApp(from)) {
    // v1 is WhatsApp-only. Quietly accept SMS (don't error) so Twilio doesn't retry.
    return ack();
  }

  const fromPhone = stripWaPrefix(from);
  const employee = await resolveEmployeeByPhone(fromPhone);

  if (!employee) {
    await sendWhatsAppText(from,
      'No reconozco tu número. Pide al administrador que registre tu teléfono en el sistema.',
      { from: to });
    return ack();
  }

  // Idempotency: if we've already processed this MessageSid, skip.
  if (messageSid) {
    const dup = await adminSql`
      SELECT id FROM voice_intents WHERE twilio_message_sid = ${messageSid} LIMIT 1
    `;
    if (dup.length > 0) return ack();
  }

  // === Confirmation reply path ===
  // Text-only message that matches SI/NO and there's a pending intent waiting.
  if (numMedia === 0 && body) {
    const reply = parseConfirmReply(body);
    const pending = await findPendingIntent(employee.tenant_id, employee.id);
    if (pending) {
      if (reply === 'confirm') {
        try {
          const parsed = pending.parsed_json;
          const result = await withTenant(employee.tenant_id, async () => {
            const out = await executeIntent(parsed, employee.id);
            await run(
              `UPDATE voice_intents
               SET status = 'confirmed',
                   confirmed_at = NOW(),
                   executed_resource_type = $1,
                   executed_resource_id = $2
               WHERE id = $3`,
              [out.resource_type, out.resource_ids[0] || null, pending.id]
            );
            return out;
          });
          await sendWhatsAppText(from, buildSuccessMessage(parsed.intent, result), { from: to });
        } catch (err) {
          console.error('[TwilioInbound] execute failed:', err.message);
          await withTenant(employee.tenant_id, async () => {
            await run(
              `UPDATE voice_intents SET status = 'failed', failure_reason = $1 WHERE id = $2`,
              [err.message?.slice(0, 500) || 'unknown', pending.id]
            );
          });
          await sendWhatsAppText(from, `❌ No pude guardar: ${err.message}. Intenta de nuevo.`, { from: to });
        }
        return ack();
      }
      if (reply === 'cancel') {
        await withTenant(employee.tenant_id, async () => {
          await run(`UPDATE voice_intents SET status = 'cancelled' WHERE id = $1`, [pending.id]);
        });
        await sendWhatsAppText(from, 'Cancelado.', { from: to });
        return ack();
      }
      // Unclear reply with a pending intent — re-prompt with the same draft.
      await sendWhatsAppText(from,
        `No entendí. Responde SI o NO.\n\n${pending.draft_summary || ''}`,
        { from: to });
      return ack();
    }
    // No pending intent — text replies that aren't a new action just get a hint.
    if (reply !== 'unclear') {
      await sendWhatsAppText(from, 'No hay nada pendiente que confirmar. Manda una nota de voz para registrar merma, compra o conteo.', { from: to });
      return ack();
    }
    // Fall through: treat text as a new intent (e.g. "tiré 3 burritos" typed instead of voiced).
  }

  // === New intent path ===
  // Expire any prior pending intent for this employee — starting a new one
  // makes SI ambiguous against the old one.
  await expireStalePending(employee.tenant_id, employee.id);

  let transcript = body;
  let mediaUrlStored = null;
  let mediaTypeStored = null;

  if (numMedia > 0 && mediaUrl0) {
    try {
      const { buffer, contentType } = await fetchTwilioMedia(mediaUrl0, {
        accountSid: TWILIO_SID, authToken: TWILIO_TOKEN,
      });
      mediaUrlStored = mediaUrl0;
      mediaTypeStored = contentType;
      transcript = await transcribeAudio(buffer, contentType, { language: 'es' });
    } catch (err) {
      console.error('[TwilioInbound] transcription failed:', err.message);
      await sendWhatsAppText(from, '❌ No pude transcribir el audio. Intenta de nuevo o escribe el mensaje.', { from: to });
      return ack();
    }
  }

  if (!transcript) {
    await sendWhatsAppText(from, 'Manda una nota de voz o escribe lo que quieres registrar.', { from: to });
    return ack();
  }

  let parsed;
  try {
    // parseVoiceIntent reads inventory_items — must be inside tenant context.
    parsed = await withTenant(employee.tenant_id, async () => parseVoiceIntent(transcript));
  } catch (err) {
    console.error('[TwilioInbound] intent parse failed:', err.message);
    await sendWhatsAppText(from, '❌ No pude procesar el mensaje. Intenta de nuevo.', { from: to });
    return ack();
  }

  const summary = buildConfirmationMessage(parsed);
  const isExecutable = ['log_waste', 'record_purchase', 'count_inventory'].includes(parsed.intent)
    && Array.isArray(parsed.items) && parsed.items.length > 0
    && parsed.items.some((it) => it.inventory_item_id);

  await withTenant(employee.tenant_id, async () => {
    await run(
      `INSERT INTO voice_intents
         (employee_id, source, twilio_message_sid, from_phone, to_phone,
          raw_body, media_url, media_content_type, transcript, parsed_json,
          draft_action, draft_summary, status)
       VALUES ($1, 'whatsapp', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        employee.id, messageSid || null, fromPhone, stripWaPrefix(to),
        body || null, mediaUrlStored, mediaTypeStored, transcript,
        JSON.stringify(parsed), parsed.intent || 'unknown', summary,
        isExecutable ? 'pending_confirm' : 'unrecognized',
      ]
    );
  });

  await sendWhatsAppText(from, summary, { from: to });
  return ack();
});

export default router;
