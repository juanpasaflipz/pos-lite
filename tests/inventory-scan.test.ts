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
import multer from 'multer';
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
import { adminSql, get, getTenantId, tenantContext } from '../server/db/index.js';
// @ts-ignore
import inventoryScanRouter, { applyOverrides } from '../server/routes/inventory-scan.js';
// @ts-ignore
import { resolvePurchaseTotal } from '../server/helpers/voiceIntent.js';
// @ts-ignore
import { JWT_SECRET } from '../server/lib/constants.js';

let tenant: TestTenant;
let managerId = 0;
let otherId = 0;
let cookId = 0;
let managerToken = '';
let otherToken = '';
let cookToken = '';
let itemA = 0;
let itemB = 0;

function appForTenant(tenantId: string, plan = 'pro') {
  const app = express();
  app.use(express.json());
  app.use((req: any, res, next) => {
    req.tenant = { id: tenantId, plan };
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

/** Same memory-storage shape the route uses, for the ALS probe below. */
const multerProbe = multer({ storage: multer.memoryStorage() });

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

  const cook = await adminSql`
    INSERT INTO employees (tenant_id, name, pin, role, active)
    VALUES (${tenant.id}, 'Line Cook', '3333', 'kitchen', true) RETURNING id
  `;
  cookId = Number(cook[0].id);
  cookToken = tokenFor(cookId, 'kitchen');

  // Explicit DELETE-then-INSERT rather than ON CONFLICT: whether createTenant
  // seeds these rows (and with what `granted`) is not this test's business, and
  // the permission split is exactly what's under test — it has to be exact.
  const grant = async (role: string, permission: string, granted: boolean) => {
    await adminSql`
      DELETE FROM role_permissions
      WHERE tenant_id = ${tenant.id} AND role = ${role} AND permission = ${permission}
    `;
    await adminSql`
      INSERT INTO role_permissions (tenant_id, role, permission, granted)
      VALUES (${tenant.id}, ${role}, ${permission}, ${granted})
    `;
  };
  await grant('manager', 'manage_inventory', true);
  await grant('manager', 'scan_inventory', true);
  // The cook is the whole point of the split: may count, may not book money.
  // These mirror the shipped defaults (server/tenants.js + migration 0101) —
  // 1.6.0 gated on pos_access, which prod grants to NEITHER kitchen nor bar,
  // so the split passed here while being inert against real tenants.
  await grant('kitchen', 'scan_inventory', true);
  await grant('kitchen', 'manage_inventory', false);
  await grant('kitchen', 'pos_access', false);

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

  // The operator-typed total. This is the escape hatch for the receipt whose
  // printed total the camera lost — before it existed the review screen had no
  // field for the one value that decided whether the scan could be saved.
  it('accepts an operator-supplied total, even with no line overrides', () => {
    const d: any = { intent: 'record_purchase', total_amount: null, items: [] };
    // Note the empty overrides array: the total must be applied before the
    // early return that short-circuits on no line edits.
    expect(applyOverrides(d, [], { totalAmount: 1234.5 }).total_amount).toBe(1234.5);
  });

  it('refuses a zero, negative, or non-numeric total', () => {
    // Booking a $0 expense from a stray keystroke is worse than the failure it
    // replaces — the draft's own value stays in charge instead.
    for (const bad of [0, -10, 'abc', '']) {
      const d: any = { intent: 'record_purchase', total_amount: 500, items: [] };
      expect(applyOverrides(d, [], { totalAmount: bad as any }).total_amount).toBe(500);
    }
  });

  // Re-pointing a line at a different SKU. The motivating case: a handwritten
  // "mango" that the model reads as "maíz", which enrichItemBindings then
  // fuzzy-matches onto the real Maíz row. Correcting the displayed text alone
  // would leave that binding intact and restock maíz with mango's kilos.
  const purchase = () => ({
    intent: 'record_purchase',
    items: [
      {
        inventory_item_id: 700, raw_name: 'Maiz', quantity: 4, unit: 'kg',
        pack_size: 1, line_total: 400, received_qty_base_unit: 4,
        derived_unit_cost: 100, _fuzzy_matched: true,
      },
    ],
  });
  const bindings = new Map([[701, { id: 701, name: 'Mango' }]]);

  it('re-points a line at a server-resolved SKU and adopts its real name', () => {
    const out: any = applyOverrides(purchase(), [{ index: 0, bind_inventory_item_id: 701 }], { bindings });
    expect(out.items[0].inventory_item_id).toBe(701);
    // The SKU's canonical name, not the misread — receipt_data's
    // raw_description has to describe what was actually restocked.
    expect(out.items[0].raw_name).toBe('Mango');
    expect(out.items[0]._rebound).toBe(true);
    expect(out.items[0]._fuzzy_matched).toBeUndefined();
  });

  it('refuses to re-point at an id the server did not resolve', () => {
    // The security property, restated for the new door: only ids the route
    // confirmed exist in THIS tenant reach applyOverrides. Anything else must
    // leave the original binding untouched.
    const out: any = applyOverrides(purchase(), [{ index: 0, bind_inventory_item_id: 999 }], { bindings });
    expect(out.items[0].inventory_item_id).toBe(700);
    expect(out.items[0]._rebound).toBeUndefined();
  });

  it('ignores a bind id when no bindings map was supplied at all', () => {
    const out: any = applyOverrides(purchase(), [{ index: 0, bind_inventory_item_id: 701 }]);
    expect(out.items[0].inventory_item_id).toBe(700);
  });

  it('renames and unbinds only when creating a new SKU', () => {
    const out: any = applyOverrides(purchase(), [{ index: 0, create: true, name: '  Mango Ataulfo ' }]);
    expect(out.items[0].raw_name).toBe('Mango Ataulfo');
    expect(out.items[0].inventory_item_id).toBeNull();
    expect(out.items[0]._will_create).toBe(true);
  });

  it('will not rename a line without create — that would relabel a bound row', () => {
    // A rename alone would leave inventory_item_id pointing at Maíz while the
    // line reads "Mango": the restock still lands on the wrong SKU, and now
    // nothing on screen says so.
    const out: any = applyOverrides(purchase(), [{ index: 0, name: 'Mango' }]);
    expect(out.items[0].raw_name).toBe('Maiz');
    expect(out.items[0].inventory_item_id).toBe(700);
  });

  // executePurchase restocks `received_qty_base_unit ?? quantity` and prices
  // from derived_unit_cost, both computed when the draft was built. Leaving them
  // stale silently discarded every operator quantity edit on a purchase.
  it('recomputes the restock quantity and unit cost after an edit', () => {
    const out: any = applyOverrides(purchase(), [{ index: 0, quantity: 2, line_total: 300 }]);
    expect(out.items[0].received_qty_base_unit).toBe(2);
    expect(out.items[0].derived_unit_cost).toBe(150);
  });

  it('recomputes through pack_size rather than restocking packs as units', () => {
    const d: any = {
      intent: 'record_purchase',
      items: [{
        inventory_item_id: 700, raw_name: 'Sacos', quantity: 1, unit: 'kg',
        pack_size: 5, line_total: 500, received_qty_base_unit: 5, derived_unit_cost: 100,
      }],
    };
    const out: any = applyOverrides(d, [{ index: 0, quantity: 2 }]);
    expect(out.items[0].received_qty_base_unit).toBe(10); // 2 sacks × 5 kg
    expect(out.items[0].derived_unit_cost).toBe(50);      // 500 ÷ 10
  });

  it('leaves count drafts free of purchase-only economics', () => {
    const out: any = applyOverrides(draft(), [{ index: 0, quantity: 5 }]);
    expect(out.items[0].received_qty_base_unit).toBeUndefined();
    expect(out.items[0].derived_unit_cost).toBeUndefined();
  });

  it('leaves the stated total alone when the operator sends none', () => {
    const d: any = { intent: 'record_purchase', total_amount: 500, items: [] };
    expect(applyOverrides(d, [], { totalAmount: undefined }).total_amount).toBe(500);
    expect(applyOverrides(d, [], { totalAmount: null as any }).total_amount).toBe(500);
  });
});

// ==================== 1b. Missing receipt total ====================

// Every prod failure of this feature on 2026-07-31 was this: the vision call
// read all four line items off a Central de Abasto ticket correctly but could
// not see the total through a shadow, and executePurchase threw on
// `total_amount: null`. The draft sat at 'pending_confirm' forever because the
// tenant middleware rolled back the 'failed' marker along with the 500.
describe('resolvePurchaseTotal', () => {
  it('prefers the stated total even when it disagrees with the lines', () => {
    // The gap is real and expected — IVA, discounts, and lines the model never
    // extracted all live in it. The receipt total is what left the till.
    const parsed: any = {
      total_amount: 2400,
      items: [{ line_total: 1113 }, { line_total: 234.26 }],
    };
    expect(resolvePurchaseTotal(parsed)).toEqual({ amount: 2400, derived: false });
  });

  it('derives the total from the line items when the ticket was unreadable', () => {
    const parsed: any = {
      total_amount: null,
      items: [
        { line_total: 1235.1 },
        { line_total: 1715 },
        { line_total: 801.8 },
        { line_total: 208 },
      ],
    };
    expect(resolvePurchaseTotal(parsed)).toEqual({ amount: 3959.9, derived: true });
  });

  it('rounds a derived total to cents rather than carrying float noise', () => {
    const parsed: any = { total_amount: null, items: [{ line_total: 0.1 }, { line_total: 0.2 }] };
    expect(resolvePurchaseTotal(parsed).amount).toBe(0.3);
  });

  it('skips unusable line totals instead of poisoning the sum with NaN', () => {
    const parsed: any = {
      total_amount: null,
      items: [{ line_total: 100 }, { line_total: null }, { line_total: 'x' }, { line_total: -5 }],
    };
    expect(resolvePurchaseTotal(parsed)).toEqual({ amount: 100, derived: true });
  });

  it('reports no total when there is nothing to derive one from', () => {
    // Still a hard failure — but now only when the photo really gave us nothing,
    // not merely because the printed total was obscured.
    expect(resolvePurchaseTotal({ total_amount: null, items: [] } as any).amount).toBeNull();
    expect(resolvePurchaseTotal({} as any).amount).toBeNull();
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

// ==================== 5. Cost & access controls ====================

describe('plan gate', () => {
  it('refuses a free-plan tenant before spending a vision call', async () => {
    // Every scan is a paid Claude call. /api/ai/* already refuses free-plan
    // tenants; this route must not be the one place vision spend leaks through.
    const res = await request(appForTenant(tenant.id, 'free'))
      .post('/api/inventory-scan')
      .set('Authorization', `Bearer ${managerToken}`)
      .attach('photo', Buffer.from('fake'), { filename: 'x.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('PLAN_UPGRADE_REQUIRED');
    expect(res.body.requiredPlan).toBe('pro');
  });
});

describe('shipped permission defaults', () => {
  // The test that would have caught the 1.6.0 mistake. Every other test in this
  // file grants permissions explicitly, so they proved the split worked against
  // a matrix this file invented — while in prod `kitchen` had exactly
  // `kitchen_access` and the feature was unreachable for the people it targets.
  // This asserts the matrix a REAL tenant is provisioned with.
  it('grants scan_inventory to the roles that stand near stock', async () => {
    const fresh = await createTestTenant('invperm');
    try {
      const rows = await adminSql`
        SELECT role, granted FROM role_permissions
        WHERE tenant_id = ${fresh.id} AND permission = 'scan_inventory'
      `;
      const byRole = Object.fromEntries(rows.map((r: any) => [r.role, r.granted]));

      expect(byRole.kitchen).toBe(true);
      expect(byRole.bar).toBe(true);
      expect(byRole.cashier).toBe(true);
      expect(byRole.manager).toBe(true);
      expect(byRole.admin).toBe(true);

      // And it must NOT have been achieved by handing them the register —
      // that was the tempting wrong fix.
      const pos = await adminSql`
        SELECT role, granted FROM role_permissions
        WHERE tenant_id = ${fresh.id} AND permission = 'pos_access'
          AND role IN ('kitchen', 'bar')
      `;
      for (const r of pos) expect(r.granted).toBe(false);
    } finally {
      await dropTestTenant(fresh.id);
    }
  }, 60_000);
});

describe('permission split', () => {
  it('lets a line cook commit a shelf count', async () => {
    // The reason the split exists: the person at the shelf is usually the one
    // without manage_inventory.
    const id = await seedDraft({
      intent: 'count_inventory',
      items: [{ inventory_item_id: itemB, raw_name: 'Tecate', quantity: 42, unit: 'can' }],
    }, cookId);

    const res = await request(appForTenant(tenant.id))
      .post(`/api/inventory-scan/${id}/confirm`)
      .set('Authorization', `Bearer ${cookToken}`)
      .send({ items: [] });

    expect(res.status).toBe(200);
    const row = await asTenant(tenant.id, () =>
      get('SELECT quantity FROM inventory_items WHERE id = $1', [itemB]));
    expect(Number(row.quantity)).toBe(42);
  });

  it('refuses a line cook committing a purchase', async () => {
    // executePurchase books an expense — that is a money write and stays behind
    // manage_inventory even though the same photo flow produced the draft.
    const id = await seedDraft({
      intent: 'record_purchase',
      vendor: 'Proveedor',
      total_amount: 500,
      items: [{ inventory_item_id: itemA, raw_name: 'Bohemia', quantity: 24, unit: 'btl', line_total: 500 }],
    }, cookId);

    const res = await request(appForTenant(tenant.id))
      .post(`/api/inventory-scan/${id}/confirm`)
      .set('Authorization', `Bearer ${cookToken}`)
      .send({ items: [] });

    expect(res.status).toBe(403);
    expect(res.body.permission).toBe('manage_inventory');
    expect(res.body.intent).toBe('record_purchase');

    // Still pending, not silently consumed — a manager can finish it.
    const row = await get('SELECT status FROM voice_intents WHERE id = $1', [id]);
    expect(row.status).toBe('pending_confirm');
  });

  it('reads the intent from the stored draft, not the request body', async () => {
    // Otherwise relabelling a purchase as a count in the request would route it
    // through the cheaper permission.
    const id = await seedDraft({
      intent: 'record_purchase',
      vendor: 'Proveedor',
      total_amount: 300,
      items: [{ inventory_item_id: itemA, raw_name: 'Bohemia', quantity: 12, unit: 'btl', line_total: 300 }],
    }, cookId);

    const res = await request(appForTenant(tenant.id))
      .post(`/api/inventory-scan/${id}/confirm`)
      .set('Authorization', `Bearer ${cookToken}`)
      .send({ intent: 'count_inventory', items: [] });

    expect(res.status).toBe(403);
  });

  it('still lets a manager commit a purchase', async () => {
    const id = await seedDraft({
      intent: 'record_purchase',
      vendor: 'Proveedor',
      total_amount: 200,
      items: [{ inventory_item_id: itemA, raw_name: 'Bohemia', quantity: 10, unit: 'btl', line_total: 200 }],
    });

    const res = await request(appForTenant(tenant.id))
      .post(`/api/inventory-scan/${id}/confirm`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ items: [] });

    expect(res.status).toBe(200);
    expect(res.body.intent).toBe('record_purchase');
  });

  // The exact prod shape from 2026-07-31: a Central de Abasto ticket whose line
  // items all read cleanly but whose printed total was lost to a shadow. This
  // returned 500 "Failed to save" and left the draft stranded at
  // 'pending_confirm' with no failure_reason and no way for the operator to fix
  // it from the review screen.
  it('commits a purchase whose printed total the camera could not read', async () => {
    const id = await seedDraft({
      intent: 'record_purchase',
      vendor: 'Saavedra Market',
      total_amount: null,
      items: [
        { inventory_item_id: itemA, raw_name: 'Q. Oaxaca', quantity: 4, unit: 'kg', line_total: 460 },
        { inventory_item_id: itemB, raw_name: 'Q. Cheddar', quantity: 2, unit: 'kg', line_total: 380 },
      ],
    });

    const res = await request(appForTenant(tenant.id))
      .post(`/api/inventory-scan/${id}/confirm`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ items: [] });

    expect(res.status).toBe(200);

    expect(res.body.summary.amount).toBe(840);

    // Booked at the sum of the lines, and the expense says so — an owner
    // reconciling against the paper ticket must not read this as a printed total.
    const row = await get(
      'SELECT status, executed_resource_id FROM voice_intents WHERE id = $1',
      [id]
    );
    expect(row.status).toBe('confirmed');

    const booked = await get('SELECT amount, notes FROM expenses WHERE id = $1', [
      row.executed_resource_id,
    ]);
    expect(Number(booked.amount)).toBe(840);
    expect(booked.notes).toMatch(/sumando las partidas/);
  });

  // The operator's escape hatch when the lines don't sum to what was paid.
  it('books the operator-typed total over the derived one', async () => {
    const id = await seedDraft({
      intent: 'record_purchase',
      vendor: 'Bodega G-65',
      total_amount: null,
      items: [
        { inventory_item_id: itemA, raw_name: 'Q. Oaxaca', quantity: 3, unit: 'kg', line_total: 300 },
      ],
    });

    const res = await request(appForTenant(tenant.id))
      .post(`/api/inventory-scan/${id}/confirm`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ items: [], total_amount: 348 }); // 300 + IVA the lines never showed

    expect(res.status).toBe(200);
    expect(res.body.summary.amount).toBe(348);

    const row = await get('SELECT executed_resource_id FROM voice_intents WHERE id = $1', [id]);
    const booked = await get('SELECT amount, notes FROM expenses WHERE id = $1', [
      row.executed_resource_id,
    ]);
    expect(Number(booked.amount)).toBe(348);
    // Not derived — so it must NOT carry the derived-total disclaimer.
    expect(booked.notes || '').not.toMatch(/sumando las partidas/);
  });

  // The mango/maíz correction, end to end: the draft is bound to the WRONG SKU
  // and the operator re-points it. Deltas rather than absolutes because earlier
  // tests in this file already moved these rows.
  it('restocks the SKU the operator re-pointed the line at, not the misread one', async () => {
    const before = await get(
      'SELECT id, quantity FROM inventory_items WHERE id = ANY($1::int[]) ORDER BY id',
      [[itemA, itemB]]
    ).then(() => Promise.all([
      get('SELECT quantity FROM inventory_items WHERE id = $1', [itemA]),
      get('SELECT quantity FROM inventory_items WHERE id = $1', [itemB]),
    ]));

    const id = await seedDraft({
      intent: 'record_purchase',
      vendor: 'Frutería',
      total_amount: 400,
      // Bound to itemA — the fuzzy matcher's mistake.
      items: [{
        inventory_item_id: itemA, raw_name: 'Maiz', quantity: 4, unit: 'kg',
        pack_size: 1, line_total: 400, received_qty_base_unit: 4,
        derived_unit_cost: 100, _fuzzy_matched: true,
      }],
    });

    const res = await request(appForTenant(tenant.id))
      .post(`/api/inventory-scan/${id}/confirm`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ items: [{ index: 0, bind_inventory_item_id: itemB }] });

    expect(res.status).toBe(200);

    const afterA = await get('SELECT quantity FROM inventory_items WHERE id = $1', [itemA]);
    const afterB = await get('SELECT quantity FROM inventory_items WHERE id = $1', [itemB]);
    // The misread SKU is untouched; the corrected one got all 4.
    expect(Number(afterA.quantity)).toBe(Number(before[0].quantity));
    expect(Number(afterB.quantity)).toBe(Number(before[1].quantity) + 4);
  });

  it('rejects a re-point at an inventory id outside the tenant', async () => {
    // Silently ignoring it would be the dangerous outcome: the line keeps its
    // original binding and restocks exactly the item being corrected away from.
    const id = await seedDraft({
      intent: 'record_purchase',
      vendor: 'Frutería',
      total_amount: 400,
      items: [{
        inventory_item_id: itemA, raw_name: 'Maiz', quantity: 4, unit: 'kg',
        pack_size: 1, line_total: 400, received_qty_base_unit: 4, derived_unit_cost: 100,
      }],
    });

    const res = await request(appForTenant(tenant.id))
      .post(`/api/inventory-scan/${id}/confirm`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ items: [{ index: 0, bind_inventory_item_id: 2147483600 }] });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unknown_inventory_item');

    // Nothing committed — the operator can fix the pick and retry.
    const row = await get('SELECT status FROM voice_intents WHERE id = $1', [id]);
    expect(row.status).toBe('pending_confirm');
  });

  // An operator-corrected quantity has to reach the restock. Before
  // deriveLineEconomics ran at override time this silently restocked the
  // draft's original figure.
  it('restocks the operator-corrected quantity, not the drafted one', async () => {
    const before = await get('SELECT quantity FROM inventory_items WHERE id = $1', [itemB]);

    const id = await seedDraft({
      intent: 'record_purchase',
      vendor: 'Frutería',
      total_amount: 300,
      items: [{
        inventory_item_id: itemB, raw_name: 'Tecate', quantity: 10, unit: 'can',
        pack_size: 1, line_total: 1000, received_qty_base_unit: 10, derived_unit_cost: 100,
      }],
    });

    const res = await request(appForTenant(tenant.id))
      .post(`/api/inventory-scan/${id}/confirm`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ items: [{ index: 0, quantity: 3, line_total: 300 }] });

    expect(res.status).toBe(200);
    const after = await get('SELECT quantity FROM inventory_items WHERE id = $1', [itemB]);
    expect(Number(after.quantity)).toBe(Number(before.quantity) + 3);
  });

  // A failure that survives the response. tenantMiddleware ROLLBACKs on >= 400,
  // which used to erase the marker written on the request connection — the
  // reason prod had zero 'failed' rows despite repeated failures.
  it('records why a commit failed, and leaves the draft retryable', async () => {
    const id = await seedDraft({
      intent: 'record_purchase',
      vendor: 'Sin Total',
      total_amount: null,
      // No line totals either, so there is genuinely nothing to derive from.
      items: [{ inventory_item_id: itemA, raw_name: 'Q. Oaxaca', quantity: 3, unit: 'kg' }],
    });

    const res = await request(appForTenant(tenant.id))
      .post(`/api/inventory-scan/${id}/confirm`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ items: [] });

    expect(res.status).toBe(500);

    const row = await get(
      'SELECT status, failure_reason FROM voice_intents WHERE id = $1',
      [id]
    );
    expect(row.failure_reason).toMatch(/total amount missing/i);
    // Still pending: the operator's next move is to type the total and retry,
    // which a terminal 'failed' status would turn into a 409.
    expect(row.status).toBe('pending_confirm');

    // And the retry works.
    const retry = await request(appForTenant(tenant.id))
      .post(`/api/inventory-scan/${id}/confirm`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ items: [], total_amount: 275 });
    expect(retry.status).toBe(200);
  });
});

