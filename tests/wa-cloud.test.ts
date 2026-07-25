// Meta Cloud API helper unit tests — webhook signature, payload parsing,
// and phone normalization for the coexistence number.
//
// Transport context: the business WhatsApp (+52 56 1309 6835) runs BOTH the
// WhatsApp Business app (humans answering to-go orders) and the Cloud API
// (employee voice-ops) via Meta coexistence. These tests pin down the pure
// glue so the webhook route stays honest:
//
//   1. SIGNATURE — X-Hub-Signature-256 is HMAC-SHA256 over the RAW body.
//      A parsed-and-restringified body would silently break verification,
//      so the helper takes bytes and the route feeds it req.rawBody.
//
//   2. FROM NORMALIZATION — Cloud API sends MX senders as `521` + 10 digits
//      on some WABAs and `52` + 10 on others. Both must collapse to the
//      `+52` + 10 form that employees.phone stores.

import crypto from 'crypto';
import { describe, expect, it } from 'vitest';
// @ts-ignore — server files are plain JS
import {
  verifyCloudSignature,
  extractChanges,
  normalizeCloudFrom,
  messageText,
  messageMediaId,
} from '../server/helpers/waCloud.js';
// @ts-ignore — server files are plain JS
import { phoneVariants } from '../server/helpers/inboundVoiceOps.js';

const SECRET = 'test-app-secret';

function sign(rawBody: Buffer | string, secret = SECRET) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

describe('verifyCloudSignature', () => {
  const raw = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [] }));

  it('accepts a valid signature', () => {
    expect(verifyCloudSignature(raw, sign(raw), SECRET)).toBe(true);
  });

  it('rejects a signature made with a different secret', () => {
    expect(verifyCloudSignature(raw, sign(raw, 'wrong-secret'), SECRET)).toBe(false);
  });

  it('rejects when the body was tampered with', () => {
    const tampered = Buffer.from(raw.toString().replace('entry', 'entry2'));
    expect(verifyCloudSignature(tampered, sign(raw), SECRET)).toBe(false);
  });

  it('rejects missing header / missing secret / malformed header', () => {
    expect(verifyCloudSignature(raw, undefined, SECRET)).toBe(false);
    expect(verifyCloudSignature(raw, sign(raw), undefined)).toBe(false);
    expect(verifyCloudSignature(raw, 'sha1=abcdef', SECRET)).toBe(false);
    expect(verifyCloudSignature(raw, 'not-a-signature', SECRET)).toBe(false);
  });
});

// A realistic coexistence webhook: one text message, one statuses-only
// delivery receipt, and one app-side echo (human replied from the phone).
const COEX_PAYLOAD = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: '1234567890',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '525613096835', phone_number_id: '111222333' },
            contacts: [{ profile: { name: 'Empleado' }, wa_id: '5215551234567' }],
            messages: [
              { from: '5215551234567', id: 'wamid.TEXT1', timestamp: '1784900000', type: 'text', text: { body: 'tiré 3 burritos' } },
            ],
          },
        },
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '525613096835', phone_number_id: '111222333' },
            statuses: [{ id: 'wamid.OUT1', status: 'delivered', recipient_id: '5215551234567' }],
          },
        },
        {
          field: 'smb_message_echoes',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '525613096835', phone_number_id: '111222333' },
            message_echoes: [
              { from: '525613096835', to: '5215559876543', id: 'wamid.ECHO1', type: 'text', text: { body: 'Sale en 15 min!' } },
            ],
          },
        },
      ],
    },
  ],
};

describe('extractChanges', () => {
  it('flattens entries into { field, value } pairs in order', () => {
    const changes = extractChanges(COEX_PAYLOAD);
    expect(changes.map((c: any) => c.field)).toEqual(['messages', 'messages', 'smb_message_echoes']);
    expect(changes[0].value.messages[0].id).toBe('wamid.TEXT1');
    expect(changes[1].value.statuses[0].status).toBe('delivered');
    expect(changes[2].value.message_echoes[0].id).toBe('wamid.ECHO1');
  });

  it('returns [] for non-WABA objects and malformed payloads', () => {
    expect(extractChanges({ object: 'page', entry: [{ changes: [{ field: 'messages' }] }] })).toEqual([]);
    expect(extractChanges(null)).toEqual([]);
    expect(extractChanges({})).toEqual([]);
    expect(extractChanges({ object: 'whatsapp_business_account' })).toEqual([]);
  });
});

describe('normalizeCloudFrom (MX)', () => {
  it('521 + 10 digits (legacy mobile prefix) → +52 + 10', () => {
    expect(normalizeCloudFrom('5215613096835')).toBe('+525613096835');
  });

  it('52 + 10 digits → +52 + 10 unchanged', () => {
    expect(normalizeCloudFrom('525613096835')).toBe('+525613096835');
  });

  it('non-MX numbers pass through with a + prefix', () => {
    expect(normalizeCloudFrom('14155550100')).toBe('+14155550100');
  });

  it('empty / junk input → empty string', () => {
    expect(normalizeCloudFrom('')).toBe('');
    expect(normalizeCloudFrom(undefined)).toBe('');
  });
});

describe('messageText / messageMediaId', () => {
  it('extracts text bodies', () => {
    expect(messageText({ type: 'text', text: { body: 'hola' } })).toBe('hola');
  });

  it('surfaces interactive replies as text (future order bot taps)', () => {
    expect(messageText({ type: 'interactive', interactive: { button_reply: { id: 'b1', title: 'SI' } } })).toBe('SI');
    expect(messageText({ type: 'interactive', interactive: { list_reply: { id: 'l1', title: 'Tacos al pastor' } } })).toBe('Tacos al pastor');
    expect(messageText({ type: 'button', button: { payload: 'p', text: 'NO' } })).toBe('NO');
  });

  it('audio has no text; image caption comes through', () => {
    expect(messageText({ type: 'audio', audio: { id: 'MEDIA1' } })).toBe('');
    expect(messageText({ type: 'image', image: { id: 'MEDIA2', caption: 'recibo de Sigma' } })).toBe('recibo de Sigma');
  });

  it('finds media ids on audio/image, null on text', () => {
    expect(messageMediaId({ type: 'audio', audio: { id: 'MEDIA1' } })).toBe('MEDIA1');
    expect(messageMediaId({ type: 'image', image: { id: 'MEDIA2' } })).toBe('MEDIA2');
    expect(messageMediaId({ type: 'text', text: { body: 'hola' } })).toBeNull();
  });
});

describe('phoneVariants (shared engine)', () => {
  it('generates the storage forms an MX WhatsApp sender can match against', () => {
    const variants = phoneVariants('+525613096835');
    expect(variants.has('+525613096835')).toBe(true);   // employees.phone (WA form)
    expect(variants.has('+5215613096835')).toBe(true);  // employees.phone (SMS form)
    expect(variants.has('5613096835')).toBe(true);      // loyalty_customers bare-10
  });
});
