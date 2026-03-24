import { Router } from 'express';
import { processGetnetWebhook } from '../services/getnet/webhook.js';

const router = Router();

/**
 * POST /webhooks/getnet
 * Getnet payment notification webhook.
 * Mounted BEFORE tenant middleware — uses adminSql for cross-tenant lookups.
 */
router.post('/', async (req, res) => {
  // Always respond 200 immediately (Getnet requires fast acknowledgement)
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
