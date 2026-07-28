// Per-tenant WhatsApp number routing.
//
// One Meta Tech Provider app means every connected number — DK's own and each
// tenant restaurant's — delivers to ONE webhook, signed with ONE app secret.
// So the tenant cannot come from the signature or the URL; it comes from
// `value.metadata.phone_number_id`, the number that RECEIVED the message.
//
// What these tests pin down:
//
//   1. ROUTING — a phone_number_id resolves to the tenant that owns it, and an
//      unrecognized one resolves to null. Guessing a tenant here would deliver
//      one restaurant's inventory photo into another's books.
//
//   2. CROSS-TENANT PHONE COLLISION — the regression this whole change exists
//      to prevent. Before per-number routing, resolveEmployeeByPhone() matched
//      an employee across ALL tenants and broke ties with `ORDER BY id DESC`,
//      i.e. "most recently created wins". An owner who works at two locations,
//      or the same phone re-registered under a second tenant, silently routed
//      to the wrong books. Scoping by the receiving number removes the tie.
//
//   3. ENV FALLBACK — a tenant with no stored credentials must still resolve
//      to the platform WA_CLOUD_* config, which is what keeps DK's own pilot
//      number working with zero rows in tenant_credentials.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestTenant,
  dropTestTenant,
  closePools,
  type TestTenant,
} from './helpers/db.js';
// @ts-ignore — server files are plain JS
import { adminSql } from '../server/db/index.js';
// @ts-ignore — server files are plain JS
import {
  resolveTenantByPhoneNumberId,
  cloudConfigFor,
  isCloudConfigured,
  envCloudConfig,
  clearCloudTenantCache,
} from '../server/helpers/waCloud.js';
// @ts-ignore — server files are plain JS
import { resolveEmployeeByPhone } from '../server/helpers/inboundVoiceOps.js';
// @ts-ignore — server files are plain JS
import { maskPhone, prettyPhone } from '../server/routes/whatsapp.js';

let tenantA: TestTenant;
let tenantB: TestTenant;

// Distinct Cloud API phone-number ids, as Meta issues them (opaque digits).
const PHONE_ID_A = '100000000000001';
const PHONE_ID_B = '100000000000002';

// The same human phone registered as an employee in BOTH tenants — an owner
// who runs two locations, which is the collision case.
const SHARED_EMPLOYEE_PHONE = '+525512345678';

beforeAll(async () => {
  tenantA = await createTestTenant('wa-a');
  tenantB = await createTestTenant('wa-b');

  for (const [tenant, phoneId] of [[tenantA, PHONE_ID_A], [tenantB, PHONE_ID_B]] as const) {
    await adminSql`
      INSERT INTO tenant_credentials (tenant_id, service, key, value)
      VALUES (${tenant.id}, 'whatsapp', 'phone_number_id', ${phoneId})
    `;
    await adminSql`
      INSERT INTO tenant_credentials (tenant_id, service, key, value)
      VALUES (${tenant.id}, 'whatsapp', 'access_token', ${'token-' + tenant.id})
    `;
    await adminSql`
      INSERT INTO employees (tenant_id, name, pin, role, phone, active)
      VALUES (${tenant.id}, ${'Owner ' + tenant.id}, '1234', 'admin', ${SHARED_EMPLOYEE_PHONE}, true)
    `;
  }
});

afterEach(() => {
  // resolveTenantByPhoneNumberId memoizes (including negative results), so a
  // test that mutates credentials would otherwise leak into the next one.
  clearCloudTenantCache();
});

afterAll(async () => {
  await dropTestTenant(tenantA.id);
  await dropTestTenant(tenantB.id);
  await closePools();
});

describe('resolveTenantByPhoneNumberId', () => {
  it('maps each number to the tenant that owns it', async () => {
    expect(await resolveTenantByPhoneNumberId(PHONE_ID_A)).toBe(tenantA.id);
    expect(await resolveTenantByPhoneNumberId(PHONE_ID_B)).toBe(tenantB.id);
  });

  it('returns null for a number we do not know', async () => {
    // Must be null, never a fallback tenant — an unknown WABA is dropped.
    expect(await resolveTenantByPhoneNumberId('999999999999999')).toBeNull();
  });

  it('returns null for empty / junk input', async () => {
    expect(await resolveTenantByPhoneNumberId('')).toBeNull();
    expect(await resolveTenantByPhoneNumberId(null)).toBeNull();
    expect(await resolveTenantByPhoneNumberId(undefined)).toBeNull();
  });

  it('serves repeat lookups from cache without re-querying', async () => {
    const first = await resolveTenantByPhoneNumberId(PHONE_ID_A);

    // Delete the row out from under the cache. A cached read still answers.
    await adminSql`
      DELETE FROM tenant_credentials
      WHERE tenant_id = ${tenantA.id} AND service = 'whatsapp' AND key = 'phone_number_id'
    `;
    expect(await resolveTenantByPhoneNumberId(PHONE_ID_A)).toBe(first);

    // ...and after an explicit invalidation (what onboarding does), it doesn't.
    clearCloudTenantCache();
    expect(await resolveTenantByPhoneNumberId(PHONE_ID_A)).toBeNull();

    await adminSql`
      INSERT INTO tenant_credentials (tenant_id, service, key, value)
      VALUES (${tenantA.id}, 'whatsapp', 'phone_number_id', ${PHONE_ID_A})
    `;
    clearCloudTenantCache();
  });
});

