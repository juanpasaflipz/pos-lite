// Staff phone registration — the WhatsApp-ops identity field (2026-07-28).
//
// `employees.phone` is the ONLY thing that decides whether an inbound WhatsApp
// message from a staff member gets answered. resolveEmployeeByPhone() matches
// the sender against this column; no row, no reply, and the employee sees a
// photo vanish into silence with no error anywhere.
//
// Before this change the column existed (migration 0059) but nothing wrote to
// it — no API field, no form input — so every tenant had to be seeded by hand
// with raw SQL. What these tests pin down:
//
//   1. NORMALIZATION ROUND-TRIP — the invariant that actually matters. A number
//      typed by an owner in any plausible MX format must be stored in a form
//      that resolveEmployeeByPhone() finds again, given the shapes the real
//      transports send: WhatsApp Cloud delivers MX as `+52` + 10 digits, Twilio
//      SMS as `+521` + 10. A normalizer that stored `+521…` would still be
//      "valid E.164" and would still silently fail half the lookups.
//
//   2. NON-MX PASSTHROUGH — toE164() force-feeds +52 to anything it doesn't
//      recognize as US/CA, which would mangle a US staff number into a
//      nonexistent Mexican one. An explicit country code has to survive.
//
//   3. UNIQUENESS SCOPE — uq_employees_tenant_phone is per-tenant. Two
//      employees at one restaurant may not share a number (the lookup would be
//      ambiguous), but the same owner working two locations must be able to
//      register the same phone under both.
//
//   4. THE API SURFACE — POST/PUT actually accept and persist the field, a
//      duplicate comes back as a 409 naming the holder rather than a 500, and
//      a PUT that carries no `pin` leaves the existing hash alone. That last
//      one is what makes "add a phone to an existing employee" possible at all
//      without resetting their PIN.

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
import employeesRouter, { normalizeStaffPhone } from '../server/routes/employees.js';
// @ts-ignore
import { resolveEmployeeByPhone } from '../server/helpers/inboundVoiceOps.js';
// @ts-ignore
import { JWT_SECRET } from '../server/lib/constants.js';

let tenantA: TestTenant;
let tenantB: TestTenant;
let adminToken: string;

// Mount the real router behind a stub that reproduces what tenantMiddleware
// does in prod: resolve the tenant AND put an RLS-scoped connection on
// AsyncLocalStorage. Without the asTenant wrapper, get()/run() inside the
// router fall back to adminSql and quietly bypass RLS — the tests would pass
// while proving nothing about tenant isolation.
function appForTenant(tenantId: string) {
  const app = express();
  app.use(express.json());
  app.use((req: any, res, next) => {
    req.tenant = { id: tenantId, plan: 'pro' };
    void asTenant(tenantId, () => new Promise<void>((resolve) => {
      res.on('finish', resolve);
      res.on('close', resolve);
      next();
    }));
  });
  app.use('/api/employees', employeesRouter);
  return app;
}

beforeAll(async () => {
  tenantA = await createTestTenant('phone-a');
  tenantB = await createTestTenant('phone-b');

  const admin = await adminSql`
    INSERT INTO employees (tenant_id, name, pin, role, active)
    VALUES (${tenantA.id}, 'Boss', '9999', 'admin', true)
    RETURNING id
  `;
  adminToken = jwt.sign(
    { tenantId: tenantA.id, employeeId: Number(admin[0].id), role: 'admin', type: 'employee' },
    JWT_SECRET,
    { expiresIn: '24h' },
  );
});

afterAll(async () => {
  await dropTestTenant(tenantA.id);
  await dropTestTenant(tenantB.id);
  await closePools();
});

// ==================== 1. Normalization ====================

describe('normalizeStaffPhone', () => {
  it('collapses every MX format an owner might type into one stored form', () => {
    // All of these are the same human number. If they stored differently, two
    // employees could be entered "twice" and the unique index would not catch it.
    const forms = [
      '5512345678',        // bare 10 digits, how it's written on a schedule
      '55 1234 5678',      // spaced
      '(55) 1234-5678',    // punctuated
      '+52 55 1234 5678',  // WhatsApp form, spaced
      '+525512345678',     // WhatsApp form, E.164
      '+5215512345678',    // Twilio SMS form, with the MX mobile "1"
      '525512345678',      // no plus
    ];
    for (const form of forms) {
      expect(normalizeStaffPhone(form), form).toEqual({ value: '+525512345678' });
    }
  });

  it('preserves an explicit non-MX country code instead of forcing +52', () => {
    // toE164() alone would turn this into +525551234567 — a real-looking MX
    // number that belongs to someone else, or to nobody.
    expect(normalizeStaffPhone('+15551234567')).toEqual({ value: '+15551234567' });
    expect(normalizeStaffPhone('+1 (555) 123-4567')).toEqual({ value: '+15551234567' });
    expect(normalizeStaffPhone('+34612345678')).toEqual({ value: '+34612345678' });
  });

  it('treats blank input as an explicit clear, not an error', () => {
    // Clearing the field is how an owner un-enrolls someone from WhatsApp ops.
    expect(normalizeStaffPhone('')).toEqual({ value: null });
    expect(normalizeStaffPhone('   ')).toEqual({ value: null });
    expect(normalizeStaffPhone(null)).toEqual({ value: null });
    expect(normalizeStaffPhone(undefined)).toEqual({ value: null });
  });

  it('rejects a half-typed number rather than storing an unmatchable one', () => {
    // A stored 7-digit fragment fails silently forever — no inbound message
    // would ever match it, and the roster would claim the employee is enrolled.
    expect(normalizeStaffPhone('551234').error).toBeTruthy();
    expect(normalizeStaffPhone('+52 55').error).toBeTruthy();
    expect(normalizeStaffPhone('abc').error).toBeTruthy();
  });
});