describe('GET /api/inventory-scan/recent', () => {
  it('reports pos_scan activity for the owner surface', async () => {
    const res = await request(appForTenant(tenant.id))
      .get('/api/inventory-scan/recent?limit=5')
      .set('Authorization', `Bearer ${managerToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.scans)).toBe(true);
    expect(res.body.scans.length).toBeLessThanOrEqual(5);
    // Earlier blocks confirmed several drafts, so the 30-day count is non-zero.
    expect(res.body.confirmed_30d).toBeGreaterThan(0);
    for (const s of res.body.scans) {
      expect(['count_inventory', 'record_purchase']).toContain(s.intent);
    }
  });

  it('is owner-only — a line cook cannot read the tenant-wide feed', async () => {
    const res = await request(appForTenant(tenant.id))
      .get('/api/inventory-scan/recent')
      .set('Authorization', `Bearer ${cookToken}`);

    expect(res.status).toBe(403);
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

  it('keeps the tenant context alive across multer', async () => {
    // THE regression. multer consumes the request stream, and stream events
    // fire in the connection's async context — created when the socket was
    // accepted, before tenantContext.run() — so ALS was empty by the time the
    // handler ran. Two consequences in prod: getTenantId() returned null and
    // the voice_intents INSERT died on NOT NULL, and (worse) getConn() fell
    // back to adminSql, so parseReceiptImage's inventory SELECT read across
    // ALL tenants into the Claude prompt.
    //
    // Reproduced against the real middleware chain rather than the route, so it
    // costs no vision call: same asTenant harness, same multipart body, same
    // capture/restore pair. Without restoreTenantContext this reports null.
    const express2 = express();
    let seenTenant: string | null | undefined;
    let seenConn = false;

    express2.use((req: any, res, next) => {
      void asTenant(tenant.id, () => new Promise<void>((resolve) => {
        res.on('finish', resolve);
        res.on('close', resolve);
        next();
      }));
    });
    // Mirrors the route's chain: capture → multer → restore.
    express2.post(
      '/probe',
      (req: any, _res, next) => { req._tenantStore = tenantContext.getStore(); next(); },
      multerProbe.single('photo'),
      (req: any, _res, next) => {
        const store = req._tenantStore;
        if (!store) return next();
        tenantContext.run(store, next);
      },
      (_req, res) => {
        seenTenant = getTenantId();
        seenConn = Boolean(tenantContext.getStore()?.conn);
        res.json({ ok: true });
      },
    );

    const res = await request(express2)
      .post('/probe')
      // Size matters: a few bytes are consumed in one synchronous pass and ALS
      // survives by luck. A real phone photo is megabytes, so busboy emits many
      // data events from the SOCKET's async context and the store is gone.
      .attach('photo', Buffer.alloc(3 * 1024 * 1024, 7), {
        filename: 'shelf.jpg',
        contentType: 'image/jpeg',
      });

    expect(res.status).toBe(200);
    expect(seenTenant).toBe(tenant.id);
    // The connection matters as much as the id: without it getConn() returns
    // adminSql and every query silently bypasses RLS.
    expect(seenConn).toBe(true);
  });

  it('is rate limited per employee', async () => {
    // Asserts the limiter is mounted and its ceiling, rather than firing 31
    // requests to re-test express-rate-limit itself. The cap matters because
    // each scan is a paid vision call — an unbounded retry loop is a bill.
    // No photo: the limiter runs (and sets its headers) before multer, so this
    // stops at the 400 without reaching the paid vision call.
    const res = await request(appForTenant(tenant.id))
      .post('/api/inventory-scan')
      .set('Authorization', `Bearer ${otherToken}`)
      .field('caption', 'conteo');

    expect(res.status).toBe(400);
    expect(res.headers['ratelimit-limit']).toBe('30');
  });
});
