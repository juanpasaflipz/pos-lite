// Photo → inventory, from the POS (2026-07-30).
//
// Same Claude vision engine as the WhatsApp voice-ops path, reached from the
// phone in the operator's hand instead of a Meta app. The vision call itself
// is NOT exercised here — it's a paid network round-trip against a live model,
// and its prompt behavior is not what this route adds. What this route adds is
// everything AROUND it: a reviewable draft, the operator's edits, and the
// commit. That's what these tests cover.
//
//   1. OVERRIDE SAFETY — the security property. The review screen sends back
//      per-line edits, and the server must honor ONLY scalars (quantity,
//      line_total, include, create). `inventory_item_id` is read from the
//      stored draft, never the request. A client that could name an arbitrary
//      id could restock or zero out any inventory row in the tenant by id.
//
//   2. DRAFT LIFECYCLE — a draft belongs to the employee who shot the photo,
//      commits exactly once, and goes stale. Committing an hour-old shelf
//      count would overwrite whatever happened on that shelf since.
//
//   3. COMMIT WRITES THROUGH — a confirmed count actually lands in
//      inventory_counts and moves inventory_items.quantity, and the excluded
//      lines do not.

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestTenant,
  dropTestTenant,
  asTenant,
  closePools,
  type TestTenant,
} from './helpers/db.js';
// @ts-ignore — server files are plain JS
import { adminSql, get } from '../server/db/index.js';
// @ts-ignore
import inventoryScanRouter, { applyOverrides } from '../server/routes/inventory-scan.js';
// @ts-ignore
import { JWT_SECRET } from '../server/lib/constants.js';

let tenant: TestTenant;
let managerId = 0;
let otherId = 0;
let managerToken = '';
let otherToken = '';
let itemA = 0;
let itemB = 0;

function appForTenant(tenantId: string) {
  const app = express();
  app.use(express.json());
  app.use((req: any, res, next) => {
    req.tenant = { id: tenantId, plan: 'pro' };
    // Reproduces tenantMiddleware: an RLS-scoped connection on AsyncLocalStorage.
    // Without it the router's get()/run() fall back to adminSql and the tests
    // would pass while proving nothing about tenant isolation.
    void asTenant(tenantId, () => new Promise<void>((resolve) => {
      res.on('finish', resolve);
      res.on('close', resolve);
      next();
    }));
  });
  app.use('/api/inventory-scan', inventoryScanRouter);
  return app;
}

function tokenFor(employeeId: number, role: string) {
  return jwt.sign(
    { tenantId: tenant.id, employeeId, role, type: 'employee' },
    JWT_SECRET,
    { expiresIn: '24h' },
  );
}

/** Seed a pending draft the way POST /api/inventory-scan would, minus vision. */
async function seedDraft(parsed: any, employeeId = managerId, createdAt: string | null = null) {
  const rows = await adminSql`
    INSERT INTO voice_intents
      (tenant_id, employee_id, source, transcript, parsed_json, draft_action, status, created_at)
    VALUES (${tenant.id}, ${employeeId}, 'pos_scan', '[photo]',
            ${adminSql.json(parsed)}, ${parsed.intent}, 'pending_confirm',
            ${createdAt ? adminSql`${createdAt}::timestamptz` : adminSql`NOW()`})
    RETURNING id
  `;
  return Number(rows[0].id);
}

beforeAll(async () => {
  tenant = await createTestTenant('invscan');

  const mgr = await adminSql`
    INSERT INTO employees (tenant_id, name, pin, role, active)
    VALUES (${tenant.id}, 'Scanner Mgr', '1111', 'manager', true) RETURNING id
  `;
  managerId = Number(mgr[0].id);
  const other = await adminSql`
    INSERT INTO employees (tenant_id, name, pin, role, active)
    VALUES (${tenant.id}, 'Other Mgr', '2222', 'manager', true) RETURNING id
  `;
  otherId = Number(other[0].id);
  managerToken = tokenFor(managerId, 'manager');
  otherToken = tokenFor(otherId, 'manager');

  // manage_inventory must be granted to `manager` for requireAuth to pass.
  await adminSql`
    INSERT INTO role_permissions (tenant_id, role, permission, granted)
    VALUES (${tenant.id}, 'manager', 'manage_inventory', true)
    ON CONFLICT DO NOTHING
  `;

  const a = await adminSql`
    INSERT INTO inventory_items (tenant_id, name, quantity, unit, cost_price)
    VALUES (${tenant.id}, 'Bohemia', 24, 'btl', 18) RETURNING id
  `;
  itemA = Number(a[0].id);
  const b = await adminSql`
    INSERT INTO inventory_items (tenant_id, name, quantity, unit, cost_price)
    VALUES (${tenant.id}, 'Tecate', 50, 'can', 15) RETURNING id
  `;
  itemB = Number(b[0].id);
});