describe('cloudConfigFor', () => {
  it('returns the tenant own credentials', async () => {
    const cfg = await cloudConfigFor(tenantA.id);
    expect(cfg.accessToken).toBe('token-' + tenantA.id);
    expect(cfg.phoneNumberId).toBe(PHONE_ID_A);
    expect(isCloudConfigured(cfg)).toBe(true);
  });

  it('keeps tenants credentials separate', async () => {
    const a = await cloudConfigFor(tenantA.id);
    const b = await cloudConfigFor(tenantB.id);
    expect(a.accessToken).not.toBe(b.accessToken);
    expect(a.phoneNumberId).not.toBe(b.phoneNumberId);
  });

  it('falls back to the platform env config for a tenant with no rows', async () => {
    process.env.WA_CLOUD_ACCESS_TOKEN = 'platform-token';
    process.env.WA_CLOUD_PHONE_NUMBER_ID = 'platform-phone-id';
    try {
      const noRows = await createTestTenant('wa-envfallback');
      try {
        const cfg = await cloudConfigFor(noRows.id);
        expect(cfg.accessToken).toBe('platform-token');
        expect(cfg.phoneNumberId).toBe('platform-phone-id');
        expect(isCloudConfigured(cfg)).toBe(true);
      } finally {
        await dropTestTenant(noRows.id);
      }

      // A null tenant (nothing resolved) is the same platform config.
      expect(await cloudConfigFor(null)).toEqual(envCloudConfig());
    } finally {
      delete process.env.WA_CLOUD_ACCESS_TOKEN;
      delete process.env.WA_CLOUD_PHONE_NUMBER_ID;
    }
  });

  it('reports not-configured when neither tenant rows nor env exist', async () => {
    const bare = await createTestTenant('wa-bare');
    try {
      expect(isCloudConfigured(await cloudConfigFor(bare.id))).toBe(false);
    } finally {
      await dropTestTenant(bare.id);
    }
  });
});

describe('resolveEmployeeByPhone — tenant scoping', () => {
  it('routes a shared phone to the tenant that owns the receiving number', async () => {
    const viaA = await resolveEmployeeByPhone(SHARED_EMPLOYEE_PHONE, tenantA.id);
    const viaB = await resolveEmployeeByPhone(SHARED_EMPLOYEE_PHONE, tenantB.id);

    expect(viaA?.tenant_id).toBe(tenantA.id);
    expect(viaB?.tenant_id).toBe(tenantB.id);
    expect(viaA?.id).not.toBe(viaB?.id);
  });

  it('still normalizes MX phone formats when scoped', async () => {
    // Cloud API hands us `521`-prefixed senders on some WABAs; the employee
    // row stores the +52 form. phoneVariants absorbs that either way.
    const viaVariant = await resolveEmployeeByPhone('+5215512345678', tenantB.id);
    expect(viaVariant?.tenant_id).toBe(tenantB.id);
  });

  it('does not match an employee belonging to another tenant', async () => {
    const other = await createTestTenant('wa-empty');
    try {
      expect(await resolveEmployeeByPhone(SHARED_EMPLOYEE_PHONE, other.id)).toBeNull();
    } finally {
      await dropTestTenant(other.id);
    }
  });

  it('unscoped lookup still resolves (Twilio path unchanged)', async () => {
    const any = await resolveEmployeeByPhone(SHARED_EMPLOYEE_PHONE);
    expect([tenantA.id, tenantB.id]).toContain(any?.tenant_id);
  });
});

// ---------------------------------------------------------------------------
// /api/whatsapp/status display helpers.
//
// Pure, but load-bearing in two places the owner actually touches:
//   - prettyPhone's output is what the WhatsApp Ops screen turns back into a
//     wa.me link (it strips non-digits), so the formatting must never LOSE or
//     invent a digit — only regroup them.
//   - maskPhone must never render a full number: that endpoint is readable by
//     any logged-in employee, not just the owner.
// ---------------------------------------------------------------------------
describe('whatsapp status formatters', () => {
  it('groups an MX number without changing its digits', () => {
    const out = prettyPhone('5215512345678');
    expect(out).toBe('+521 55 1234 5678');
    expect(out?.replace(/\D/g, '')).toBe('5215512345678');
  });

  it('groups a bare 10-digit local number with no country code', () => {
    expect(prettyPhone('5512345678')).toBe('55 1234 5678');
  });

  it('falls back to a plain +digits form when it cannot group', () => {
    // Not 10 local digits — regrouping would misrepresent the number, so it
    // prints as-is rather than guessing at a shape.
    expect(prettyPhone('12345')).toBe('+12345');
  });

  it('returns null for an absent number so the UI can branch on it', () => {
    expect(prettyPhone('')).toBeNull();
    expect(prettyPhone(null)).toBeNull();
    expect(prettyPhone(undefined)).toBeNull();
  });

  it('accepts an already-formatted number without mangling it', () => {
    expect(prettyPhone('+52 55 1234 5678')?.replace(/\D/g, '')).toBe('525512345678');
  });

  it('masks all but the last four digits', () => {
    expect(maskPhone('+52 55 1234 5678')).toBe('•••• 5678');
    expect(maskPhone('5512345678')).toBe('•••• 5678');
  });

  it('never leaks a short or missing number', () => {
    expect(maskPhone('123')).toBe('••••');
    expect(maskPhone('')).toBe('••••');
    expect(maskPhone(null)).toBe('••••');
  });
});
