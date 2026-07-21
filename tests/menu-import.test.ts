// Menu templates + bulk insert (onboarding wizard backend).
//
// These were dead stubs until 2026-07-20 ("Could not parse menu" /
// empty template list in the paid wizard). Covers the template catalog
// shape and bulkInsertMenu under a real tenant RLS context. The AI parse
// path (Claude call) is not exercised here — it needs a network key; its
// normalization logic is shared with templates via bulkInsertMenu.

import { afterAll, describe, expect, it } from 'vitest';
import { createTestTenant, dropTestTenant, asTenant, closePools } from './helpers/db.js';
// @ts-ignore — server files are plain JS
import { TEMPLATE_LIST, getTemplate } from '../server/helpers/menuTemplates.js';
// @ts-ignore
import { bulkInsertMenu } from '../server/helpers/menuBulkInsert.js';
// @ts-ignore
import { all } from '../server/db/index.js';

const createdTenants: string[] = [];

afterAll(async () => {
  for (const id of createdTenants) await dropTestTenant(id);
  await closePools();
});

describe('menu templates catalog', () => {
  it('exposes a non-empty catalog whose payloads are internally consistent', () => {
    expect(TEMPLATE_LIST.length).toBeGreaterThanOrEqual(6);
    for (const meta of TEMPLATE_LIST) {
      const t = getTemplate(meta.id);
      expect(t).toBeTruthy();
      expect(meta.item_count).toBe(t!.items.length);
      expect(meta.category_count).toBe(t!.categories.length);
      const catNames = new Set(t!.categories.map((c: any) => c.name));
      for (const item of t!.items) {
        expect(catNames.has(item.category)).toBe(true);
        expect(item.price).toBeGreaterThan(0);
      }
    }
  });

  it('returns null for unknown template ids', () => {
    expect(getTemplate('no-existe')).toBeNull();
  });
});

describe('bulkInsertMenu', () => {
  it('inserts a template menu under tenant RLS and soft-replaces on replace mode', async () => {
    const tenant = await createTestTenant('menuimport');
    createdTenants.push(tenant.id);

    const template = getTemplate('taqueria')!;

    const stats = await asTenant(tenant.id, () =>
      bulkInsertMenu(template, { plan: 'pro', mode: 'replace' }),
    );

    expect(stats.categoriesCreated).toBe(template.categories.length);
    expect(stats.itemsCreated).toBe(template.items.length);
    expect(stats.skipped).toEqual([]);

    const active = await asTenant(tenant.id, () =>
      all('SELECT name, active FROM menu_items WHERE active = true'),
    );
    expect(active.length).toBe(template.items.length);

    // Second apply in replace mode: previous items deactivated, not deleted
    const stats2 = await asTenant(tenant.id, () =>
      bulkInsertMenu(getTemplate('cafeteria')!, { plan: 'pro', mode: 'replace' }),
    );
    expect(stats2.itemsCreated).toBeGreaterThan(0);

    const rows = await asTenant(tenant.id, () =>
      all('SELECT COUNT(*) FILTER (WHERE active) AS act, COUNT(*) AS total FROM menu_items'),
    );
    expect(Number(rows[0].act)).toBe(getTemplate('cafeteria')!.items.length);
    expect(Number(rows[0].total)).toBe(template.items.length + getTemplate('cafeteria')!.items.length);
  }, 40_000);

  it('routes items with unknown categories to a fallback instead of dropping them', async () => {
    const tenant = await createTestTenant('menufallback');
    createdTenants.push(tenant.id);

    const stats = await asTenant(tenant.id, () =>
      bulkInsertMenu(
        {
          categories: [{ name: 'Tacos', sort_order: 1 }],
          items: [
            { name: 'Taco de Pastor', category: 'Tacos', price: 22 },
            { name: 'Huérfano', category: 'Categoría Fantasma', price: 30 },
          ],
        },
        { plan: 'pro', mode: 'append' },
      ),
    );

    expect(stats.itemsCreated).toBe(2);
    expect(stats.categoriesCreated).toBe(2); // Tacos + fallback "Menú"
  }, 30_000);
});