afterAll(async () => {
  await dropTestTenant(tenant.id);
  await closePools();
});

// ==================== 1. Override safety ====================

describe('applyOverrides', () => {
  const draft = () => ({
    intent: 'count_inventory',
    items: [
      { inventory_item_id: 101, raw_name: 'Bohemia', quantity: 12, unit: 'btl' },
      { inventory_item_id: 102, raw_name: 'Tecate', quantity: 30, unit: 'can' },
    ],
  });

  it('ignores an inventory_item_id sent by the client', () => {
    // THE security property. Honoring this would let any authenticated client
    // rewrite the stock of any inventory row in the tenant just by guessing ids.
    const out: any = applyOverrides(draft(), [
      { index: 0, inventory_item_id: 999, quantity: 5 },
    ]);
    expect(out.items[0].inventory_item_id).toBe(101);
    expect(out.items[0].quantity).toBe(5); // the scalar edit still applied
  });

  it('ignores raw_name and unit rewrites', () => {
    const out: any = applyOverrides(draft(), [
      { index: 0, raw_name: 'Something else', unit: 'kg' },
    ]);
    expect(out.items[0].raw_name).toBe('Bohemia');
    expect(out.items[0].unit).toBe('btl');
  });

  it('drops a line the operator excluded', () => {
    const out: any = applyOverrides(draft(), [{ index: 0, include: false }]);
    expect(out.items).toHaveLength(1);
    expect(out.items[0].raw_name).toBe('Tecate');
  });

  it('refuses a negative or non-numeric quantity rather than guessing', () => {
    // A NaN would survive into executeCount and be silently skipped; a negative
    // count would write a bogus variance and fire a shrinkage alert.
    const neg: any = applyOverrides(draft(), [{ index: 0, quantity: -5 }]);
    expect(neg.items[0].quantity).toBe(12);
    const nan: any = applyOverrides(draft(), [{ index: 0, quantity: 'abc' }]);
    expect(nan.items[0].quantity).toBe(12);
  });

  it('ignores an out-of-range or malformed index', () => {
    const out: any = applyOverrides(draft(), [
      { index: 99, include: false },
      { index: -1, include: false },
      { index: 'x', include: false },
      null,
    ]);
    expect(out.items).toHaveLength(2);
  });

  it('promotes an unmatched line to a new SKU only when asked', () => {
    const d: any = {
      intent: 'count_inventory',
      items: [{ inventory_item_id: null, raw_name: 'Cerveza rara', quantity: 4, _unmatched: true }],
    };
    const out: any = applyOverrides(d, [{ index: 0, create: true }]);
    expect(out.items[0]._will_create).toBe(true);
    expect(out.items[0]._unmatched).toBeUndefined();
  });

  it('will not promote a line that is already bound', () => {
    // _will_create on a bound item would insert a duplicate SKU alongside the
    // one we already matched.
    const out: any = applyOverrides(draft(), [{ index: 0, create: true }]);
    expect(out.items[0]._will_create).toBeUndefined();
  });

  it('leaves the draft untouched when there are no overrides', () => {
    const out: any = applyOverrides(draft(), []);
    expect(out.items).toHaveLength(2);
    expect(out.items[0].quantity).toBe(12);
  });
});

// ==================== 2. Draft lifecycle ====================

