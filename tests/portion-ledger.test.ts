// portion_ledger / applyStockDelta — the invariant the whole two-stage model
// rests on.
//
// inventory_items.quantity is a CACHE over portion_ledger. These tests pin the
// three things that make that claim true:
//   - the ledger and the cache agree exactly when nothing clamped
//   - when a deduction drives stock below zero, the cache clamps at 0 while the
//     ledger keeps the real (unclamped) delta, so oversell stays visible
//   - app_user (the role every /api/* request runs as) cannot rewrite or erase
//     a ledger row — migration 0103's REVOKE, not its GRANT, is what enforces it

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestTenant,
  dropTestTenant,
  asTenant,
  closePools,
  type TestTenant,
} from './helpers/db.js';
// @ts-ignore — server files are plain JS
import { adminSql, get, all } from '../server/db/index.js';
// @ts-ignore
import { applyStockDelta, applyStockDeltas, LEDGER_REASONS } from '../server/helpers/stockLedger.js';

let tenant: TestTenant;

/** Create an inventory item and return its id. */
async function seedItem(
  tenantId: string,
  name: string,
  quantity: number,
  kind: 'raw' | 'component' = 'component'
): Promise<number> {
  const [row] = await adminSql`
    INSERT INTO inventory_items (tenant_id, name, quantity, unit, cost_price, kind)
    VALUES (${tenantId}, ${name}, ${quantity}, ${kind === 'component' ? 'porción' : 'kg'}, 10, ${kind})
    RETURNING id
  `;
  return Number(row.id);
}

async function ledgerFor(itemId: number) {
  return all(
    `SELECT delta, reason, ref_type, ref_id, employee_id
       FROM portion_ledger WHERE inventory_item_id = $1 ORDER BY id`,
    [itemId]
  );
}

async function quantityOf(itemId: number): Promise<number> {
  const row = await get('SELECT quantity FROM inventory_items WHERE id = $1', [itemId]);
  return Number(row.quantity);
}

beforeAll(async () => {
  tenant = await createTestTenant('ledger');
});

afterAll(async () => {
  await dropTestTenant(tenant.id);
  await closePools();
});

describe('applyStockDelta — single entry', () => {
  it('moves the cached quantity and appends one ledger row', async () => {
    await asTenant(tenant.id, async () => {
      const itemId = await seedItem(tenant.id, 'Porción asada', 10);

      const result = await applyStockDelta(null, {
        itemId,
        delta: 42,
        reason: 'prep_produce',
        refType: 'prep_run',
        refId: 7,
        employeeId: null,
      });

      expect(result).toEqual({ itemId, quantity: 52 });
      expect(await quantityOf(itemId)).toBe(52);

      const rows = await ledgerFor(itemId);
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].delta)).toBe(42);
      expect(rows[0].reason).toBe('prep_produce');
      expect(rows[0].ref_type).toBe('prep_run');
      expect(Number(rows[0].ref_id)).toBe(7);
    });
  });

  it('stamps tenant_id from the RLS session default', async () => {
    await asTenant(tenant.id, async () => {
      const itemId = await seedItem(tenant.id, 'Tortilla', 100);
      await applyStockDelta(null, { itemId, delta: -5, reason: 'waste' });

      const row = await get(
        'SELECT tenant_id FROM portion_ledger WHERE inventory_item_id = $1',
        [itemId]
      );
      expect(row.tenant_id).toBe(tenant.id);
    });
  });
});

describe('applyStockDeltas — batch', () => {
  it('collapses same-item entries into one quantity write but keeps a row per entry', async () => {
    await asTenant(tenant.id, async () => {
      const itemId = await seedItem(tenant.id, 'Porción pollo', 0);

      const results = await applyStockDeltas(null, [
        { itemId, delta: 20, reason: 'prep_produce', refType: 'prep_run', refId: 1 },
        { itemId, delta: 15, reason: 'prep_produce', refType: 'prep_run', refId: 2 },
      ]);

      // Both results report the same post-update quantity — there was one write.
      expect(results).toEqual([
        { itemId, quantity: 35 },
        { itemId, quantity: 35 },
      ]);

      // ...but the ledger keeps them apart, which is what lets P2 ask
      // "was THIS order line already deducted?".
      const rows = await ledgerFor(itemId);
      expect(rows).toHaveLength(2);
      expect(rows.map((r: any) => Number(r.ref_id))).toEqual([1, 2]);
    });
  });

  it('applies opposite-direction entries across different items in one call', async () => {
    await asTenant(tenant.id, async () => {
      const rawId = await seedItem(tenant.id, 'Arrachera cruda', 10, 'raw');
      const componentId = await seedItem(tenant.id, 'Porción arrachera', 0);

      await applyStockDeltas(null, [
        { itemId: rawId, delta: -8, reason: 'prep_consume', refType: 'prep_run', refId: 9 },
        { itemId: componentId, delta: 42, reason: 'prep_produce', refType: 'prep_run', refId: 9 },
      ]);

      expect(await quantityOf(rawId)).toBe(2);
      expect(await quantityOf(componentId)).toBe(42);
    });
  });

  it('is a no-op for an empty batch', async () => {
    await asTenant(tenant.id, async () => {
      await expect(applyStockDeltas(null, [])).resolves.toEqual([]);
    });
  });
});

