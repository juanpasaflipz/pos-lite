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
// The voice-ops flow itself lives in helpers/inboundVoiceOps.js — shared with
// the Meta Cloud API route (routes/wa-cloud-inbound.js) that serves the
// coexistence number. This file only owns Twilio transport concerns:
// signature verification, param shapes, media auth, and channel-aware replies.
//
// Idempotency: twilio_message_sid is UNIQUE on voice_intents; retries no-op.

import { Router } from 'express';
import express from 'express';
import crypto from 'crypto';
import { fetchTwilioMedia } from '../helpers/whisper.js';
import { handleInboundVoiceOps } from '../helpers/inboundVoiceOps.js';
import { sendWhatsAppText, sendSMSReply } from '../helpers/twilio.js';

const router = Router();

router.use(express.urlencoded({ extended: false }));

const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;

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

router.post('/inbound', async (req, res) => {
  const ack = () => res.type('text/xml').send('<Response/>');

  if (!verifyTwilioSignature(req, TWILIO_TOKEN)) {
    console.warn('[TwilioInbound] Invalid signature');
    return res.status(403).send('Invalid signature');
  }

  const from = req.body.From;
  const to = req.body.To;
  const numMedia = parseInt(req.body.NumMedia || '0', 10);
  const mediaUrl0 = req.body.MediaUrl0;
  const channelIsWA = isWhatsApp(from);
  const hasMedia = channelIsWA && numMedia > 0 && Boolean(mediaUrl0);

  // Channel-aware reply: always answer on the channel the message arrived on.
  // The `from` override is the Twilio number that received the inbound —
  // required so SMS replies originate from JUANBERTOS not the platform default.
  const reply = (text) => channelIsWA
    ? sendWhatsAppText(from, text, { from: to })
    : sendSMSReply(from, text, { from: to });

  await handleInboundVoiceOps({
    messageId: req.body.MessageSid || null,
    fromPhone: stripWaPrefix(from),
    toPhone: stripWaPrefix(to),
    body: String(req.body.Body || '').trim(),
    channel: channelIsWA ? 'whatsapp' : 'sms',
    source: channelIsWA ? 'whatsapp' : 'sms',
    hasMedia,
    mediaRef: hasMedia ? mediaUrl0 : null,
    fetchMedia: hasMedia
      ? () => fetchTwilioMedia(mediaUrl0, { accountSid: TWILIO_SID, authToken: TWILIO_TOKEN })
      : undefined,
    reply,
    // No onUnknownSender override: the engine's default policy (loyalty →
    // silence, true unknowns → registration hint) is the Twilio behavior.
  });

  return ack();
});

export default router;
