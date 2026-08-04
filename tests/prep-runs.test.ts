// Producción — prep runs, the conversion event between raw stock and sellable
// portions.
//
// What's worth pinning here, in order of how badly it hurts when wrong:
//
//   1. MODE ISOLATION. Every tenant on the platform is 'ingredients' by
//      default and must see none of this. A prep run against an ingredients
//      tenant is a 403, and the list endpoint answers with an empty set rather
//      than an error, because the POS client reads its `mode` from it.
//   2. LAYER DISCIPLINE. Raw goes in, components come out. Accepting a run
//      that produced a raw ingredient would corrupt both the yield math and the
//      availability derivation P2 builds on kind='component'.
//   3. COST PER PORTION. The whole financial argument for prep runs is that
//      snapshotting input costs yields true cost/portion for free. If the
//      weighted average is wrong, every plate-cost number downstream is wrong.
//   4. CORRECTIONS DON'T REWRITE HISTORY. A miscount is a compensating ledger
//      entry, never an edit to what was originally recorded.

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
import { adminSql } from '../server/db/index.js';
// @ts-ignore
import { updateTenant } from '../server/tenants.js';
// @ts-ignore
import prepRunsRouter from '../server/routes/prep-runs.js';
// @ts-ignore
import { JWT_SECRET } from '../server/lib/constants.js';

let tenant: TestTenant;      // two_stage
let plainTenant: TestTenant; // ingredients (the default every tenant has today)
let managerId = 0;
let cookId = 0;
let managerToken = '';
let cookToken = '';
let plainManagerToken = '';

function appForTenant(tenantId: string, plan = 'pro') {
  const app = express();
  app.use(express.json());
  app.use((req: any, res, next) => {
    req.tenant = { id: tenantId, plan };
    void asTenant(tenantId, () => new Promise<void>((resolve) => {
      res.on('finish', resolve);
      res.on('close', resolve);
      next();
    }));
  });
  app.use('/api/prep-runs', prepRunsRouter);
  return app;
}

function tokenFor(tenantId: string, employeeId: number, role: string) {
  return jwt.sign(
    { tenantId, employeeId, role, type: 'employee' },
    JWT_SECRET,
    { expiresIn: '24h' },
  );
}

async function seedItem(
  tenantId: string,
  name: string,
  quantity: number,
  kind: 'raw' | 'component',
  costPrice = 0
): Promise<number> {
  const [row] = await adminSql`
    INSERT INTO inventory_items (tenant_id, name, quantity, unit, cost_price, kind)
    VALUES (${tenantId}, ${name}, ${quantity}, ${kind === 'raw' ? 'kg' : 'porción'},
            ${costPrice}, ${kind})
    RETURNING id
  `;
  return Number(row.id);
}

async function itemRow(id: number) {
  const [row] = await adminSql`SELECT quantity, cost_price FROM inventory_items WHERE id = ${id}`;
  return { quantity: Number(row.quantity), cost_price: Number(row.cost_price) };
}

beforeAll(async () => {
  tenant = await createTestTenant('preprun');
  plainTenant = await createTestTenant('preprun-plain');

  // Through updateTenant, not raw SQL: getTenant() is cached and
  // createTestTenant has already warmed it, so a direct UPDATE would be
  // invisible to the routes for the life of the process.
  await updateTenant(tenant.id, { inventory_mode: 'two_stage' });

  const mgr = await adminSql`
    INSERT INTO employees (tenant_id, name, pin, role, active)
    VALUES (${tenant.id}, 'Prep Mgr', '5151', 'manager', true) RETURNING id
  `;
  managerId = Number(mgr[0].id);
  managerToken = tokenFor(tenant.id, managerId, 'manager');

  // A cashier with no manage_inventory permission — the "any clocked-in
  // employee can log production" case.
  const cook = await adminSql`
    INSERT INTO employees (tenant_id, name, pin, role, active)
    VALUES (${tenant.id}, 'Cocinero', '5252', 'cashier', true) RETURNING id
  `;
  cookId = Number(cook[0].id);
  cookToken = tokenFor(tenant.id, cookId, 'cashier');

  const plainMgr = await adminSql`
    INSERT INTO employees (tenant_id, name, pin, role, active)
    VALUES (${plainTenant.id}, 'Plain Mgr', '5353', 'manager', true) RETURNING id
  `;
  plainManagerToken = tokenFor(plainTenant.id, Number(plainMgr[0].id), 'manager');
});