// ==================== 2. Round-trip against the real lookup ====================

describe('normalizeStaffPhone → resolveEmployeeByPhone round-trip', () => {
  it('a number stored from any typed form is found from any transport form', async () => {
    // The whole point: what the owner types and what Meta/Twilio sends are
    // different strings, and they still have to meet in the middle.
    const stored = normalizeStaffPhone('55 9876 5432').value;
    await adminSql`
      INSERT INTO employees (tenant_id, name, pin, role, phone, active)
      VALUES (${tenantA.id}, 'Roundtrip', '1234', 'cashier', ${stored}, true)
    `;

    const senders = [
      '+525598765432',   // WhatsApp Cloud (MX, no mobile prefix)
      '+5215598765432',  // Twilio SMS (MX mobile prefix)
      '525598765432',    // wa_id, no plus
      '5215598765432',   // wa_id with mobile prefix
    ];
    for (const sender of senders) {
      const employee = await resolveEmployeeByPhone(sender, tenantA.id);
      expect(employee?.name, sender).toBe('Roundtrip');
    }
  });

  it('does not answer a number that was never registered', async () => {
    // The "7 empleados sin teléfono" case — silence is correct here, but it
    // must be silence by lookup miss, not by an accidental fuzzy match.
    expect(await resolveEmployeeByPhone('+525500000000', tenantA.id)).toBeNull();
  });

  it('stops matching once the phone is cleared', async () => {
    const stored = normalizeStaffPhone('5511112222').value;
    await adminSql`
      INSERT INTO employees (tenant_id, name, pin, role, phone, active)
      VALUES (${tenantA.id}, 'Unenroll', '1234', 'cashier', ${stored}, true)
    `;
    expect((await resolveEmployeeByPhone('+525511112222', tenantA.id))?.name).toBe('Unenroll');

    // What a PUT with phone: '' does.
    await adminSql`
      UPDATE employees SET phone = ${normalizeStaffPhone('').value}
      WHERE tenant_id = ${tenantA.id} AND name = 'Unenroll'
    `;
    expect(await resolveEmployeeByPhone('+525511112222', tenantA.id)).toBeNull();
  });
});

// ==================== 3. Uniqueness scope ====================

describe('uq_employees_tenant_phone', () => {
  const SHARED = '+525533334444';

  it('refuses two employees at the same restaurant sharing a number', async () => {
    await adminSql`
      INSERT INTO employees (tenant_id, name, pin, role, phone, active)
      VALUES (${tenantA.id}, 'First', '1234', 'cashier', ${SHARED}, true)
    `;

    // A duplicate would make resolveEmployeeByPhone ambiguous — inventory
    // counts would be attributed to whichever row the planner returned.
    await expect(adminSql`
      INSERT INTO employees (tenant_id, name, pin, role, phone, active)
      VALUES (${tenantA.id}, 'Second', '5678', 'cashier', ${SHARED}, true)
    `).rejects.toMatchObject({ code: '23505' });
  });

  it('allows the same owner to register one number at two restaurants', async () => {
    // Legitimate and common: one person running two locations. Per-number
    // routing disambiguates at message time (see wa-cloud-routing.test.ts).
    await expect(adminSql`
      INSERT INTO employees (tenant_id, name, pin, role, phone, active)
      VALUES (${tenantB.id}, 'Same owner', '1234', 'admin', ${SHARED}, true)
    `).resolves.toBeDefined();
  });

  it('does not treat multiple employees without a phone as duplicates', async () => {
    // The partial index is WHERE phone IS NOT NULL — most staff have no number,
    // and NULLs must not collide with each other.
    for (const name of ['NoPhone1', 'NoPhone2', 'NoPhone3']) {
      await expect(adminSql`
        INSERT INTO employees (tenant_id, name, pin, role, phone, active)
        VALUES (${tenantA.id}, ${name}, '1234', 'kitchen', NULL, true)
      `).resolves.toBeDefined();
    }
  });
});

// ==================== 4. The API surface ====================

