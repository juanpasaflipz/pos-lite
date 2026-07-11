import { Router } from 'express';
import crypto from 'crypto';
import { processGetnetWebhook } from '../services/getnet/webhook.js';

const router = Router();

/**
 * POST /webhooks/getnet
 * Getnet payment notification webhook.
 * Mounted BEFORE tenant middleware — uses adminSql for cross-tenant lookups.
 *
 * SECURITY: Getnet is dormant scaffolding. Because Getnet's own notification
 * scheme does not give us a per-tenant signing secret to verify against, an
 * unauthenticated POST here could otherwise mark an order paid and deduct
 * inventory (payment spoofing). Until a real verification scheme is wired up,
 * this route is DISABLED unless GETNET_WEBHOOK_SECRET is set, and when set it
 * requires that shared secret in the `x-getnet-token` header, compared in
 * constant time. Set the env var only once Getnet integration goes live.
 */
router.post('/', async (req, res) => {
  const configuredSecret = process.env.GETNET_WEBHOOK_SECRET;

  // Disabled by default: no secret configured → refuse to process.
  if (!configuredSecret) {
    console.warn('Getnet webhook: GETNET_WEBHOOK_SECRET not set — webhook disabled, ignoring request');
    return res.sendStatus(404);
  }

  // Constant-time shared-secret check.
  const provided = req.headers['x-getnet-token'];
  const expectedBuf = Buffer.from(configuredSecret);
  const providedBuf = Buffer.from(typeof provided === 'string' ? provided : '');
  const ok =
    providedBuf.length === expectedBuf.length &&
    crypto.timingSafeEqual(providedBuf, expectedBuf);
  if (!ok) {
    console.warn('Getnet webhook: invalid or missing x-getnet-token — rejecting');
    return res.sendStatus(401);
  }

  // Authenticated — acknowledge fast, then process.
  res.sendStatus(200);

  try {
    const event = req.body;
    if (!event || !event.payment_id) {
      console.warn('Getnet webhook: empty or invalid payload');
      return;
    }

    await processGetnetWebhook(event);
  } catch (error) {
    console.error('Getnet webhook processing error:', error);
  }
});

export default router;
