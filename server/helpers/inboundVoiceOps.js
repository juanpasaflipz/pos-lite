// Channel-agnostic inbound voice-ops engine.
//
// Extracted from routes/twilio-inbound.js (2026-07-24) so the SAME flow serves
// two transports:
//   - Twilio webhook  → routes/twilio-inbound.js  (WhatsApp via Twilio + SMS)
//   - Meta Cloud API  → routes/wa-cloud-inbound.js (WhatsApp coexistence number)
//
// The route owns transport concerns (signature verification, payload parsing,
// media download, how to send a reply). This module owns the business flow:
//
// Flow (new message from a known employee):
//   resolve employee by phone → if media: Whisper transcribe (audio) or
//   Claude vision (receipt image) → Claude intent parse → write voice_intents
//   row (pending_confirm) → reply with SI/NO prompt.
//
// Flow (confirmation reply from known employee):
//   find most recent pending_confirm for this employee → if SI: executeIntent()
//   inside withTenant() and reply success; if NO: mark cancelled; if unclear
//   with a pending: re-prompt.
//
// Idempotency: voice_intents.twilio_message_sid is UNIQUE; it stores the
// Twilio MessageSid OR the Cloud API wamid — retries no-op either way.
//
// Multi-tenant safety: the Twilio number also carries outbound loyalty SMS, and
// the coexistence number is the restaurant's public to-go line. Senders that
// aren't employees are delegated to `onUnknownSender` so each transport picks
// its own policy (Twilio: hint; Cloud API: stay silent — a human answers).

import { adminSql, withTenant, get, run } from '../db/index.js';
import { transcribeAudio } from './whisper.js';
import {
  parseVoiceIntent,
  buildConfirmationMessage,
  parseConfirmReply,
  executeIntent,
  buildSuccessMessage,
  enrichItemBindings,
} from './voiceIntent.js';
import { parseReceiptImage, persistReceiptBuffer } from './receiptVision.js';

const PENDING_TTL_MIN = 60;

// Build the set of phone formats to try when matching a sender.
// WhatsApp sends MX as `+52` + 10 digits; SMS often comes with `+521` (the
// MX mobile prefix). Stored values can be either. Generate all common forms.
export function phoneVariants(rawPhone) {
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
    // loyalty_customers stores MX phones as bare 10 digits (see
    // normalizePhone in helpers/loyalty.js). Add that form so the
    // loyalty match works when the transport sends +52-prefixed E.164.
    out.add(digits.slice(-10));
  }
  return out;
}

