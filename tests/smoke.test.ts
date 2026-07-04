import { afterAll, describe, expect, it } from 'vitest';
import { createTestTenant, dropTestTenant, asTenant, closePools } from './helpers/db.js';
// @ts-ignore
import { get } from '../server/db/index.js';

afterAll(async () => {
  await closePools();
});

describe('scaffolding smoke', () => {
  it('creates a tenant, RLS sets app.tenant_id correctly, cleanup succeeds', async () => {
    const tenant = await createTestTenant('smoke');
    try {
      const seen = await asTenant(tenant.id, async () =>
        get('SELECT current_setting(\'app.tenant_id\', true) AS tid'),
      );
      expect(seen?.tid).toBe(tenant.id);
    } finally {
      await dropTestTenant(tenant.id);
    }
  }, 30_000);
});