describe('POST /api/employees', () => {
  it('stores a typed phone in normalized form', async () => {
    const res = await request(appForTenant(tenantA.id))
      .post('/api/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Nueva', pin: '4321', role: 'cashier', phone: '(55) 7777-8888' });

    expect(res.status).toBe(201);
    expect(res.body.phone).toBe('+525577778888');

    const row = await asTenant(tenantA.id, () =>
      get('SELECT phone FROM employees WHERE id = $1', [res.body.id]));
    expect(row.phone).toBe('+525577778888');
  });

  it('still creates an employee when no phone is given', async () => {
    // Most staff never get one — the field must stay genuinely optional.
    const res = await request(appForTenant(tenantA.id))
      .post('/api/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Sin numero', pin: '4322', role: 'kitchen' });

    expect(res.status).toBe(201);
    expect(res.body.phone).toBeNull();
  });

  it('rejects a duplicate with a 409 that names the current holder', async () => {
    const res = await request(appForTenant(tenantA.id))
      .post('/api/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Copia', pin: '4323', role: 'cashier', phone: '5577778888' });

    // A 500 here would read as "the app is broken" instead of "Nueva has it".
    expect(res.status).toBe(409);
    expect(res.body.conflict_with).toBe('Nueva');
  });

  it('rejects a half-typed number with a 400', async () => {
    const res = await request(appForTenant(tenantA.id))
      .post('/api/employees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Corto', pin: '4324', role: 'cashier', phone: '5512' });

    expect(res.status).toBe(400);
  });
});

describe('PUT /api/employees/:id', () => {
  let targetId = 0;
  let originalPinHash = '';

  beforeAll(async () => {
    const rows = await adminSql`
      INSERT INTO employees (tenant_id, name, pin, role, active)
      VALUES (${tenantA.id}, 'Existente', 'hash-not-a-real-bcrypt', 'cashier', true)
      RETURNING id, pin
    `;
    targetId = Number(rows[0].id);
    originalPinHash = rows[0].pin;
  });

  it('registers a phone on an existing employee without touching their PIN', async () => {
    // This is the actual flow the WhatsApp Ops screen sends owners into: 7
    // employees already exist, none have numbers. If adding one silently reset
    // the PIN, every cashier would be locked out of the POS mid-shift.
    const res = await request(appForTenant(tenantA.id))
      .put(`/api/employees/${targetId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Existente', role: 'cashier', phone: '55 2222 3333' });

    expect(res.status).toBe(200);

    const row = await asTenant(tenantA.id, () =>
      get('SELECT phone, pin, pin_changed_at FROM employees WHERE id = $1', [targetId]));
    expect(row.phone).toBe('+525522223333');
    expect(row.pin).toBe(originalPinHash);
    // pin_changed_at invalidates live JWTs (middleware/auth.js) — a phone edit
    // must not stamp it, or it would log the employee out of the POS.
    expect(row.pin_changed_at).toBeNull();
  });

  it('is immediately live for the WhatsApp lookup', async () => {
    expect((await resolveEmployeeByPhone('+5215522223333', tenantA.id))?.name).toBe('Existente');
  });

  it('clears the phone when sent an empty string', async () => {
    const res = await request(appForTenant(tenantA.id))
      .put(`/api/employees/${targetId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ phone: '' });

    expect(res.status).toBe(200);
    const row = await asTenant(tenantA.id, () =>
      get('SELECT phone FROM employees WHERE id = $1', [targetId]));
    expect(row.phone).toBeNull();
  });

  it('leaves the phone alone when the field is absent', async () => {
    await asTenant(tenantA.id, () =>
      get(`UPDATE employees SET phone = '+525544445555' WHERE id = $1 RETURNING id`, [targetId]));

    const res = await request(appForTenant(tenantA.id))
      .put(`/api/employees/${targetId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Renombrado' });

    expect(res.status).toBe(200);
    const row = await asTenant(tenantA.id, () =>
      get('SELECT name, phone FROM employees WHERE id = $1', [targetId]));
    expect(row.name).toBe('Renombrado');
    expect(row.phone).toBe('+525544445555');
  });

  it('rejects taking a number another employee already holds', async () => {
    const res = await request(appForTenant(tenantA.id))
      .put(`/api/employees/${targetId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ phone: '+52 55 7777 8888' });

    expect(res.status).toBe(409);
    expect(res.body.conflict_with).toBe('Nueva');
  });

  it('lets an employee re-save the number they already hold', async () => {
    // The edit modal round-trips every field, so saving an unrelated change
    // re-submits the employee's own phone. That must not self-collide.
    const res = await request(appForTenant(tenantA.id))
      .put(`/api/employees/${targetId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Renombrado', phone: '+525544445555' });

    expect(res.status).toBe(200);
  });
});

describe('GET /api/employees', () => {
  it('returns the phone so the roster can show who is still missing one', async () => {
    const res = await request(appForTenant(tenantA.id))
      .get('/api/employees')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    const nueva = res.body.find((e: any) => e.name === 'Nueva');
    expect(nueva.phone).toBe('+525577778888');
    const sinNumero = res.body.find((e: any) => e.name === 'Sin numero');
    expect(sinNumero.phone).toBeNull();
  });
});