describe('the cache/ledger invariant', () => {
  it('sums exactly to the cached quantity when nothing clamps', async () => {
    await asTenant(tenant.id, async () => {
      const itemId = await seedItem(tenant.id, 'Porción birria', 0);

      await applyStockDeltas(null, [
        { itemId, delta: 30, reason: 'prep_produce' },
        { itemId, delta: -4, reason: 'sale' },
        { itemId, delta: -1, reason: 'waste' },
        { itemId, delta: 2, reason: 'refund_restore' },
      ]);

      const row = await get(
        `SELECT ii.quantity, COALESCE(SUM(pl.delta), 0) AS ledger_sum
           FROM inventory_items ii
           LEFT JOIN portion_ledger pl ON pl.inventory_item_id = ii.id
          WHERE ii.id = $1
          GROUP BY ii.quantity`,
        [itemId]
      );

      // Exact equality, not a tolerance: whole portions are exact in float4,
      // which is the reason quantity was left REAL in migration 0103.
      expect(Number(row.quantity)).toBe(27);
      expect(Number(row.ledger_sum)).toBe(27);
    });
  });

  it('clamps the cache at zero while the ledger keeps the oversell visible', async () => {
    await asTenant(tenant.id, async () => {
      const itemId = await seedItem(tenant.id, 'Porción cochinita', 3);

      // Sold 5 when only 3 were on the line.
      await applyStockDelta(null, { itemId, delta: -5, reason: 'sale' });

      expect(await quantityOf(itemId)).toBe(0); // cache floors

      const row = await get(
        'SELECT COALESCE(SUM(delta), 0) AS s FROM portion_ledger WHERE inventory_item_id = $1',
        [itemId]
      );
      // 3 seeded quantity was never a ledger row, so the ledger alone reads -5:
      // the two disagree by exactly the 2 portions that were oversold.
      expect(Number(row.s)).toBe(-5);
    });
  });

  it('does not give back what the floor already ate', async () => {
    await asTenant(tenant.id, async () => {
      const itemId = await seedItem(tenant.id, 'Porción chorizo', 2);

      await applyStockDelta(null, { itemId, delta: -5, reason: 'sale' });
      expect(await quantityOf(itemId)).toBe(0);

      // Restoring climbs from the clamped 0, not from -3.
      await applyStockDelta(null, { itemId, delta: 5, reason: 'refund_restore' });
      expect(await quantityOf(itemId)).toBe(5);
    });
  });
});

describe('validation', () => {
  it('rejects an unknown reason', async () => {
    await asTenant(tenant.id, async () => {
      const itemId = await seedItem(tenant.id, 'Queso', 5, 'raw');
      await expect(
        applyStockDelta(null, { itemId, delta: 1, reason: 'shrinkage' })
      ).rejects.toThrow(/reason must be one of/i);
    });
  });

  it('rejects a zero or non-finite delta', async () => {
    await asTenant(tenant.id, async () => {
      const itemId = await seedItem(tenant.id, 'Crema', 5, 'raw');
      await expect(
        applyStockDelta(null, { itemId, delta: 0, reason: 'waste' })
      ).rejects.toThrow(/must not be zero/i);
      await expect(
        applyStockDelta(null, { itemId, delta: Number.NaN, reason: 'waste' })
      ).rejects.toThrow(/finite number/i);
    });
  });

  it('rejects a missing or invalid itemId before touching the database', async () => {
    await asTenant(tenant.id, async () => {
      await expect(
        applyStockDelta(null, { itemId: undefined as any, delta: 1, reason: 'waste' })
      ).rejects.toThrow(/positive integer/i);
    });
  });

  it('throws and moves nothing when the item does not exist', async () => {
    await asTenant(tenant.id, async () => {
      await expect(
        applyStockDelta(null, { itemId: 2147483000, delta: -1, reason: 'sale' })
      ).rejects.toThrow(/not found for this tenant/i);

      const rows = await all(
        'SELECT id FROM portion_ledger WHERE inventory_item_id = $1',
        [2147483000]
      );
      expect(rows).toHaveLength(0);
    });
  });
});

