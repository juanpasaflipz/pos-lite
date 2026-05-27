// Inbound Twilio webhook → voice ops. Handles WhatsApp + SMS on the same route.
//
// Channel detection: `From` starts with `whatsapp:` for WA, plain E.164 for SMS.
// Voice notes (audio attachments) only work on WhatsApp — SMS in MX strips
// MMS audio inconsistently across carriers, so we transcribe only when WA.
//
// Multi-tenant safety: this number also carries outbound loyalty SMS, so
// customers who reply to a stamp/receipt message will hit this webhook. We
// silently ack any sender that's a loyalty_customers row in any tenant —
// the existing 24-hour Twilio session window lets us reply if we wanted to,
// but customers replying to loyalty messages should get silence, not a
// confused bot interaction.
//
// Flow (new message from a known employee):
//   verify signature → resolve employee by phone → if WA media: Whisper
//   transcribe → Claude intent parse → write voice_intents row
//   (pending_confirm) → reply with SI/NO prompt.
//
// Flow (confirmation reply from known employee):
//   verify signature → find most recent pending_confirm for this employee
//   → if SI: executeIntent() inside withTenant() and reply success; if NO:
//   mark cancelled; if unclear with a pending: re-prompt.
//
// Idempotency: twilio_message_sid is UNIQUE on voice_intents; retries no-op.

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
  enrichItemBindings,
} from '../helpers/voiceIntent.js';
import { parseReceiptImage, persistReceiptBuffer } from '../helpers/receiptVision.js';
import { sendWhatsAppText, sendSMSReply } from '../helpers/twilio.js';

const router = Router();

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

// Twilio webhook signature: HMAC-SHA1(authToken, url + concat(sortedKey + sortedValue ...)) → base64.
// Behind Railway's proxy chain we try a few URL permutations because the
// reverse proxy can yield slightly different host/protocol than what Twilio
// signed. https://www.twilio.com/docs/usage/webhooks/webhooks-security
function verifyTwilioSignature(req, authToken) {
  if (!authToken) return false;
  const sig = req.get('x-twilio-signature');
  if (!sig) return false;

  const proto = req.protocol;
  const xfHost = req.get('x-forwarded-host');
  const host = req.get('host');
  const candidates = new Set();
  for (const h of [xfHost, host].filter(Boolean)) {
    for (const p of [proto, 'https', 'http']) {
      candidates.add(`${p}://${h}${req.originalUrl}`);
      candidates.add(`${p}://${h}${req.originalUrl.replace(/\/$/, '')}`);
    }
  }

  const params = req.body || {};
  const keys = Object.keys(params).sort();
  let suffix = '';
  for (const k of keys) suffix += k + (params[k] == null ? '' : String(params[k]));

  for (const url of candidates) {
    const expected = crypto.createHmac('sha1', authToken).update(url + suffix).digest('base64');
    try {
      const a = Buffer.from(sig);
      const b = Buffer.from(expected);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
    } catch {}
  }
  return false;
}

// Build the set of phone formats to try when matching a sender.
// WhatsApp sends MX as `+52` + 10 digits; SMS often comes with `+521` (the
// MX mobile prefix). Stored values can be either. Generate all common forms.
function phoneVariants(rawPhone) {
  const out = new Set();
  const raw = String(rawPhone || '').trim();
  if (!raw) return out;
  out.add(raw);
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('52')) out.add(`+521${digits.slice(2)}`);
  if (digits.length === 13 && digits.startsWith('521')) out.add(`+52${digits.slice(3)}`);
  if (digits.length >= 10) {
    out.add(`+52${digits.slice(-10)}`);
    out.add(`+521${digits.slice(-10)}`);
  }
  return out;
}

// Cross-tenant employee lookup via adminSql (bypasses RLS — webhook is
// platform-level). Picks the most recently created match if a phone is
// shared across tenants (rare; documented in scope as one-tenant pilot).
async function resolveEmployeeByPhone(rawPhone) {
  const tries = phoneVariants(rawPhone);
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

// Check if a phone belongs to any loyalty customer (any tenant). Used to
// silently swallow inbound replies to loyalty SMS — customers shouldn't
// get a confusing bot response when replying to a stamp/receipt message.
async function isLoyaltyCustomerPhone(rawPhone) {
  const tries = phoneVariants(rawPhone);
  for (const phone of tries) {
    const rows = await adminSql`SELECT 1 FROM loyalty_customers WHERE phone = ${phone} LIMIT 1`;
    if (rows.length > 0) return true;
  }
  return false;
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
      `UPDATE voice_intents SET status = 'expired'
       WHERE employee_id = $1 AND status = 'pending_confirm'`,
      [employeeId]
    );
  });
}