// Cross-tenant employee lookup via adminSql (bypasses RLS — webhook is
// platform-level). Picks the most recently created match if a phone is
// shared across tenants (rare; documented in scope as one-tenant pilot).
export async function resolveEmployeeByPhone(rawPhone) {
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
export async function isLoyaltyCustomerPhone(rawPhone) {
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

/**
 * Handle one inbound message. The transport route builds `msg` and acks the
 * webhook itself; this function never throws for expected failures (it
 * replies to the sender instead) but may throw on programmer error.
 *
 * @param {object} msg
 * @param {string}  msg.messageId    Transport message id (Twilio MessageSid or WA wamid) — idempotency key. May be null.
 * @param {string}  msg.fromPhone    Sender phone, no `whatsapp:` prefix (E.164 or close — phoneVariants absorbs formats).
 * @param {string}  msg.toPhone      Receiving business number, no prefix. Stored on the voice_intents row.
 * @param {string}  msg.body         Text body ('' if none).
 * @param {'whatsapp'|'sms'} msg.channel  Media is only processed on 'whatsapp'.
 * @param {'whatsapp'|'sms'} [msg.source] voice_intents.source value; defaults to msg.channel.
 * @param {boolean} msg.hasMedia     Whether the message carries a media attachment.
 * @param {string}  [msg.mediaRef]   Transport reference for the media (Twilio URL or `wa-cloud:media:<id>`); stored as media_url fallback.
 * @param {() => Promise<{buffer: Buffer, contentType: string}>} [msg.fetchMedia]  Downloads the media. Required when hasMedia.
 * @param {(text: string) => Promise<any>} msg.reply  Sends a reply to the sender on the same channel.
 * @param {(info: {fromPhone: string, isLoyalty: boolean}) => Promise<void>} [msg.onUnknownSender]
 *        Called (instead of the default hint) when the sender is not an
 *        employee. The Cloud API route uses this to stay silent so customers
 *        ordering to-go never hear from the voice-ops bot.
 */
export async function handleInboundVoiceOps(msg) {
  const {
    messageId, fromPhone, toPhone, channel,
    hasMedia, mediaRef, fetchMedia, reply, onUnknownSender,
  } = msg;
  const body = String(msg.body || '').trim();
  const source = msg.source || channel;
  const channelIsWA = channel === 'whatsapp';

  const employee = await resolveEmployeeByPhone(fromPhone);

  if (!employee) {
    const isLoyalty = await isLoyaltyCustomerPhone(fromPhone);
    if (onUnknownSender) {
      await onUnknownSender({ fromPhone, isLoyalty });
      return;
    }
    // Default (Twilio) policy: silent ack for anyone who's a loyalty customer
    // or just unknown — the Twilio number doubles as the loyalty SMS sender,
    // so we never want to confuse a customer replying to a stamp message.
    if (isLoyalty) return;
    // Unknown non-customer: send one friendly hint via the same channel,
    // then nothing more (a real staff onboarding has them ask their manager).
    await reply('No reconozco tu número. Pide al administrador que registre tu teléfono en el sistema.');
    return;
  }

  // Idempotency: skip if we've already processed this message id.
  if (messageId) {
    const dup = await adminSql`
      SELECT id FROM voice_intents WHERE twilio_message_sid = ${messageId} LIMIT 1
    `;
    if (dup.length > 0) return;
  }

  // === Confirmation reply path ===
  if (!hasMedia && body) {
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
          await reply(buildSuccessMessage(parsed.intent, result));
        } catch (err) {
          console.error('[VoiceOps] execute failed:', err.message);
          await withTenant(employee.tenant_id, async () => {
            await run(
              `UPDATE voice_intents SET status = 'failed', failure_reason = $1 WHERE id = $2`,
              [err.message?.slice(0, 500) || 'unknown', pending.id]
            );
          });
          await reply(`❌ No pude guardar: ${err.message}. Intenta de nuevo.`);
        }
        return;
      }
      if (replyKind === 'cancel') {
        await withTenant(employee.tenant_id, async () => {
          await run(`UPDATE voice_intents SET status = 'cancelled' WHERE id = $1`, [pending.id]);
        });
        await reply('Cancelado.');
        return;
      }
      // Unclear reply with a pending intent — re-prompt with the same draft.
      await reply(`No entendí. Responde SI o NO.\n\n${pending.draft_summary || ''}`);
      return;
    }
    // No pending intent — text replies that aren't a new action just get a hint.
    if (replyKind !== 'unclear') {
      // Same guard as the new-intent path: if the sender is also a loyalty
      // customer, silent-ack instead of surfacing voice-ops chatter.
      if (await isLoyaltyCustomerPhone(fromPhone)) return;
      await reply('No hay nada pendiente que confirmar. Manda una nota de voz o texto para registrar merma, compra o conteo.');
      return;
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
  if (channelIsWA && hasMedia && fetchMedia) {
    let buffer, contentType;
    try {
      ({ buffer, contentType } = await fetchMedia());
      mediaUrlStored = mediaRef || null;
      mediaTypeStored = contentType;
    } catch (err) {
      console.error('[VoiceOps] media fetch failed:', err.message);
      await reply('❌ No pude descargar el archivo. Intenta de nuevo.');
      return;
    }

    if (contentType && contentType.startsWith('image/')) {
      try {
        parsed = await withTenant(employee.tenant_id, async () =>
          parseReceiptImage(buffer, contentType, body)
        );
        // Persist the photo so the expense keeps a stable URL after the
        // transport media URL expires (Twilio URLs and Cloud API media ids
        // both go stale). Non-fatal — voice_intents.media_url still has the
        // transport reference as a fallback.
        try {
          const persistedUrl = await persistReceiptBuffer(buffer, contentType);
          mediaUrlStored = persistedUrl;
          if (parsed && typeof parsed === 'object') parsed.receipt_image_url = persistedUrl;
        } catch (persistErr) {
          console.warn('[VoiceOps] receipt persist failed (non-fatal):', persistErr.message);
        }
        transcript = body || '[receipt photo]';
      } catch (err) {
        console.error('[VoiceOps] receipt vision failed:', err.message);
        await reply('❌ No pude leer la foto del recibo. Intenta con otra foto o escríbeme los datos.');
        return;
      }
    } else if (contentType && contentType.startsWith('audio/')) {
      try {
        transcript = await transcribeAudio(buffer, contentType, { language: 'es' });
      } catch (err) {
        console.error('[VoiceOps] transcription failed:', err.message);
        await reply('❌ No pude transcribir el audio. Intenta de nuevo o escribe el mensaje.');
        return;
      }
    } else {
      await reply('No puedo leer este tipo de archivo. Manda foto del recibo o nota de voz.');
      return;
    }
  }

  if (!parsed && !transcript) {
    const hint = channelIsWA
      ? 'Manda foto del recibo, nota de voz, o escribe lo que quieres registrar.'
      : 'Escribe lo que quieres registrar (ej: "tiré 3 burritos" o "llegaron 10 kilos de pollo de Sigma, 1500 pesos").';
    await reply(hint);
    return;
  }

  if (!parsed) {
    try {
      parsed = await withTenant(employee.tenant_id, async () => parseVoiceIntent(transcript));
    } catch (err) {
      console.error('[VoiceOps] intent parse failed:', err.message);
      await reply('❌ No pude procesar el mensaje. Intenta de nuevo.');
      return;
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
      console.warn('[VoiceOps] enrichment failed (non-fatal):', err.message);
    }
  }

  const summary = buildConfirmationMessage(parsed);
  // A receipt photo may parse cleanly (vendor + total) with zero matched
  // inventory lines — e.g. a terminal slip. Allow record_purchase to be
  // executable on a valid total alone; executePurchase handles empty items[].
  const hasMatchedItems = Array.isArray(parsed.items)
    && parsed.items.some((it) => it.inventory_item_id || it.menu_item_id || it._will_create);
  // For counts, _unmatched items become actionable via AGREGAR (which promotes
  // them to _will_create on the confirm reply). The confirmation message
  // already advertises that path, so the row must be pending_confirm to be
  // findable when the owner taps AGREGAR.
  const hasUnmatchedForCount = parsed.intent === 'count_inventory'
    && Array.isArray(parsed.items)
    && parsed.items.some((it) => it._unmatched && it.raw_name);
  const hasValidPurchaseTotal = parsed.intent === 'record_purchase'
    && Number(parsed.total_amount) > 0;
  const isExecutable = ['log_waste', 'record_purchase', 'count_inventory', 'toggle_menu_item'].includes(parsed.intent)
    && (hasMatchedItems || hasUnmatchedForCount || hasValidPurchaseTotal);

  await withTenant(employee.tenant_id, async () => {
    await run(
      `INSERT INTO voice_intents
         (employee_id, source, twilio_message_sid, from_phone, to_phone,
          raw_body, media_url, media_content_type, transcript, parsed_json,
          draft_action, draft_summary, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        employee.id, source,
        messageId || null, fromPhone, toPhone || null,
        body || null, mediaUrlStored, mediaTypeStored, transcript,
        JSON.stringify(parsed), parsed.intent || 'unknown', summary,
        isExecutable ? 'pending_confirm' : 'unrecognized',
      ]
    );
  });

  // If the reply didn't parse as a real voice-op AND the sender is also a
  // loyalty customer, silent-ack instead of the "no entendí" prompt. Covers
  // the case where an owner (registered as both employee AND loyalty customer)
  // casually replies to a loyalty SMS. Legit voice-ops from the same phone
  // still work — they set isExecutable=true and skip this branch.
  if (!isExecutable && (await isLoyaltyCustomerPhone(fromPhone))) {
    return;
  }

  await reply(summary);
}
