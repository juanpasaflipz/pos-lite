// Pay-first checkout provisioning (server/lib/provisionPaidTenant.js).
//
// Exercises the helper both the Stripe webhook and the success-page claim
// endpoint call: fresh-tenant creation, idempotency (webhook + claim racing),
// and the existing-tenant "attach subscription" upgrade path.

import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestTenant, dropTestTenant, closePools } from './helpers/db.js';
// @ts-ignore — server files are plain JS
import { provisionPaidTenant } from '../server/lib/provisionPaidTenant.js';
// @ts-ignore
import { adminSql } from '../server/db/index.js';

const createdTenants: string[] = [];

function testSlug(label: string): string {
  // dropTestTenant only accepts test_-prefixed ids; provisionPaidTenant
  // accepts an explicit slug for exactly this reason.
  return `test_payfirst_${label}_${randomUUID().slice(0, 8)}`;
}

afterAll(async () => {
  for (const id of createdTenants) {
    await dropTestTenant(id);
  }
  await closePools();
});

describe('provisionPaidTenant', () => {
  it('provisions a fresh tenant from a paid checkout', async () => {
    const slug = testSlug('fresh');
    const email = `${slug}@test.local`;

    const result = await provisionPaidTenant({
      email,
      restaurantName: 'Tacos Payfirst',
      stripeCustomerId: 'cus_test_payfirst',
      stripeSubscriptionId: 'sub_test_payfirst',
      slug,
      sendEmail: false,
    });
    createdTenants.push(result.tenant.id);

    expect(result.created).toBe(true);
    expect(result.tenant.id).toBe(slug);
    expect(result.tenant.plan).toBe('pro');
    expect(result.tenant.subscription_status).toBe('active');
    expect(result.tenant.stripe_customer_id).toBe('cus_test_payfirst');
    expect(result.tenant.stripe_subscription_id).toBe('sub_test_payfirst');
    expect(result.pin).toMatch(/^\d{4}$/);
    expect(result.loginToken).toBeTruthy();
    // Password-create link (reset_token flow) is armed
    expect(result.tenant.reset_token).toBeTruthy();

    // Admin employee exists
    const employees = await adminSql`
      SELECT role FROM employees WHERE tenant_id = ${slug} AND active = true
    `;
    expect(employees.length).toBe(1);
    expect(employees[0].role).toBe('admin');

    // Example menu seeded
    const items = await adminSql`SELECT id FROM menu_items WHERE tenant_id = ${slug}`;
    expect(items.length).toBeGreaterThanOrEqual(2);

    // Magic-login token exists and is unexpired
    const tokens = await adminSql`
      SELECT expires_at FROM demo_tokens WHERE tenant_id = ${slug}
    `;
    expect(tokens.length).toBe(1);
    expect(new Date(tokens[0].expires_at).getTime()).toBeGreaterThan(Date.now());
  }, 30_000);

  it('is idempotent — a second call (webhook vs claim race) returns the same tenant', async () => {
    const slug = testSlug('idem');
    const email = `${slug}@test.local`;

    const first = await provisionPaidTenant({
      email,
      restaurantName: 'Idempotencia SA',
      stripeCustomerId: 'cus_test_idem',
      stripeSubscriptionId: 'sub_test_idem',
      slug,
      sendEmail: false,
    });
    createdTenants.push(first.tenant.id);

    const second = await provisionPaidTenant({
      email,
      restaurantName: 'Idempotencia SA',
      stripeCustomerId: 'cus_test_idem',
      stripeSubscriptionId: 'sub_test_idem',
      slug,
      sendEmail: false,
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.tenant.id).toBe(first.tenant.id);

    // No duplicate admin employee, no duplicate seed menu
    const employees = await adminSql`SELECT id FROM employees WHERE tenant_id = ${slug}`;
    expect(employees.length).toBe(1);
    const cats = await adminSql`SELECT id FROM menu_categories WHERE tenant_id = ${slug}`;
    expect(cats.length).toBe(1);
  }, 30_000);

  it('serializes truly concurrent provision attempts for the same email', async () => {
    const slug = testSlug('race');
    const email = `${slug}@test.local`;

    const [a, b] = await Promise.all([
      provisionPaidTenant({ email, restaurantName: 'Race A', slug, sendEmail: false }),
      provisionPaidTenant({ email, restaurantName: 'Race B', slug: `${slug}b`, sendEmail: false }),
    ]);
    createdTenants.push(a.tenant.id);
    if (b.tenant.id !== a.tenant.id) createdTenants.push(b.tenant.id);

    // Exactly one creation; the loser attached to the winner's tenant
    expect([a.created, b.created].filter(Boolean).length).toBe(1);
    expect(a.tenant.id).toBe(b.tenant.id);

    const employees = await adminSql`SELECT id FROM employees WHERE tenant_id = ${a.tenant.id}`;
    expect(employees.length).toBe(1);
  }, 30_000);

  it('attaches the subscription to an existing tenant instead of duplicating', async () => {
    const existing = await createTestTenant('payfirst-upgrade');
    createdTenants.push(existing.id);

    const result = await provisionPaidTenant({
      email: existing.ownerEmail,
      restaurantName: 'Should Not Matter',
      stripeCustomerId: 'cus_test_upgrade',
      stripeSubscriptionId: 'sub_test_upgrade',
      sendEmail: false,
    });

    expect(result.created).toBe(false);
    expect(result.tenant.id).toBe(existing.id);

    const [row] = await adminSql`
      SELECT plan, subscription_status, stripe_customer_id, stripe_subscription_id
      FROM tenants WHERE id = ${existing.id}
    `;
    expect(row.plan).toBe('pro');
    expect(row.subscription_status).toBe('active');
    expect(row.stripe_customer_id).toBe('cus_test_upgrade');
    expect(row.stripe_subscription_id).toBe('sub_test_upgrade');
  }, 30_000);
});