// Channel-aware reply. Picks WA or SMS based on the inbound `From` (we
// always reply on the same channel the message arrived on). The `from`
// override is the Twilio number that received the inbound — required so
// SMS replies originate from JUANBERTOS not the platform default.
async function reply(inboundFrom, inboundTo, body) {
  if (isWhatsApp(inboundFrom)) {
    return sendWhatsAppText(inboundFrom, body, { from: inboundTo });
  }
  return sendSMSReply(inboundFrom, body, { from: inboundTo });
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
  const channelIsWA = isWhatsApp(from);
  const fromPhone = stripWaPrefix(from);

  const employee = await resolveEmployeeByPhone(fromPhone);

  if (!employee) {
    // Silent ack for anyone who's a loyalty customer or just unknown — this
    // number doubles as the loyalty SMS sender, so we never want to confuse
    // a customer replying to a stamp/receipt message.
    if (await isLoyaltyCustomerPhone(fromPhone)) return ack();
    // Unknown non-customer: send one friendly hint via the same channel,
    // then nothing more (a real staff onboarding has them ask their manager).
    await reply(from, to,
      'No reconozco tu número. Pide al administrador que registre tu teléfono en el sistema.');
    return ack();
  }

  // Idempotency: skip if we've already processed this MessageSid.
  if (messageSid) {
    const dup = await adminSql`
      SELECT id FROM voice_intents WHERE twilio_message_sid = ${messageSid} LIMIT 1
    `;
    if (dup.length > 0) return ack();
  }

  // === Confirmation reply path ===
  if (numMedia === 0 && body) {
    const replyKind = parseConfirmReply(body);
    const pending = await findPendingIntent(employee.tenant_id, employee.id);
    if (pending) {
      if (replyKind === 'confirm' || replyKind === 'add') {
        try {
          // parsed_json is a JSONB column but porsager/postgres + unsafe()
          // round-trips it as a JSON-encoded string instead of a JS object.
          // Parse defensively so historical and current rows both work.
          let parsed = pending.parsed_json;
          if (typeof parsed === 'string') parsed = JSON.parse(parsed);
          // AGREGAR on a count = promote unmatched items to _will_create so
          // executeCount inserts them at counted qty. On other intents
          // AGREGAR behaves like SI (purchases already auto-create via SI).
          if (replyKind === 'add' && parsed.intent === 'count_inventory') {
            for (const it of parsed.items || []) {
              if (it._unmatched && it.raw_name) {
                it._will_create = true;
                delete it._unmatched;
              }
            }
          }
          const result = await withTenant(employee.tenant_id, async () => {
            const out = await executeIntent(parsed, employee.id);
            await run(
              `UPDATE voice_intents
               SET status = 'confirmed', confirmed_at = NOW(),
                   executed_resource_type = $1, executed_resource_id = $2
               WHERE id = $3`,
              [out.resource_type, out.resource_ids[0] || null, pending.id]
            );
            return out;
          });
          await reply(from, to, buildSuccessMessage(parsed.intent, result));
        } catch (err) {
          console.error('[TwilioInbound] execute failed:', err.message);
          await withTenant(employee.tenant_id, async () => {
            await run(
              `UPDATE voice_intents SET status = 'failed', failure_reason = $1 WHERE id = $2`,
              [err.message?.slice(0, 500) || 'unknown', pending.id]
            );
          });
          await reply(from, to, `❌ No pude guardar: ${err.message}. Intenta de nuevo.`);
        }
        return ack();
      }
      if (replyKind === 'cancel') {
        await withTenant(employee.tenant_id, async () => {
          await run(`UPDATE voice_intents SET status = 'cancelled' WHERE id = $1`, [pending.id]);
        });
        await reply(from, to, 'Cancelado.');
        return ack();
      }
      // Unclear reply with a pending intent — re-prompt with the same draft.
      await reply(from, to, `No entendí. Responde SI o NO.\n\n${pending.draft_summary || ''}`);
      return ack();
    }
    // No pending intent — text replies that aren't a new action just get a hint.
    if (replyKind !== 'unclear') {
      await reply(from, to, 'No hay nada pendiente que confirmar. Manda una nota de voz o texto para registrar merma, compra o conteo.');
      return ack();
    }
    // Fall through: treat text as a new intent ("tiré 3 burritos" typed).
  }

  // === New intent path ===
  await expireStalePending(employee.tenant_id, employee.id);

  let transcript = body;
  let mediaUrlStored = null;
  let mediaTypeStored = null;
  let parsed = null;

  // Media on WhatsApp only — MX SMS strips MMS attachments inconsistently.
  // Audio → Whisper → voice-intent path. Image → Claude vision → receipt
  // path (already returns the voice-intent shape, so downstream is shared).
  if (channelIsWA && numMedia > 0 && mediaUrl0) {
    let buffer, contentType;
    try {
      ({ buffer, contentType } = await fetchTwilioMedia(mediaUrl0, {
        accountSid: TWILIO_SID, authToken: TWILIO_TOKEN,
      }));
      mediaUrlStored = mediaUrl0;
      mediaTypeStored = contentType;
    } catch (err) {
      console.error('[TwilioInbound] media fetch failed:', err.message);
      await reply(from, to, '❌ No pude descargar el archivo. Intenta de nuevo.');
      return ack();
    }

    if (contentType && contentType.startsWith('image/')) {
      try {
        parsed = await withTenant(employee.tenant_id, async () =>
          parseReceiptImage(buffer, contentType, body)
        );
        // Persist the photo so the expense keeps a stable URL after the
        // Twilio media URL expires. Non-fatal — voice_intents.media_url
        // still has the Twilio URL as a fallback.
        try {
          const persistedUrl = await persistReceiptBuffer(buffer, contentType);
          mediaUrlStored = persistedUrl;
          if (parsed && typeof parsed === 'object') parsed.receipt_image_url = persistedUrl;
        } catch (persistErr) {
          console.warn('[TwilioInbound] receipt persist failed (non-fatal):', persistErr.message);
        }
        transcript = body || '[receipt photo]';
      } catch (err) {
        console.error('[TwilioInbound] receipt vision failed:', err.message);
        await reply(from, to, '❌ No pude leer la foto del recibo. Intenta con otra foto o escríbeme los datos.');
        return ack();
      }
    } else if (contentType && contentType.startsWith('audio/')) {
      try {
        transcript = await transcribeAudio(buffer, contentType, { language: 'es' });
      } catch (err) {
        console.error('[TwilioInbound] transcription failed:', err.message);
        await reply(from, to, '❌ No pude transcribir el audio. Intenta de nuevo o escribe el mensaje.');
        return ack();
      }
    } else {
      await reply(from, to, 'No puedo leer este tipo de archivo. Manda foto del recibo o nota de voz.');
      return ack();
    }
  }

  if (!parsed && !transcript) {
    const hint = channelIsWA
      ? 'Manda foto del recibo, nota de voz, o escribe lo que quieres registrar.'
      : 'Escribe lo que quieres registrar (ej: "tiré 3 burritos" o "llegaron 10 kilos de pollo de Sigma, 1500 pesos").';
    await reply(from, to, hint);
    return ack();
  }

  if (!parsed) {
    try {
      parsed = await withTenant(employee.tenant_id, async () => parseVoiceIntent(transcript));
    } catch (err) {
      console.error('[TwilioInbound] intent parse failed:', err.message);
      await reply(from, to, '❌ No pude procesar el mensaje. Intenta de nuevo.');
      return ack();
    }
  }

  // Enrich purchase + count intents: server-side fuzzy match against inventory
  // for anything the parser couldn't bind. Purchases flag misses as _will_create
  // (auto-create on SI); counts flag misses as _unmatched (surfaced in the
  // confirmation, dropped on execute). Non-fatal — the intent still works
  // with whatever Claude bound directly.
  if (parsed.intent === 'record_purchase' || parsed.intent === 'count_inventory') {
    try {
      await withTenant(employee.tenant_id, async () => enrichItemBindings(parsed));
    } catch (err) {
      console.warn('[TwilioInbound] enrichment failed (non-fatal):', err.message);
    }
  }

  const summary = buildConfirmationMessage(parsed);
  // A receipt photo may parse cleanly (vendor + total) with zero matched
  // inventory lines — e.g. a terminal slip. Allow record_purchase to be
  // executable on a valid total alone; executePurchase handles empty items[].
  const hasMatchedItems = Array.isArray(parsed.items)
    && parsed.items.some((it) => it.inventory_item_id || it.menu_item_id || it._will_create);
  const hasValidPurchaseTotal = parsed.intent === 'record_purchase'
    && Number(parsed.total_amount) > 0;
  const isExecutable = ['log_waste', 'record_purchase', 'count_inventory', 'toggle_menu_item'].includes(parsed.intent)
    && (hasMatchedItems || hasValidPurchaseTotal);

  await withTenant(employee.tenant_id, async () => {
    await run(
      `INSERT INTO voice_intents
         (employee_id, source, twilio_message_sid, from_phone, to_phone,
          raw_body, media_url, media_content_type, transcript, parsed_json,
          draft_action, draft_summary, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        employee.id, channelIsWA ? 'whatsapp' : 'sms',
        messageSid || null, fromPhone, stripWaPrefix(to),
        body || null, mediaUrlStored, mediaTypeStored, transcript,
        JSON.stringify(parsed), parsed.intent || 'unknown', summary,
        isExecutable ? 'pending_confirm' : 'unrecognized',
      ]
    );
  });

  await reply(from, to, summary);
  return ack();
});

export default router;
