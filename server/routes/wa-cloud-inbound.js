// Inbound Meta Cloud API webhook → voice ops (coexistence numbers).
//
// One webhook serves EVERY connected number — DK's own and each tenant
// restaurant's. Meta signs all of them with our Tech Provider app secret, so
// the signature gate is number-independent; the tenant comes from
// value.metadata.phone_number_id (the number that RECEIVED the message), and
// an unrecognized number is dropped rather than guessed at.
//
// These are WhatsApp Business APP numbers that also take the restaurant's
// to-go orders — a human answers customers from the phone. Policy here is the
// inverse of the Twilio route's:
//
//   - Employees (matched by phone) get the full voice-ops flow (voice note /
//     receipt photo / typed intent → SI/NO confirm), same engine as Twilio.
//   - EVERYONE ELSE GETS SILENCE. Customers ordering to-go, landing leads,
//     loyalty members — the human answers them from the app. No bot replies
//     until the order bot ships (it will hook in at `onUnknownSender`).
//   - `smb_message_echoes` (messages a human sends from the phone app) are
//     acknowledged and ignored. When the order bot lands, echoes become the
//     human-takeover signal (bot goes quiet where a human replied).
//
// Transport notes:
//   - Signature: X-Hub-Signature-256 (HMAC-SHA256 of the RAW body with the
//     app secret). index.js captures req.rawBody for /api/wa-cloud/* in its
//     express.json verify hook. Unsigned traffic is rejected unless
//     WA_CLOUD_ALLOW_UNSIGNED=on (onboarding/testing only).
//   - Ack fast, process async: Cloud API retries slow/non-200 deliveries for
//     hours. Whisper + Claude can exceed that budget, so we 200 immediately
//     and process in the background. Replays are safe — the engine's
//     idempotency key (voice_intents.twilio_message_sid) stores the wamid.

import { Router } from 'express';
import { handleInboundVoiceOps } from '../helpers/inboundVoiceOps.js';
import {
  isCloudConfigured,
  verifyCloudSignature,
  extractChanges,
  normalizeCloudFrom,
  messageText,
  messageMediaId,
  fetchCloudMedia,
  sendCloudText,
  markCloudRead,
  resolveTenantByPhoneNumberId,
  cloudConfigFor,
} from '../helpers/waCloud.js';

const router = Router();

// GET handshake: Meta (or the BSP) verifies the endpoint by echoing back
// hub.challenge when hub.verify_token matches ours.
router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token && token === process.env.WA_CLOUD_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  console.warn('[WACloud] webhook verification failed (mode/token mismatch)');
  return res.sendStatus(403);
});

async function processMessage(value, message) {
  const phoneNumberId = value.metadata?.phone_number_id;

  // Which of our numbers received this? That answers which tenant owns it.
  // A tenant with no stored credentials (DK's own pilot number) falls through
  // to the platform env config inside cloudConfigFor().
  const tenantId = await resolveTenantByPhoneNumberId(phoneNumberId);
  const cfg = await cloudConfigFor(tenantId);
  if (!isCloudConfigured(cfg)) {
    console.warn(`[WACloud] message for unknown/unconfigured phone_number_id=${phoneNumberId || 'n/a'} — dropped`);
    return;
  }

  const fromE164 = normalizeCloudFrom(message.from);
  const toPhone = value.metadata?.display_phone_number
    ? `+${String(value.metadata.display_phone_number).replace(/\D/g, '')}`
    : null;
  const mediaId = messageMediaId(message);
  let unknownSender = false;

  await handleInboundVoiceOps({
    messageId: message.id || null,
    fromPhone: fromE164,
    toPhone,
    // Scopes the employee lookup to the tenant that owns the receiving number,
    // so the same phone registered in two tenants can't cross wires.
    tenantId,
    body: messageText(message),
    channel: 'whatsapp',
    source: 'whatsapp',
    hasMedia: Boolean(mediaId),
    mediaRef: mediaId ? `wa-cloud:media:${mediaId}` : null,
    fetchMedia: mediaId ? () => fetchCloudMedia(cfg, mediaId) : undefined,
    reply: (text) => sendCloudText(cfg, fromE164, text),
    // Non-employees: total silence. The human answers from the phone app.
    // The order bot (planned) replaces this handler.
    onUnknownSender: async ({ fromPhone, isLoyalty }) => {
      unknownSender = true;
      console.log(`[WACloud] non-employee message from ${fromPhone}${isLoyalty ? ' (loyalty)' : ''} — silent, human handles`);
    },
  });

  // Blue-tick only what the voice-ops flow actually consumed. Customer chats
  // stay unread so the human sees them as new in the app.
  if (!unknownSender) await markCloudRead(cfg, message.id);
}

router.post('/webhook', (req, res) => {
  // Dormancy is now keyed on the app secret, not the access token: with
  // per-tenant numbers, blanking WA_CLOUD_ACCESS_TOKEN only silences DK's own
  // number, while tenant numbers keep their credentials in the DB. No app
  // secret means no message from any WABA can be trusted — that is the
  // platform-wide kill switch.
  if (!process.env.WA_CLOUD_APP_SECRET && process.env.WA_CLOUD_ALLOW_UNSIGNED !== 'on') {
    console.warn('[WACloud] webhook hit but WA_CLOUD_APP_SECRET not configured');
    return res.sendStatus(503);
  }

  const signature = req.get('x-hub-signature-256');
  const raw = req.rawBody;
  if (!verifyCloudSignature(raw, signature)) {
    if (process.env.WA_CLOUD_ALLOW_UNSIGNED === 'on') {
      console.warn('[WACloud] UNSIGNED webhook accepted (WA_CLOUD_ALLOW_UNSIGNED=on — disable after onboarding)');
    } else {
      console.warn('[WACloud] invalid webhook signature — rejected');
      return res.sendStatus(403);
    }
  }

  // Ack immediately; process in the background (see transport notes above).
  res.sendStatus(200);

  const changes = extractChanges(req.body);
  for (const { field, value } of changes) {
    if (field === 'messages') {
      for (const message of value.messages || []) {
        processMessage(value, message).catch((err) => {
          console.error('[WACloud] message processing failed:', err.message);
        });
      }
      // value.statuses (delivery/read receipts for our sends) — ignored.
    } else if (field === 'smb_message_echoes') {
      const echoes = value.message_echoes || value.messages || [];
      if (echoes.length > 0) {
        // Human replied from the phone app. TODO(order-bot): record per-chat
        // human-activity timestamps here so the bot yields the conversation.
        console.log(`[WACloud] ${echoes.length} app-side echo(es) — ignored`);
      }
    }
    // smb_app_state_sync / account_update / template events — ignored.
  }
});

export default router;