describe('POST /api/inventory-scan/:id/confirm', () => {
  it('rejects a draft belonging to another employee', async () => {
    const id = await seedDraft({
      intent: 'count_inventory',
      items: [{ inventory_item_id: itemA, raw_name: 'Bohemia', quantity: 10, unit: 'btl' }],
    });

    // 404, not 403 — a different employee should not learn the draft exists.
    const res = await request(appForTenant(tenant.id))
      .post(`/api/inventory-scan/${id}/confirm`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ items: [] });
    expect(res.status).toBe(404);
  });

  it('rejects a draft older than the TTL', async () => {
    const id = await seedDraft(
      { intent: 'count_inventory', items: [{ inventory_item_id: itemA, raw_name: 'Bohemia', quantity: 1, unit: 'btl' }] },
      managerId,
      new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    );

    const res = await request(appForTenant(tenant.id))
      .post(`/api/inventory-scan/${id}/confirm`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ items: [] });
    expect(res.status).toBe(410);

    const row = await get('SELECT status FROM voice_intents WHERE id = $1', [id]);
    expect(row.status).toBe('expired');
  });

  it('rejects an empty commit rather than writing nothing silently', async () => {
    const id = await seedDraft({
      intent: 'count_inventory',
      items: [{ inventory_item_id: itemA, raw_name: 'Bohemia', quantity: 10, unit: 'btl' }],
    });

    const res = await request(appForTenant(tenant.id))
      .post(`/api/inventory-scan/${id}/confirm`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ items: [{ index: 0, include: false }] });
    expect(res.status).toBe(400);
  });

  it('commits a count, moves stock, and refuses to commit twice', async () => {
    const id = await seedDraft({
      intent: 'count_inventory',
      items: [
        { inventory_item_id: itemA, raw_name: 'Bohemia', quantity: 18, unit: 'btl' },
        { inventory_item_id: itemB, raw_name: 'Tecate', quantity: 5, unit: 'can' },
      ],
    });

    // Operator recounts Bohemia as 20 and drops the Tecate line entirely.
    const res = await request(appForTenant(tenant.id))
      .post(`/api/inventory-scan/${id}/confirm`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ items: [{ index: 0, quantity: 20 }, { index: 1, include: false }] });

    expect(res.status).toBe(200);
    expect(res.body.intent).toBe('count_inventory');

    const a = await asTenant(tenant.id, () =>
      get('SELECT quantity FROM inventory_items WHERE id = $1', [itemA]));
    expect(Number(a.quantity)).toBe(20); // edited value won, not the parsed 18

    const b = await asTenant(tenant.id, () =>
      get('SELECT quantity FROM inventory_items WHERE id = $1', [itemB]));
    expect(Number(b.quantity)).toBe(50); // excluded line left stock alone

    const counted = await asTenant(tenant.id, () =>
      get('SELECT counted_quantity, system_quantity FROM inventory_counts WHERE inventory_item_id = $1', [itemA]));
    expect(Number(counted.counted_quantity)).toBe(20);
    expect(Number(counted.system_quantity)).toBe(24);

    // Double-submit (impatient tap, or a retry after a flaky response) must not
    // re-run the count against the stock it just wrote.
    const again = await request(appForTenant(tenant.id))
      .post(`/api/inventory-scan/${id}/confirm`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ items: [] });
    expect(again.status).toBe(409);
  });
});

describe('POST /api/inventory-scan/:id/cancel', () => {
  it('marks the draft cancelled', async () => {
    const id = await seedDraft({
      intent: 'count_inventory',
      items: [{ inventory_item_id: itemA, raw_name: 'Bohemia', quantity: 3, unit: 'btl' }],
    });

    const res = await request(appForTenant(tenant.id))
      .post(`/api/inventory-scan/${id}/cancel`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({});
    expect(res.status).toBe(200);

    const row = await get('SELECT status FROM voice_intents WHERE id = $1', [id]);
    expect(row.status).toBe('cancelled');
  });

  it('is idempotent — cancelling an already-cancelled draft still succeeds', async () => {
    const id = await seedDraft({
      intent: 'count_inventory',
      items: [{ inventory_item_id: itemA, raw_name: 'Bohemia', quantity: 3, unit: 'btl' }],
    });
    const app = appForTenant(tenant.id);
    await request(app).post(`/api/inventory-scan/${id}/cancel`).set('Authorization', `Bearer ${managerToken}`).send({});
    const res = await request(app).post(`/api/inventory-scan/${id}/cancel`).set('Authorization', `Bearer ${managerToken}`).send({});
    expect(res.status).toBe(200);
    expect(res.body.cancelled).toBe(true);
  });
});

describe('POST /api/inventory-scan', () => {
  it('rejects a request with no photo before spending a vision call', async () => {
    const res = await request(appForTenant(tenant.id))
      .post('/api/inventory-scan')
      .set('Authorization', `Bearer ${managerToken}`)
      .field('caption', 'conteo');
    expect(res.status).toBe(400);
  });

  it('rejects a non-image upload', async () => {
    const res = await request(appForTenant(tenant.id))
      .post('/api/inventory-scan')
      .set('Authorization', `Bearer ${managerToken}`)
      .attach('photo', Buffer.from('not an image'), { filename: 'notes.txt', contentType: 'text/plain' });
    expect(res.status).toBe(400);
  });
});
