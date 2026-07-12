// Twilio helper unit tests — pure normalization + sender validation.
//
// Two bug classes are guarded here after the 2026-07-11 SMS audit:
//
//   1. NORMALIZATION — `toE164SMS` used to short-circuit on a leading `+` and
//      return the input unchanged. That let a number stored as
//      `+522281246837` (Xalapa, missing the MX mobile prefix) reach Twilio
//      as-is and get dropped by the carrier with error 30008. The fix strips
//      and re-normalizes every time, so all storage variants collapse to the
//      same output.
//
//   2. SANDBOX SENDER — Twilio's public WhatsApp sandbox number
//      (`+14155238886`) cannot send SMS. A tenant that left it in
//      `tenant_credentials` after WA sandbox testing produced silent failures
//      at the API layer (error 21660). `isValidSmsSender` now blocks
//      WA-only senders before the request goes out and logs a `failed` row
//      into `loyalty_messages` so the misconfig is visible in the tenant's
//      SMS history.

import { describe, expect, it } from 'vitest';
// @ts-ignore — server files are plain JS
import {
  toE164,
  toE164SMS,
  isValidSmsSender,
  TWILIO_WA_SANDBOX_NUMBER,
} from '../server/helpers/twilio.js';

describe('toE164SMS (MX)', () => {
  it('bare 10-digit MX number → +521 + 10 digits', () => {
    expect(toE164SMS('5531042857', 'MX')).toBe('+5215531042857');
  });

  it('12-digit +52 + 10 (missing mobile 1) → injects the 1', () => {
    // The regression: pre-fix, this returned "+522281246837" unchanged and
    // the message was dropped by the MX carrier (error 30008).
    expect(toE164SMS('+522281246837', 'MX')).toBe('+5212281246837');
  });

  it('13-digit +521 + 10 (already correct) → unchanged', () => {
    expect(toE164SMS('+5215621921870', 'MX')).toBe('+5215621921870');
  });

  it('bare 52 + 10 digits (no +) → injects the 1', () => {
    expect(toE164SMS('525531042857', 'MX')).toBe('+5215531042857');
  });

  it('bare 521 + 10 digits (no +) → adds +', () => {
    expect(toE164SMS('5215531042857', 'MX')).toBe('+5215531042857');
  });

  it('strips whitespace and formatting characters', () => {
    expect(toE164SMS('+52 (55) 3104-2857', 'MX')).toBe('+5215531042857');
  });

  it('empty / null / undefined → empty string', () => {
    expect(toE164SMS('', 'MX')).toBe('');
    expect(toE164SMS(null, 'MX')).toBe('');
    expect(toE164SMS(undefined, 'MX')).toBe('');
  });
});

describe('toE164SMS (US / CA)', () => {
  it('bare 10-digit US number → +1 + 10 digits', () => {
    expect(toE164SMS('8479701041', 'US')).toBe('+18479701041');
  });

  it('11-digit US number starting with 1 → +11 digits', () => {
    expect(toE164SMS('18479701041', 'US')).toBe('+18479701041');
  });

  it('+1 short-circuit no longer trusted — still round-trips correctly', () => {
    expect(toE164SMS('+18479701041', 'US')).toBe('+18479701041');
  });

  it('CA behaves the same as US', () => {
    expect(toE164SMS('4165551234', 'CA')).toBe('+14165551234');
  });
});

describe('toE164 (WhatsApp, MX)', () => {
  // WhatsApp uses "+52 + 10" — the mobile "1" prefix is SMS-only.
  it('bare 10-digit MX number → +52 + 10 digits (no mobile 1)', () => {
    expect(toE164('5531042857', 'MX')).toBe('+525531042857');
  });

  it('12-digit +52 + 10 → unchanged', () => {
    expect(toE164('+525531042857', 'MX')).toBe('+525531042857');
  });

  it('13-digit +521 + 10 → strips the mobile 1', () => {
    // WA-side: mobile "1" is a Twilio SMS quirk, drop it.
    expect(toE164('+5215531042857', 'MX')).toBe('+525531042857');
  });

  it('strips whitespace and formatting characters', () => {
    expect(toE164('+52 55 3104 2857', 'MX')).toBe('+525531042857');
  });

  it('empty / null / undefined → empty string', () => {
    expect(toE164('', 'MX')).toBe('');
    expect(toE164(null, 'MX')).toBe('');
  });
});

describe('isValidSmsSender', () => {
  it('accepts a bare E.164 SMS number', () => {
    expect(isValidSmsSender('+525629152086')).toBe(true);
  });

  it('rejects the Twilio WhatsApp sandbox number', () => {
    expect(isValidSmsSender(TWILIO_WA_SANDBOX_NUMBER)).toBe(false);
    expect(isValidSmsSender('+14155238886')).toBe(false);
  });

  it('rejects any sender with the whatsapp: prefix', () => {
    // A number configured for WhatsApp shouldn't silently downgrade to SMS —
    // the two channels register independently at Twilio and reusing a WA
    // registration for SMS returns error 21660.
    expect(isValidSmsSender('whatsapp:+525629152086')).toBe(false);
    expect(isValidSmsSender('whatsapp:+14155238886')).toBe(false);
  });

  it('rejects empty / null / undefined', () => {
    expect(isValidSmsSender('')).toBe(false);
    expect(isValidSmsSender(null)).toBe(false);
    expect(isValidSmsSender(undefined)).toBe(false);
  });
});