afterAll(async () => {
  await dropTestTenant(tenant.id);
  await dropTestTenant(plainTenant.id);
  await closePools();
});

describe('mode isolation — the default tenant sees nothing', () => {
  it('403s a prep run for an ingredients-mode tenant', async () => {
    const res = await request(appForTenant(plainTenant.id))
      .post('/api/prep-runs')
      .set('Authorization', `Bearer ${plainManagerToken}`)
      .send({ outputs: [{ inventory_item_id: 1, portions: 1 }] });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('INVENTORY_MODE_REQUIRED');
  });

  it('answers the list endpoint with its mode instead of an error', async () => {
    // This is the POS client's mode-discovery channel — it must not 403.
    const res = await request(appForTenant(plainTenant.id))
      .get('/api/prep-runs')
      .set('Authorization', `Bearer ${plainManagerToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mode: 'ingredients', runs: [] });
  });
});

describe('POST /api/prep-runs', () => {
  it('moves raw down and components up in one run', async () => {
    const rawId = await seedItem(tenant.id, 'Arrachera cruda', 10, 'raw', 189.5);
    const compId = await seedItem(tenant.id, 'Porción asada', 0, 'component');

    const res = await request(appForTenant(tenant.id))
      .post('/api/prep-runs')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({
        inputs: [{ inventory_item_id: rawId, quantity: 10 }],
        outputs: [{ inventory_item_id: compId, portions: 42 }],
        notes: 'arrachera del martes',
      });

    expect(res.status).toBe(201);
    expect((await itemRow(rawId)).quantity).toBe(0);
    expect((await itemRow(compId)).quantity).toBe(42);

    // 10 kg × $189.50 = $1,895 over 42 portions = $45.119…/portion
    expect(res.body.total_input_cost).toBe(1895);
    expect(res.body.cost_per_portion).toBeCloseTo(45.119, 3);
    expect((await itemRow(compId)).cost_price).toBeCloseTo(45.12, 2);

    // The input cost was snapshotted, not referenced.
    const [input] = await adminSql`
      SELECT cost_at_time FROM prep_run_inputs WHERE prep_run_id = ${res.body.id}
    `;
    expect(Number(input.cost_at_time)).toBe(189.5);
  });

  it('accepts a run with no inputs at all', async () => {
    // Outputs are the hard requirement; inputs are what buy yield data.
    const compId = await seedItem(tenant.id, 'Porción pollo', 5, 'component', 30);

    const res = await request(appForTenant(tenant.id))
      .post('/api/prep-runs')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ outputs: [{ inventory_item_id: compId, portions: 20 }] });

    expect(res.status).toBe(201);
    expect(res.body.cost_per_portion).toBeNull();
    expect((await itemRow(compId)).quantity).toBe(25);
    // With no input cost there is nothing to average — the old cost stands.
    expect((await itemRow(compId)).cost_price).toBe(30);
  });

  it('lets any clocked-in employee log production', async () => {
    const compId = await seedItem(tenant.id, 'Porción birria', 0, 'component');
    const res = await request(appForTenant(tenant.id))
      .post('/api/prep-runs')
      .set('Authorization', `Bearer ${cookToken}`)
      .send({ outputs: [{ inventory_item_id: compId, portions: 12 }] });

    expect(res.status).toBe(201);
    expect(res.body.employee_id).toBe(cookId);
  });

  it('blends cost against portions already on the line', async () => {
    // 10 portions held at $20, plus 10 produced at $40 → $30.
    const rawId = await seedItem(tenant.id, 'Cerdo crudo', 100, 'raw', 40);
    const compId = await seedItem(tenant.id, 'Porción cochinita', 10, 'component', 20);

    await request(appForTenant(tenant.id))
      .post('/api/prep-runs')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({
        inputs: [{ inventory_item_id: rawId, quantity: 10 }], // $400
        outputs: [{ inventory_item_id: compId, portions: 10 }], // $40/portion
      });

    const after = await itemRow(compId);
    expect(after.quantity).toBe(20);
    expect(after.cost_price).toBeCloseTo(30, 4);
  });

  it('writes one ledger row per line, tagged to the run', async () => {
    const rawId = await seedItem(tenant.id, 'Res cruda', 20, 'raw', 100);
    const compId = await seedItem(tenant.id, 'Porción res', 0, 'component');

    const res = await request(appForTenant(tenant.id))
      .post('/api/prep-runs')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({
        inputs: [{ inventory_item_id: rawId, quantity: 5 }],
        outputs: [{ inventory_item_id: compId, portions: 25 }],
      });

    const rows = await adminSql`
      SELECT inventory_item_id, delta, reason, employee_id
        FROM portion_ledger
       WHERE ref_type = 'prep_run' AND ref_id = ${res.body.id}
       ORDER BY id
    `;
    expect(rows).toHaveLength(2);
    expect(Number(rows[0].delta)).toBe(-5);
    expect(rows[0].reason).toBe('prep_consume');
    expect(Number(rows[1].delta)).toBe(25);
    expect(rows[1].reason).toBe('prep_produce');
    expect(Number(rows[1].employee_id)).toBe(managerId);
  });
});

describe('validation', () => {
  it('requires outputs', async () => {
    const rawId = await seedItem(tenant.id, 'Sin salida', 10, 'raw');
    const res = await request(appForTenant(tenant.id))
      .post('/api/prep-runs')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ inputs: [{ inventory_item_id: rawId, quantity: 1 }] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/outputs is required/i);
    // Nothing moved.
    expect((await itemRow(rawId)).quantity).toBe(10);
  });

  it('refuses a component as a prep input', async () => {
    const compA = await seedItem(tenant.id, 'Porción A', 10, 'component');
    const compB = await seedItem(tenant.id, 'Porción B', 0, 'component');

    const res = await request(appForTenant(tenant.id))
      .post('/api/prep-runs')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({
        inputs: [{ inventory_item_id: compA, quantity: 2 }],
        outputs: [{ inventory_item_id: compB, portions: 2 }],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/prep inputs must be raw stock/i);
    expect((await itemRow(compA)).quantity).toBe(10);
    expect((await itemRow(compB)).quantity).toBe(0);
  });

  it('refuses raw stock as a prep output', async () => {
    const rawIn = await seedItem(tenant.id, 'Crudo entrada', 10, 'raw');
    const rawOut = await seedItem(tenant.id, 'Crudo salida', 0, 'raw');

    const res = await request(appForTenant(tenant.id))
      .post('/api/prep-runs')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({
        inputs: [{ inventory_item_id: rawIn, quantity: 1 }],
        outputs: [{ inventory_item_id: rawOut, portions: 1 }],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/prep outputs must be components/i);
  });

  it('rejects non-positive quantities', async () => {
    const compId = await seedItem(tenant.id, 'Porción cero', 0, 'component');
    const res = await request(appForTenant(tenant.id))
      .post('/api/prep-runs')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ outputs: [{ inventory_item_id: compId, portions: 0 }] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/portions must be greater than 0/i);
  });

  it('rejects an item from another tenant', async () => {
    const foreign = await seedItem(plainTenant.id, 'Ajeno', 10, 'component');
    const res = await request(appForTenant(tenant.id))
      .post('/api/prep-runs')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ outputs: [{ inventory_item_id: foreign, portions: 1 }] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not found/i);
    expect((await itemRow(foreign)).quantity).toBe(10);
  });
});

describe('GET /api/prep-runs', () => {
  it('returns runs newest-first with their lines and yield economics', async () => {
    const res = await request(appForTenant(tenant.id))
      .get('/api/prep-runs?limit=50')
      .set('Authorization', `Bearer ${managerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('two_stage');
    expect(res.body.runs.length).toBeGreaterThan(0);

    const withInputs = res.body.runs.find((r: any) => r.inputs.length > 0);
    expect(withInputs).toBeTruthy();
    expect(withInputs.outputs.length).toBeGreaterThan(0);
    expect(withInputs.cost_per_portion).toBeGreaterThan(0);
    expect(withInputs.employee_name).toBeTruthy();
  });
});

describe('POST /api/prep-runs/:id/corrections', () => {
  it('requires manage_inventory', async () => {
    const compId = await seedItem(tenant.id, 'Porción corregible', 0, 'component');
    const created = await request(appForTenant(tenant.id))
      .post('/api/prep-runs')
      .set('Authorization', `Bearer ${cookToken}`)
      .send({ outputs: [{ inventory_item_id: compId, portions: 40 }] });

    const res = await request(appForTenant(tenant.id))
      .post(`/api/prep-runs/${created.body.id}/corrections`)
      .set('Authorization', `Bearer ${cookToken}`)
      .send({ entries: [{ inventory_item_id: compId, delta: -4 }] });

    expect(res.status).toBe(403);
    expect((await itemRow(compId)).quantity).toBe(40);
  });

  it('posts a compensating entry without touching the original run', async () => {
    const compId = await seedItem(tenant.id, 'Porción recontada', 0, 'component');
    const created = await request(appForTenant(tenant.id))
      .post('/api/prep-runs')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ outputs: [{ inventory_item_id: compId, portions: 42 }] });
    const runId = created.body.id;

    const res = await request(appForTenant(tenant.id))
      .post(`/api/prep-runs/${runId}/corrections`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ entries: [{ inventory_item_id: compId, delta: -4 }], notes: 'conteo mal' });

    expect(res.status).toBe(200);
    expect((await itemRow(compId)).quantity).toBe(38);

    // The run still says 42 — history is not rewritten.
    const [original] = await adminSql`
      SELECT portions FROM prep_run_outputs WHERE prep_run_id = ${runId}
    `;
    expect(Number(original.portions)).toBe(42);

    // ...and the correction is its own ledger row.
    const corrections = await adminSql`
      SELECT delta FROM portion_ledger
       WHERE ref_type = 'prep_run_correction' AND ref_id = ${runId}
    `;
    expect(corrections).toHaveLength(1);
    expect(Number(corrections[0].delta)).toBe(-4);

    // The correction surfaces on the run in the list payload.
    const list = await request(appForTenant(tenant.id))
      .get('/api/prep-runs?limit=50')
      .set('Authorization', `Bearer ${managerToken}`);
    const listed = list.body.runs.find((r: any) => r.id === runId);
    expect(listed.corrections).toHaveLength(1);
    expect(listed.corrections[0].delta).toBe(-4);
    expect(listed.notes).toMatch(/\[corrección\] conteo mal/);
  });

  it('404s an unknown run', async () => {
    const res = await request(appForTenant(tenant.id))
      .post('/api/prep-runs/2147483000/corrections')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ entries: [{ inventory_item_id: 1, delta: -1 }] });

    expect(res.status).toBe(404);
  });

  it('rejects a zero delta', async () => {
    const compId = await seedItem(tenant.id, 'Porción cero delta', 0, 'component');
    const created = await request(appForTenant(tenant.id))
      .post('/api/prep-runs')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ outputs: [{ inventory_item_id: compId, portions: 5 }] });

    const res = await request(appForTenant(tenant.id))
      .post(`/api/prep-runs/${created.body.id}/corrections`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ entries: [{ inventory_item_id: compId, delta: 0 }] });

    expect(res.status).toBe(400);
    expect((await itemRow(compId)).quantity).toBe(5);
  });
});