describe('tenant isolation', () => {
  it('refuses to move another tenant\'s stock on the adminSql path', async () => {
    const other = await createTestTenant('ledger-b');
    try {
      const foreignItemId = await seedItem(other.id, 'Porción ajena', 50);

      // The kiosk path: adminSql handle, tenant scoping supplied explicitly
      // because RLS is not there to do it.
      await expect(
        applyStockDeltas(
          adminSql,
          [{ itemId: foreignItemId, delta: -10, reason: 'sale' }],
          { tenantId: tenant.id }
        )
      ).rejects.toThrow(/not found for this tenant/i);

      const [row] = await adminSql`SELECT quantity FROM inventory_items WHERE id = ${foreignItemId}`;
      expect(Number(row.quantity)).toBe(50);
    } finally {
      await dropTestTenant(other.id);
    }
  });

  it('cannot see another tenant\'s ledger rows under RLS', async () => {
    const other = await createTestTenant('ledger-c');
    try {
      const foreignItemId = await seedItem(other.id, 'Porción ajena 2', 10);
      await asTenant(other.id, async () => {
        await applyStockDelta(null, { itemId: foreignItemId, delta: -3, reason: 'sale' });
      });

      await asTenant(tenant.id, async () => {
        const rows = await ledgerFor(foreignItemId);
        expect(rows).toHaveLength(0);
      });
    } finally {
      await dropTestTenant(other.id);
    }
  });
});

describe('append-only enforcement', () => {
  // The GRANT in migration 0103 is decorative — this database's default ACL
  // hands app_user arwd on every new table, so only a REVOKE withholds
  // anything. 0098 shipped a table that believed otherwise.
  //
  // UPDATE is the privilege that matters: a correction is a new compensating
  // row, never an edit to what a movement said. DELETE stays granted on purpose
  // — the admin inventory reset clears these rows inside the request
  // transaction, and app_user can already delete the inventory_items they point
  // at, so withholding it would break a real flow to buy nothing.
  let witnessItemId: number;

  beforeAll(async () => {
    witnessItemId = await seedItem(tenant.id, 'Porción testigo', 5);
    await asTenant(tenant.id, async () => {
      await applyStockDelta(null, { itemId: witnessItemId, delta: -1, reason: 'sale' });
    });
  });

  it('denies UPDATE to the request role', async () => {
    // Its own asTenant block: a permission error aborts the surrounding
    // transaction, so a later statement in the same one would report "current
    // transaction is aborted" and prove nothing about its own privilege.
    await expect(
      asTenant(tenant.id, () =>
        all('UPDATE portion_ledger SET delta = 999 WHERE inventory_item_id = $1 RETURNING id', [
          witnessItemId,
        ])
      )
    ).rejects.toThrow(/permission denied/i);
  });

  it('leaves the row saying what it said', async () => {
    await asTenant(tenant.id, async () => {
      const rows = await ledgerFor(witnessItemId);
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].delta)).toBe(-1);
    });
  });

  it('allows DELETE, which the inventory reset depends on', async () => {
    const scratchId = await seedItem(tenant.id, 'Porción borrable', 5);
    await asTenant(tenant.id, async () => {
      await applyStockDelta(null, { itemId: scratchId, delta: -1, reason: 'sale' });
    });
    await asTenant(tenant.id, async () => {
      await all('DELETE FROM portion_ledger WHERE inventory_item_id = $1', [scratchId]);
      expect(await ledgerFor(scratchId)).toHaveLength(0);
    });
  });
});

describe('LEDGER_REASONS', () => {
  it('matches the CHECK constraint in migration 0103', async () => {
    // A reason added in JS but not in the constraint (or vice versa) fails at
    // runtime in whichever direction was forgotten; this catches the drift.
    const rows = await adminSql`
      SELECT pg_get_constraintdef(oid) AS def
        FROM pg_constraint
       WHERE conrelid = 'portion_ledger'::regclass AND contype = 'c'
         AND pg_get_constraintdef(oid) LIKE '%reason%'
    `;
    expect(rows).toHaveLength(1);
    for (const reason of LEDGER_REASONS) {
      expect(rows[0].def).toContain(`'${reason}'`);
    }
  });
});
