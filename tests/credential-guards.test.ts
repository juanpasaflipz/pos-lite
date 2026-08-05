// Credential save guards. A URL pasted into a secret field stores fine and
// fails silently later, upstream, where nobody is looking — the Uber Direct
// signing key held the webhook URL and 403'd every inbound webhook for a day.

import { describe, expect, it } from 'vitest';
// @ts-ignore — server files are plain JS
import { findUrlInSecretField, SERVICE_SCHEMA } from '../server/routes/credentials.js';

describe('findUrlInSecretField', () => {
  it('rejects the exact mistake: webhook URL in the signing key field', () => {
    expect(
      findUrlInSecretField('uber_direct', {
        webhook_signing_key: 'https://juanbertos.desktop.kitchen/api/uber-direct/webhook',
      })
    ).toBe('webhook_signing_key');
  });

  it('rejects http as well as https, and ignores surrounding whitespace', () => {
    expect(findUrlInSecretField('uber_direct', { client_secret: '  http://example.com/x  ' }))
      .toBe('client_secret');
  });

  it('allows a real secret that merely contains url-ish characters', () => {
    expect(
      findUrlInSecretField('uber_direct', {
        client_secret: 'lWwS-someOpaqueSecret_with.dots/and-slashes',
        webhook_signing_key: 'aB3xY7zQ',
      })
    ).toBeNull();
  });

  it('leaves non-secret fields alone — pickup_address is a real address', () => {
    expect(
      findUrlInSecretField('uber_direct', {
        pickup_address: 'https://maps.example/pin/123',
      })
    ).toBeNull();
  });

  it('returns null for an unknown service rather than throwing', () => {
    expect(findUrlInSecretField('not_a_service', { anything: 'https://x' })).toBeNull();
  });

  it('covers every service that declares a secret field', () => {
    // Guards the guard: a new integration with a secret should be protected
    // automatically, so this fails if SECRET_KEYS ever stops being derived
    // from the schema.
    for (const [service, cfg] of Object.entries(SERVICE_SCHEMA) as [string, any][]) {
      const secret = cfg.fields.find((f: any) => f.secret);
      if (!secret) continue;
      expect(findUrlInSecretField(service, { [secret.key]: 'https://evil.example' })).toBe(secret.key);
    }
  });
});
