import { Router } from 'express';
import { adminSql } from '../db/index.js';
import { requireOwner } from '../middleware/ownerAuth.js';

const router = Router();

const SERVICE_SCHEMA = {
  mercadopago: {
    label: 'Mercado Pago',
    fields: [
      { key: 'client_id', label: 'Client ID', secret: false },
      { key: 'client_secret', label: 'Client Secret', secret: true },
      { key: 'integrator_id', label: 'Integrator ID', secret: false },
    ],
  },
  stripe: {
    label: 'Stripe',
    fields: [
      { key: 'secret_key', label: 'Secret Key (sk_...)', secret: true },
      { key: 'publishable_key', label: 'Publishable Key (pk_...)', secret: false },
      { key: 'webhook_secret', label: 'Webhook Secret (whsec_...)', secret: true },
    ],
  },
  conekta: {
    label: 'Conekta',
    fields: [
      { key: 'private_key', label: 'Private API Key (key_...)', secret: true },
      { key: 'public_key', label: 'Public API Key (key_...)', secret: false },
    ],
  },
  getnet: {
    label: 'Getnet (Santander)',
    fields: [
      { key: 'client_id', label: 'Client ID', secret: false },
      { key: 'client_secret', label: 'Client Secret', secret: true },
      { key: 'merchant_id', label: 'Merchant ID (Seller ID)', secret: false },
    ],
  },
  twilio: {
    label: 'Twilio (SMS)',
    fields: [
      { key: 'account_sid', label: 'Account SID', secret: false },
      { key: 'auth_token', label: 'Auth Token', secret: true },
      { key: 'phone_number', label: 'Phone Number (+...)', secret: false },
    ],
  },
  facturapi: {
    label: 'FacturAPI (CFDI)',
    fields: [
      { key: 'api_key', label: 'API Key', secret: true },
    ],
  },
  xai: {
    label: 'xAI (Grok AI)',
    fields: [
      { key: 'api_key', label: 'API Key', secret: true },
    ],
  },
  uber_eats: {
    label: 'Uber Eats',
    fields: [
      { key: 'client_id', label: 'Client ID', secret: false },
      { key: 'client_secret', label: 'Client Secret', secret: true },
      { key: 'store_id', label: 'Store ID (Restaurant UUID)', secret: false },
      { key: 'webhook_secret', label: 'Webhook Signing Secret', secret: true },
    ],
  },
  rappi: {
    label: 'Rappi',
    fields: [
      { key: 'client_id', label: 'Client ID', secret: false },
      { key: 'client_secret', label: 'Client Secret', secret: true },
      { key: 'store_id', label: 'Store ID', secret: false },
      { key: 'webhook_secret', label: 'Webhook Secret', secret: true },
    ],
  },
  didi_food: {
    label: 'DiDi Food',
    fields: [
      { key: 'app_id', label: 'App ID', secret: false },
      { key: 'app_secret', label: 'App Secret', secret: true },
      { key: 'store_id', label: 'Store ID', secret: false },
      { key: 'webhook_secret', label: 'Webhook Secret', secret: true },
    ],
  },
};

export { SERVICE_SCHEMA };

// Build a lookup of secret keys per service for quick masking checks
const SECRET_KEYS = {};
for (const [service, cfg] of Object.entries(SERVICE_SCHEMA)) {
  SECRET_KEYS[service] = new Set(
    cfg.fields.filter(f => f.secret).map(f => f.key)
  );
}

/**
 * Mask a secret value, showing only the last 4 characters.
 */
function maskValue(value) {
  if (!value || value.length <= 4) return value;
  return '\u2022\u2022\u2022\u2022' + value.slice(-4);
}

// GET /api/credentials/schema — public (needed for UI layout)
router.get('/schema', (req, res) => {
  res.json(SERVICE_SCHEMA);
});

// GET /api/credentials — owner only
router.get('/', requireOwner, async (req, res) => {
  try {
    const tenantId = req.owner.tenantId;

    const rows = await adminSql`
      SELECT service, key, value
      FROM tenant_credentials
      WHERE tenant_id = ${tenantId}
    `;

    // Build grouped result, initialising every service with empty object
    const grouped = {};
    for (const service of Object.keys(SERVICE_SCHEMA)) {
      grouped[service] = {};
    }

    for (const row of rows) {
      const service = row.service;
      if (!grouped[service]) grouped[service] = {};

      const isSecret = SECRET_KEYS[service]?.has(row.key);
      grouped[service][row.key] = isSecret ? maskValue(row.value) : row.value;
    }

    res.json(grouped);
  } catch (error) {
    console.error('Error fetching credentials:', error);
    res.status(500).json({ error: 'Failed to fetch credentials' });
  }
});

// PUT /api/credentials/:service — owner only
router.put('/:service', requireOwner, async (req, res) => {
  try {
    const { service } = req.params;
    const tenantId = req.owner.tenantId;

    // Validate service
    const schema = SERVICE_SCHEMA[service];
    if (!schema) {
      return res.status(400).json({ error: `Unknown service: ${service}` });
    }

    const validKeys = new Set(schema.fields.map(f => f.key));
    const body = req.body || {};

    // Validate all provided keys
    for (const key of Object.keys(body)) {
      if (!validKeys.has(key)) {
        return res.status(400).json({ error: `Invalid key "${key}" for service "${service}"` });
      }
    }

    // Process each key
    for (const [key, value] of Object.entries(body)) {
      const strValue = String(value).trim();

      if (strValue === '') {
        // Delete empty values
        await adminSql`
          DELETE FROM tenant_credentials
          WHERE tenant_id = ${tenantId} AND service = ${service} AND key = ${key}
        `;
      } else {
        // Upsert non-empty values
        await adminSql`
          INSERT INTO tenant_credentials (tenant_id, service, key, value)
          VALUES (${tenantId}, ${service}, ${key}, ${strValue})
          ON CONFLICT (tenant_id, service, key)
          DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
        `;
      }
    }

    res.json({ success: true, service });
  } catch (error) {
    console.error('Error saving credentials:', error);
    res.status(500).json({ error: 'Failed to save credentials' });
  }
});

// DELETE /api/credentials/:service — owner only
router.delete('/:service', requireOwner, async (req, res) => {
  try {
    const { service } = req.params;
    const tenantId = req.owner.tenantId;

    if (!SERVICE_SCHEMA[service]) {
      return res.status(400).json({ error: `Unknown service: ${service}` });
    }

    await adminSql`
      DELETE FROM tenant_credentials
      WHERE tenant_id = ${tenantId} AND service = ${service}
    `;

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting credentials:', error);
    res.status(500).json({ error: 'Failed to delete credentials' });
  }
});

export default router;
