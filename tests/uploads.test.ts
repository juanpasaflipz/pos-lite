// Menu-photo upload tests — the security-sensitive edges of the pipeline.
//
//   1. Storage layer (server/lib/storage.js): path-traversal keys are rejected
//      before any write, and the backend correctly resolves to 'disk' when R2
//      is not configured (the test env has no R2_* vars).
//   2. Feature gate: POST /api/uploads/menu-image returns 404 when
//      FEATURE_MENU_PHOTOS=false — the gate runs before auth, so a disabled
//      pipeline is fully inert.
//   3. Delete is tenant-scoped: a caller may only delete their own tenant's
//      assets. Cross-tenant → 403; a malformed asset id → 400. Both reject
//      before touching storage.
//
// Storage assertions are hermetic (no writes, no DB). The delete-scoping block
// seeds a real tenant + manager so requireAuth('manage_menu') passes, then
// exercises the guard.

import express from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import {
  createTestTenant,
  dropTestTenant,
  asTenant,
  closePools,
  type TestTenant,
} from './helpers/db.js';
// @ts-ignore — server files are plain JS
import { get } from '../server/db/index.js';
// @ts-ignore
import { putObject, deletePrefix, storageBackend } from '../server/lib/storage.js';
// @ts-ignore
import uploadsRouter from '../server/routes/uploads.js';
// @ts-ignore
import { JWT_SECRET } from '../server/lib/constants.js';

let tenant: TestTenant;
let managerToken: string;

// Mount the uploads router behind a stub that injects the resolved tenant,
// mimicking what tenantMiddleware does for real /api/* requests.
function appForTenant(tenantId: string) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.tenant = { id: tenantId };
    next();
  });
  app.use('/api/uploads', uploadsRouter);
  return app;
}

beforeAll(async () => {
  tenant = await createTestTenant('uploads');
  let managerId = 0;
  await asTenant(tenant.id, async () => {
    const m = await get(
      `INSERT INTO employees (name, pin, role) VALUES ('Mgr', '1111', 'manager') RETURNING id`,
    );
    managerId = Number(m.id);
  });
  managerToken = jwt.sign(
    { tenantId: tenant.id, employeeId: managerId, role: 'manager', type: 'employee' },
    JWT_SECRET,
    { expiresIn: '24h' },
  );
}, 60_000);

afterAll(async () => {
  await dropTestTenant(tenant.id);
  await closePools();
}, 30_000);

describe('storage layer', () => {
  it('resolves to the disk backend when R2 is not configured', () => {
    expect(storageBackend()).toBe('disk');
  });

  it('rejects path-traversal and absolute keys before writing', async () => {
    await expect(putObject('../escape/card.webp', Buffer.from('x'))).rejects.toThrow();
    await expect(putObject('/abs/card.webp', Buffer.from('x'))).rejects.toThrow();
    await expect(putObject('a/../../b.webp', Buffer.from('x'))).rejects.toThrow();
    await expect(deletePrefix('../escape')).rejects.toThrow();
  });
});

describe('POST /api/uploads/menu-image — feature gate', () => {
  const prev = process.env.FEATURE_MENU_PHOTOS;
  afterEach(() => {
    if (prev === undefined) delete process.env.FEATURE_MENU_PHOTOS;
    else process.env.FEATURE_MENU_PHOTOS = prev;
  });

  it('returns 404 when FEATURE_MENU_PHOTOS=false (gate precedes auth)', async () => {
    process.env.FEATURE_MENU_PHOTOS = 'false';
    const res = await request(appForTenant(tenant.id))
      .post('/api/uploads/menu-image')
      .attach('image', Buffer.from('not-a-real-image'), 'x.png');
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/uploads/:tenantId/menu/:uuid — tenant scoping', () => {
  const validUuid = '11111111-2222-3333-4444-555555555555';

  it('rejects deleting another tenant\'s assets (403)', async () => {
    const res = await request(appForTenant(tenant.id))
      .delete(`/api/uploads/some_other_tenant/menu/${validUuid}`)
      .set('Authorization', `Bearer ${managerToken}`);
    expect(res.status).toBe(403);
  });

  it('rejects a malformed asset id (400)', async () => {
    const res = await request(appForTenant(tenant.id))
      .delete(`/api/uploads/${tenant.id}/menu/not-a-uuid`)
      .set('Authorization', `Bearer ${managerToken}`);
    expect(res.status).toBe(400);
  });
});
