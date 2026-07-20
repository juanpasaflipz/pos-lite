import { Router } from 'express';
import multer from 'multer';
import Papa from 'papaparse';
import { all, get, run, getTenantId, adminSql } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { requireOwner } from '../middleware/ownerAuth.js';
import { checkLimit, planUpgradeError } from '../planLimits.js';
import { audit } from '../lib/auditLog.js';
import { parseRecipeText } from '../helpers/recipeParse.js';
import { matchRecipeLines } from '../helpers/recipeMatch.js';
import { translateMenuItem } from '../helpers/menuTranslate.js';
// Template & AI parsing stubs (full AI removed in pos-lite)
const TEMPLATE_LIST = [];
const getTemplate = () => null;
const bulkInsertMenu = async () => ({ inserted: 0 });
const parseMenuText = async () => ({ categories: [] });

const router = Router();

// Fire-and-forget English translation writeback for a menu item. Runs after
// the response is sent so the write itself stays fast; the kiosk falls back
// to the Spanish original until this lands (typically 1-2 s later). Uses
// adminSql because the tenant request transaction is already closed by the
// time this resolves.
function scheduleMenuTranslation(itemId, tenantId, name, description) {
  const trimmed = { name: String(name || '').trim(), description: String(description || '').trim() };
  if (!trimmed.name && !trimmed.description) return;
  setImmediate(async () => {
    try {
      const { name_en, description_en } = await translateMenuItem(trimmed);
      await adminSql`
        UPDATE menu_items
        SET name_en = ${name_en || null}, description_en = ${description_en || null}
        WHERE id = ${itemId} AND tenant_id = ${tenantId}
      `;
    } catch (err) {
      console.warn('[menuTranslate] item', itemId, 'failed:', err.message);
    }
  });
}

// GET /api/menu/categories - list categories (all by default, ?active_only=1 for active only)
router.get('/categories', async (req, res) => {
  try {
    const activeOnly = req.query.active_only === '1';
    const categories = await all(`
      SELECT id, name, sort_order, active
      FROM menu_categories
      ${activeOnly ? 'WHERE active = true' : ''}
      ORDER BY sort_order ASC
    `);
    res.json(categories);
  } catch (error) {
    console.error('Error fetching categories:', error);
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

// POST /api/menu/categories - create category
router.post('/categories', requireAuth('manage_menu'), async (req, res) => {
  try {
    const { name, sort_order, printer_target } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Category name is required' });
    }

    const maxSort = await get('SELECT MAX(sort_order) as max_sort FROM menu_categories');
    const order = sort_order !== undefined ? sort_order : (maxSort?.max_sort || 0) + 1;

    const tid = getTenantId();
    const result = await run(`
      INSERT INTO menu_categories (tenant_id, name, sort_order, active)
      VALUES ($1, $2, $3, true)
    `, [tid, name.trim(), order]);

    audit({
      tenantId: req.tenant?.id || 'default',
      actorType: 'employee',
      actorId: req.headers['x-employee-id'] || 'unknown',
      action: 'create',
      resource: 'menu_category',
      resourceId: String(result.lastInsertRowid),
      ip: req.ip,
    });

    res.status(201).json({
      id: result.lastInsertRowid,
      name: name.trim(),
      sort_order: order,
      active: true,
    });
  } catch (error) {
    console.error('Error creating category:', error);
    res.status(500).json({ error: 'Failed to create category' });
  }
});

// PUT /api/menu/categories/:id - update category
router.put('/categories/:id', requireAuth('manage_menu'), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, sort_order } = req.body;

    const category = await get('SELECT id FROM menu_categories WHERE id = $1', [id]);
    if (!category) {
      return res.status(404).json({ error: 'Category not found' });
    }

    const updates = [];
    const values = [];

    if (name !== undefined) {
      if (!name.trim()) return res.status(400).json({ error: 'Category name cannot be empty' });
      updates.push(`name = $${values.length + 1}`);
      values.push(name.trim());
    }
    if (sort_order !== undefined) {
      updates.push(`sort_order = $${values.length + 1}`);
      values.push(sort_order);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    values.push(id);
    await run(`UPDATE menu_categories SET ${updates.join(', ')} WHERE id = $${values.length}`, values);

    audit({
      tenantId: req.tenant?.id || 'default',
      actorType: 'employee',
      actorId: req.headers['x-employee-id'] || 'unknown',
      action: 'update',
      resource: 'menu_category',
      resourceId: String(id),
      ip: req.ip,
    });

    res.json({ message: 'Category updated successfully' });
  } catch (error) {
    console.error('Error updating category:', error);
    res.status(500).json({ error: 'Failed to update category' });
  }
});

// PUT /api/menu/categories/:id/toggle - activate/deactivate category
router.put('/categories/:id/toggle', requireAuth('manage_menu'), async (req, res) => {
  try {
    const { id } = req.params;

    const category = await get('SELECT id, active FROM menu_categories WHERE id = $1', [id]);
    if (!category) {
      return res.status(404).json({ error: 'Category not found' });
    }

    const newActive = !category.active;
    await run('UPDATE menu_categories SET active = $1 WHERE id = $2', [newActive, id]);

    res.json({ id: parseInt(id), active: newActive });
  } catch (error) {
    console.error('Error toggling category:', error);
    res.status(500).json({ error: 'Failed to toggle category' });
  }
});

// DELETE /api/menu/categories/:id - permanently delete a category
// Blocks if any menu_items or combo_slots still reference it. Cleans up
// printer routes and delivery markup rules (pure config) inline.
router.delete('/categories/:id', requireAuth('manage_menu'), async (req, res) => {
  try {
    const { id } = req.params;

    const category = await get('SELECT id, name FROM menu_categories WHERE id = $1', [id]);
    if (!category) {
      return res.status(404).json({ error: 'Category not found' });
    }

    const itemRow = await get('SELECT COUNT(*)::int AS n FROM menu_items WHERE category_id = $1', [id]);
    if ((itemRow?.n || 0) > 0) {
      return res.status(409).json({
        error: 'category_has_items',
        message: `This category still has ${itemRow.n} item(s). Move or delete them first.`,
        item_count: itemRow.n,
      });
    }

    const comboRow = await get('SELECT COUNT(*)::int AS n FROM combo_slots WHERE category_id = $1', [id]);
    if ((comboRow?.n || 0) > 0) {
      return res.status(409).json({
        error: 'category_in_combo',
        message: `This category is used by ${comboRow.n} combo slot(s). Remove those first.`,
        combo_slot_count: comboRow.n,
      });
    }

    await run('DELETE FROM category_printer_routes WHERE category_id = $1', [id]);
    await run('DELETE FROM delivery_markup_rules WHERE category_id = $1', [id]);
    await run('DELETE FROM menu_categories WHERE id = $1', [id]);

    audit({
      tenantId: req.tenant?.id || 'default',
      actorType: 'employee',
      actorId: req.headers['x-employee-id'] || 'unknown',
      action: 'delete',
      resource: 'menu_category',
      resourceId: String(id),
      ip: req.ip,
    });

    res.json({ message: 'Category deleted', id: parseInt(id) });
  } catch (error) {
    console.error('Error deleting category:', error);
    res.status(500).json({ error: 'Failed to delete category' });
  }
});

// GET /api/menu/items/popular - top selling items by order quantity
router.get('/items/popular', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 8;
    const items = await all(`
      SELECT mi.id, mi.category_id, mi.name, mi.price, mi.description, mi.image_url, mi.active,
             SUM(oi.quantity) as total_sold
      FROM order_items oi
      JOIN menu_items mi ON oi.menu_item_id = mi.id
      WHERE mi.active = true
      GROUP BY mi.id, mi.category_id, mi.name, mi.price, mi.description, mi.image_url, mi.active
      ORDER BY total_sold DESC
      LIMIT $1
    `, [limit]);
    res.json(items);
  } catch (error) {
    console.error('Error fetching popular items:', error);
    res.status(500).json({ error: 'Failed to fetch popular items' });
  }
});

// GET /api/menu/categories/suggested-order - rank categories by order volume at given hour
router.get('/categories/suggested-order', async (req, res) => {
  try {
    const hour = parseInt(req.query.hour) ?? new Date().getHours();
    const rows = await all(`
      SELECT mi.category_id, COUNT(*) as order_count
      FROM order_items oi
      JOIN menu_items mi ON oi.menu_item_id = mi.id
      JOIN orders o ON oi.order_id = o.id
      WHERE EXTRACT(HOUR FROM o.created_at)::int = $1
      GROUP BY mi.category_id
      ORDER BY order_count DESC
    `, [hour]);
    res.json(rows.map(r => r.category_id));
  } catch (error) {
    console.error('Error fetching category suggested order:', error);
    res.status(500).json({ error: 'Failed to fetch category suggested order' });
  }
});

// GET /api/menu/items - list items (optional ?category_id, ?include_inactive=1)
router.get('/items', async (req, res) => {
  try {
    const { category_id, include_inactive } = req.query;
    const conditions = [];
    const params = [];

    if (!include_inactive) {
      conditions.push('active = true');
    }

    if (category_id) {
      params.push(category_id);
      conditions.push(`category_id = $${params.length}`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    let query = `
      SELECT id, category_id, name, name_en, price, description, description_en, image_url, sort_order, active, prep_time_minutes, is_example
      FROM menu_items
      ${whereClause}
    `;

    query += ' ORDER BY sort_order ASC NULLS LAST, id ASC';

    const items = await all(query, params);
    res.json(items);
  } catch (error) {
    console.error('Error fetching items:', error);
    res.status(500).json({ error: 'Failed to fetch items' });
  }
});

// GET /api/menu/items/:id - single item
router.get('/items/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const item = await get(`
      SELECT id, category_id, name, name_en, price, description, description_en, image_url, sort_order
      FROM menu_items
      WHERE id = $1 AND active = true
    `, [id]);

    if (!item) {
      return res.status(404).json({ error: 'Item not found' });
    }

    res.json(item);
  } catch (error) {
    console.error('Error fetching item:', error);
    res.status(500).json({ error: 'Failed to fetch item' });
  }
});

// POST /api/menu/items - create item (admin)
router.post('/items', requireAuth('manage_menu'), async (req, res) => {
  try {
    const { category_id, name, price, description, image_url, sort_order, prep_time_minutes, active, image_width, image_height } = req.body;

    if (!category_id || !name || price === undefined) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const isActive = active === undefined ? true : !!active;

    // Plan limit check — only count against limit if creating as active
    if (isActive) {
      const plan = req.tenant?.plan || 'free';
      const { cnt } = await get('SELECT COUNT(*) as cnt FROM menu_items WHERE active = true') || { cnt: 0 };
      const check = checkLimit(plan, 'menuItems', cnt);
      if (!check.allowed) {
        return res.status(403).json(planUpgradeError('menuItems', plan, { limit: check.limit, current: check.current }));
      }
    }

    const tid = getTenantId();
    const explicitSortOrder = Number.isFinite(Number(sort_order)) ? Number(sort_order) : null;
    const maxSort = explicitSortOrder === null
      ? await get('SELECT COALESCE(MAX(sort_order), -1) AS max_sort FROM menu_items WHERE category_id = $1', [category_id])
      : null;
    const resolvedSortOrder = explicitSortOrder ?? ((Number(maxSort?.max_sort) || 0) + 1);
    // Stamp uploader/time only when a photo is actually attached.
    const imageUploadedAt = image_url ? new Date().toISOString() : null;
    const imageUploadedBy = image_url ? (req.employee?.id ?? null) : null;
    const result = await run(`
      INSERT INTO menu_items (tenant_id, category_id, name, price, description, image_url, sort_order, active, prep_time_minutes, image_width, image_height, image_uploaded_at, image_uploaded_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    `, [tid, category_id, name, price, description || null, image_url || null, resolvedSortOrder, isActive, prep_time_minutes || 5,
        image_width == null ? null : Number(image_width), image_height == null ? null : Number(image_height), imageUploadedAt, imageUploadedBy]);

    audit({
      tenantId: req.tenant?.id || 'default',
      actorType: 'employee',
      actorId: req.headers['x-employee-id'] || 'unknown',
      action: 'create',
      resource: 'menu_item',
      resourceId: String(result.lastInsertRowid),
      ip: req.ip,
    });

    res.status(201).json({
      id: result.lastInsertRowid,
      category_id,
      name,
      price,
      description,
      image_url,
      sort_order: resolvedSortOrder,
    });

    scheduleMenuTranslation(result.lastInsertRowid, tid, name, description);
  } catch (error) {
    console.error('Error creating item:', error);
    res.status(500).json({ error: 'Failed to create item' });
  }
});

// PUT /api/menu/items/:id - update item (admin)
router.put('/items/:id', requireAuth('manage_menu'), async (req, res) => {
  try {
    const { id } = req.params;
    const { category_id, name, price, description, image_url, sort_order, prep_time_minutes, active, image_width, image_height } = req.body;

    // Check if item exists
    const item = await get('SELECT id FROM menu_items WHERE id = $1', [id]);
    if (!item) {
      return res.status(404).json({ error: 'Item not found' });
    }

    const updates = [];
    const values = [];

    if (category_id !== undefined) {
      updates.push(`category_id = $${values.length + 1}`);
      values.push(category_id);
    }
    if (name !== undefined) {
      updates.push(`name = $${values.length + 1}`);
      values.push(name);
    }
    if (price !== undefined) {
      updates.push(`price = $${values.length + 1}`);
      values.push(price);
    }
    if (description !== undefined) {
      updates.push(`description = $${values.length + 1}`);
      values.push(description);
    }
    if (image_url !== undefined) {
      updates.push(`image_url = $${values.length + 1}`);
      values.push(image_url);
      // Re-stamp the uploader/time when a photo is set or replaced; clear both
      // when the photo is removed (image_url set to null/empty).
      updates.push(`image_uploaded_at = $${values.length + 1}`);
      values.push(image_url ? new Date().toISOString() : null);
      updates.push(`image_uploaded_by = $${values.length + 1}`);
      values.push(image_url ? (req.employee?.id ?? null) : null);
    }
    if (image_width !== undefined) {
      updates.push(`image_width = $${values.length + 1}`);
      values.push(image_width === null ? null : Number(image_width));
    }
    if (image_height !== undefined) {
      updates.push(`image_height = $${values.length + 1}`);
      values.push(image_height === null ? null : Number(image_height));
    }
    if (sort_order !== undefined) {
      updates.push(`sort_order = $${values.length + 1}`);
      values.push(Number.isFinite(Number(sort_order)) ? Number(sort_order) : 0);
    }
    if (prep_time_minutes !== undefined) {
      updates.push(`prep_time_minutes = $${values.length + 1}`);
      values.push(prep_time_minutes);
    }
    if (active !== undefined) {
      updates.push(`active = $${values.length + 1}`);
      values.push(!!active);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    values.push(id);

    await run(`
      UPDATE menu_items
      SET ${updates.join(', ')}
      WHERE id = $${values.length}
    `, values);

    audit({
      tenantId: req.tenant?.id || 'default',
      actorType: 'employee',
      actorId: req.headers['x-employee-id'] || 'unknown',
      action: 'update',
      resource: 'menu_item',
      resourceId: String(id),
      ip: req.ip,
    });

    res.json({ message: 'Item updated successfully' });

    // Refresh the EN cache only when the text changed. Fetch the current row
    // rather than trusting the payload, since callers may pass only one of
    // name / description and we always translate the pair.
    if (name !== undefined || description !== undefined) {
      const current = await get(
        'SELECT tenant_id, name, description FROM menu_items WHERE id = $1',
        [id]
      );
      if (current) {
        scheduleMenuTranslation(id, current.tenant_id, current.name, current.description);
      }
    }
  } catch (error) {
    console.error('Error updating item:', error);
    res.status(500).json({ error: 'Failed to update item' });
  }
});

// DELETE /api/menu/items/:id - hard delete a menu item
// Refuses if the item has been ordered (order_items references must persist for history).
// In that case, callers should deactivate (set active=false) instead.
router.delete('/items/:id', requireAuth('manage_menu'), async (req, res) => {
  try {
    const { id } = req.params;

    const item = await get('SELECT id, name FROM menu_items WHERE id = $1', [id]);
    if (!item) {
      return res.status(404).json({ error: 'Item not found' });
    }

    const ordered = await get(
      'SELECT COUNT(*)::int AS n FROM order_items WHERE menu_item_id = $1',
      [id]
    );
    if (ordered && ordered.n > 0) {
      return res.status(409).json({
        error: 'Cannot delete item that has been ordered',
        code: 'item_has_orders',
        order_count: ordered.n,
        hint: 'Deactivate the item (set Pre-Menu) to hide it from the POS while preserving order history.',
      });
    }

    await run('DELETE FROM menu_item_ingredients WHERE menu_item_id = $1', [id]);
    await run('DELETE FROM menu_item_modifier_groups WHERE menu_item_id = $1', [id]);
    await run('DELETE FROM virtual_brand_items WHERE menu_item_id = $1', [id]);
    await run('DELETE FROM delivery_markup_rules WHERE menu_item_id = $1', [id]);
    await run('UPDATE combo_slots SET specific_item_id = NULL WHERE specific_item_id = $1', [id]);
    await run('DELETE FROM menu_items WHERE id = $1', [id]);

    audit({
      tenantId: req.tenant?.id || 'default',
      actorType: 'employee',
      actorId: req.headers['x-employee-id'] || 'unknown',
      action: 'delete',
      resource: 'menu_item',
      resourceId: String(id),
      ip: req.ip,
      details: { name: item.name },
    });

    res.json({ message: 'Item deleted successfully', id: Number(id) });
  } catch (error) {
    console.error('Error deleting item:', error);
    res.status(500).json({ error: 'Failed to delete item' });
  }
});

// PUT /api/menu/items/:id/toggle - toggle active status
router.put('/items/:id/toggle', requireAuth('manage_menu'), async (req, res) => {
  try {
    const { id } = req.params;

    const item = await get('SELECT id, active FROM menu_items WHERE id = $1', [id]);
    if (!item) {
      return res.status(404).json({ error: 'Item not found' });
    }

    const newActive = !item.active;
    await run('UPDATE menu_items SET active = $1 WHERE id = $2', [newActive, id]);

    res.json({ id, active: newActive });
  } catch (error) {
    console.error('Error toggling item:', error);
    res.status(500).json({ error: 'Failed to toggle item' });
  }
});

// ─── Recipe / Ingredient Mapping ─────────────────────────────

// GET /api/menu/items/:id/recipe - get ingredients for a menu item
router.get('/items/:id/recipe', async (req, res) => {
  try {
    const { id } = req.params;
    const ingredients = await all(`
      SELECT mii.inventory_item_id, mii.quantity_used,
             ii.name AS ingredient_name, ii.unit, ii.cost_price
      FROM menu_item_ingredients mii
      JOIN inventory_items ii ON mii.inventory_item_id = ii.id
      WHERE mii.menu_item_id = $1
      ORDER BY ii.name ASC
    `, [id]);
    res.json(ingredients);
  } catch (error) {
    console.error('Error fetching recipe:', error);
    res.status(500).json({ error: 'Failed to fetch recipe' });
  }
});

// PUT /api/menu/items/:id/recipe - replace entire recipe for a menu item
router.put('/items/:id/recipe', requireAuth('manage_menu'), async (req, res) => {
  try {
    const { id } = req.params;
    const { ingredients } = req.body; // [{ inventory_item_id, quantity_used }]

    if (!Array.isArray(ingredients)) {
      return res.status(400).json({ error: 'ingredients must be an array' });
    }

    const item = await get('SELECT id FROM menu_items WHERE id = $1', [id]);
    if (!item) {
      return res.status(404).json({ error: 'Menu item not found' });
    }

    // Delete existing recipe
    await run('DELETE FROM menu_item_ingredients WHERE menu_item_id = $1', [id]);

    // Insert new recipe
    const tid = getTenantId();
    for (const ing of ingredients) {
      if (!ing.inventory_item_id || !ing.quantity_used || ing.quantity_used <= 0) continue;
      await run(`
        INSERT INTO menu_item_ingredients (tenant_id, menu_item_id, inventory_item_id, quantity_used)
        VALUES ($1, $2, $3, $4)
      `, [tid, id, ing.inventory_item_id, ing.quantity_used]);
    }

    audit({
      tenantId: req.tenant?.id || 'default',
      actorType: 'employee',
      actorId: req.headers['x-employee-id'] || 'unknown',
      action: 'update',
      resource: 'menu_item_recipe',
      resourceId: String(id),
      ip: req.ip,
    });

    // Return the updated recipe
    const updated = await all(`
      SELECT mii.inventory_item_id, mii.quantity_used,
             ii.name AS ingredient_name, ii.unit, ii.cost_price
      FROM menu_item_ingredients mii
      JOIN inventory_items ii ON mii.inventory_item_id = ii.id
      WHERE mii.menu_item_id = $1
      ORDER BY ii.name ASC
    `, [id]);

    res.json(updated);
  } catch (error) {
    console.error('Error updating recipe:', error);
    res.status(500).json({ error: 'Failed to update recipe' });
  }
});

// ─── Recipe Import (paste-text → match → apply) ──────────────

// POST /api/menu/items/:id/recipe/parse — text → structured ingredient lines
router.post('/items/:id/recipe/parse', requireAuth('manage_menu'), async (req, res) => {
  try {
    const { text } = req.body || {};
    if (!text || !String(text).trim()) {
      return res.status(400).json({ error: 'text is required' });
    }
    const parsed = await parseRecipeText(text);
    res.json(parsed);
  } catch (error) {
    console.error('Error parsing recipe:', error);
    res.status(500).json({ error: error.message || 'Failed to parse recipe' });
  }
});

// POST /api/menu/items/:id/recipe/preview — match parsed lines against inventory
router.post('/items/:id/recipe/preview', requireAuth('manage_menu'), async (req, res) => {
  try {
    const { id } = req.params;
    const { lines } = req.body || {};
    if (!Array.isArray(lines)) {
      return res.status(400).json({ error: 'lines must be an array' });
    }

    const item = await get('SELECT id, name, price FROM menu_items WHERE id = $1', [id]);
    if (!item) return res.status(404).json({ error: 'Menu item not found' });

    const [inventory, aliases, current] = await Promise.all([
      all(`SELECT id, name, unit, cost_price, quantity FROM inventory_items ORDER BY name ASC`),
      all(`SELECT inventory_item_id, alias FROM inventory_aliases`),
      all(`
        SELECT mii.inventory_item_id, mii.quantity_used,
               ii.name AS ingredient_name, ii.unit, ii.cost_price
        FROM menu_item_ingredients mii
        JOIN inventory_items ii ON ii.id = mii.inventory_item_id
        WHERE mii.menu_item_id = $1
      `, [id]),
    ]);

    const matched = matchRecipeLines(lines, inventory, aliases);
    const proposed_total_cost = matched.reduce((s, l) => s + (l.match?.line_cost || 0), 0);
    const current_total_cost = current.reduce(
      (s, l) => s + Number(l.quantity_used) * Number(l.cost_price || 0), 0
    );

    res.json({
      menu_item: { id: item.id, name: item.name, price: Number(item.price) || 0 },
      current,
      matched,
      summary: {
        proposed_total_cost: Number(proposed_total_cost.toFixed(2)),
        current_total_cost: Number(current_total_cost.toFixed(2)),
        unmatched_count: matched.filter((m) => !m.match).length,
        unit_mismatch_count: matched.filter((m) => m.match?.unit_mismatch).length,
        zombie_warning_count: matched.filter((m) => m.zombie_warning).length,
      },
    });
  } catch (error) {
    console.error('Error previewing recipe:', error);
    res.status(500).json({ error: 'Failed to preview recipe' });
  }
});

// POST /api/menu/items/:id/recipe/apply — write confirmed lines transactionally
// Body: { ingredients: [{ inventory_item_id, quantity_used, alias? }] }
//   alias (optional): the raw text the owner typed for this line; if present
//   and not already an exact match, we persist it as an inventory_aliases row.
router.post('/items/:id/recipe/apply', requireAuth('manage_menu'), async (req, res) => {
  try {
    const { id } = req.params;
    const { ingredients } = req.body || {};
    if (!Array.isArray(ingredients)) {
      return res.status(400).json({ error: 'ingredients must be an array' });
    }

    const item = await get('SELECT id FROM menu_items WHERE id = $1', [id]);
    if (!item) return res.status(404).json({ error: 'Menu item not found' });

    const tid = getTenantId();

    await run('DELETE FROM menu_item_ingredients WHERE menu_item_id = $1', [id]);

    for (const ing of ingredients) {
      const invId = Number(ing.inventory_item_id);
      const qty = Number(ing.quantity_used);
      if (!invId || !(qty > 0)) continue;
      await run(`
        INSERT INTO menu_item_ingredients (tenant_id, menu_item_id, inventory_item_id, quantity_used)
        VALUES ($1, $2, $3, $4)
      `, [tid, id, invId, qty]);

      const alias = typeof ing.alias === 'string' ? ing.alias.trim() : '';
      if (alias) {
        await run(`
          INSERT INTO inventory_aliases (tenant_id, inventory_item_id, alias)
          VALUES ($1, $2, $3)
          ON CONFLICT (tenant_id, alias) DO NOTHING
        `, [tid, invId, alias]);
      }
    }

    audit({
      tenantId: req.tenant?.id || 'default',
      actorType: 'employee',
      actorId: req.headers['x-employee-id'] || 'unknown',
      action: 'import',
      resource: 'menu_item_recipe',
      resourceId: String(id),
      ip: req.ip,
    });

    const updated = await all(`
      SELECT mii.inventory_item_id, mii.quantity_used,
             ii.name AS ingredient_name, ii.unit, ii.cost_price
      FROM menu_item_ingredients mii
      JOIN inventory_items ii ON mii.inventory_item_id = ii.id
      WHERE mii.menu_item_id = $1
      ORDER BY ii.name ASC
    `, [id]);
    res.json(updated);
  } catch (error) {
    console.error('Error applying recipe:', error);
    res.status(500).json({ error: 'Failed to apply recipe' });
  }
});

// GET /api/menu/recipes/summary - all menu items with their recipe status
router.get('/recipes/summary', async (req, res) => {
  try {
    const items = await all(`
      SELECT mi.id, mi.name, mi.price, mi.category_id, mi.active,
             mc.name AS category_name,
             COUNT(mii.inventory_item_id) AS ingredient_count,
             COALESCE(SUM(mii.quantity_used * ii.cost_price), 0) AS cost_per_unit
      FROM menu_items mi
      JOIN menu_categories mc ON mi.category_id = mc.id
      LEFT JOIN menu_item_ingredients mii ON mii.menu_item_id = mi.id
      LEFT JOIN inventory_items ii ON mii.inventory_item_id = ii.id
      GROUP BY mi.id, mi.name, mi.price, mi.category_id, mi.active, mc.name, mc.sort_order
      ORDER BY mc.sort_order ASC, mi.sort_order ASC NULLS LAST, mi.id ASC
    `);

    // Coerce Postgres numeric strings
    for (const item of items) {
      item.ingredient_count = Number(item.ingredient_count) || 0;
      item.cost_per_unit = Number(item.cost_per_unit) || 0;
      item.price = Number(item.price) || 0;
    }

    res.json(items);
  } catch (error) {
    console.error('Error fetching recipe summary:', error);
    res.status(500).json({ error: 'Failed to fetch recipe summary' });
  }
});

// GET /api/menu/pos-brands - POS-visible brands with their item mappings
router.get('/pos-brands', async (req, res) => {
  try {
    const brands = await all(`
      SELECT id, name, slug, primary_color, secondary_color
      FROM virtual_brands
      WHERE active = true AND show_in_pos = true
      ORDER BY name ASC
    `);

    const result = [];
    for (const brand of brands) {
      const items = await all(`
        SELECT vbi.menu_item_id, vbi.custom_name, vbi.custom_price, mi.category_id
        FROM virtual_brand_items vbi
        JOIN menu_items mi ON vbi.menu_item_id = mi.id
        WHERE vbi.virtual_brand_id = $1 AND vbi.active = true AND mi.active = true
      `, [brand.id]);

      result.push({ ...brand, items });
    }

    res.json(result);
  } catch (error) {
    console.error('Error fetching POS brands:', error);
    res.status(500).json({ error: 'Failed to fetch POS brands' });
  }
});

// ─── Template & Import Endpoints ─────────────────────────────

// GET /api/menu/templates - list available templates (no auth required)
router.get('/templates', (_req, res) => {
  res.json(TEMPLATE_LIST);
});

/**
 * Dual auth middleware: accepts either owner JWT or employee JWT with manage_menu permission.
 * Needed for onboarding flow where owner has JWT but hasn't logged in as employee yet.
 */
function requireMenuAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  // Try owner auth first (non-destructive attempt)
  requireOwner(req, res, (ownerErr) => {
    if (!ownerErr && req.owner) {
      return next();
    }
    // Fall back to employee auth
    requireAuth('manage_menu')(req, res, next);
  });
}

// POST /api/menu/import-template - apply a restaurant template
router.post('/import-template', requireMenuAuth, async (req, res) => {
  try {
    const { template_id, mode = 'append' } = req.body;
    if (!template_id) {
      return res.status(400).json({ error: 'template_id is required' });
    }

    const template = getTemplate(template_id);
    if (!template) {
      return res.status(404).json({ error: `Template "${template_id}" not found` });
    }

    if (mode !== 'append' && mode !== 'replace') {
      return res.status(400).json({ error: 'mode must be "append" or "replace"' });
    }

    const plan = req.tenant?.plan || 'free';
    const stats = await bulkInsertMenu(template, { plan, mode });

    audit({
      tenantId: req.tenant?.id || req.owner?.tenantId || 'default',
      actorType: req.owner ? 'owner' : 'employee',
      actorId: req.owner?.email || req.headers['x-employee-id'] || 'unknown',
      action: 'import_template',
      resource: 'menu',
      resourceId: template_id,
      details: stats,
      ip: req.ip,
    });

    res.json(stats);
  } catch (error) {
    console.error('Error applying template:', error);
    res.status(500).json({ error: 'Failed to apply template' });
  }
});

// POST /api/menu/ai-parse - parse unstructured text into menu structure via AI
router.post('/ai-parse', requireMenuAuth, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ success: false, error: 'Text is required' });
    }
    if (text.length > 10000) {
      return res.status(400).json({ success: false, error: 'Text must be under 10,000 characters' });
    }

    const result = await parseMenuText(text.trim());
    res.json(result);
  } catch (error) {
    console.error('Error parsing menu with AI:', error);
    res.status(500).json({ success: false, error: 'Failed to parse menu' });
  }
});

// POST /api/menu/ai-import - commit AI-parsed menu payload via bulkInsertMenu
router.post('/ai-import', requireMenuAuth, async (req, res) => {
  try {
    const { payload, mode = 'replace' } = req.body;
    if (!payload || (!payload.categories?.length && !payload.items?.length)) {
      return res.status(400).json({ error: 'No menu data to import' });
    }
    if (mode !== 'append' && mode !== 'replace') {
      return res.status(400).json({ error: 'mode must be "append" or "replace"' });
    }

    const plan = req.tenant?.plan || 'free';
    const stats = await bulkInsertMenu(payload, { plan, mode });

    audit({
      tenantId: req.tenant?.id || req.owner?.tenantId || 'default',
      actorType: req.owner ? 'owner' : 'employee',
      actorId: req.owner?.email || req.headers['x-employee-id'] || 'unknown',
      action: 'import_ai_menu',
      resource: 'menu',
      resourceId: 'ai-builder',
      details: stats,
      ip: req.ip,
    });

    res.json(stats);
  } catch (error) {
    console.error('Error importing AI menu:', error);
    res.status(500).json({ error: `Failed to import menu: ${error.message || error}` });
  }
});

// CSV upload config: memory storage, 5MB limit
const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['.csv', '.tsv', '.txt'];
    const ext = (file.originalname || '').toLowerCase().match(/\.[^.]+$/)?.[0];
    if (ext && allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only .csv, .tsv, or .txt files are allowed'));
    }
  },
});

// Column alias map for auto-detection (EN, ES, POS exports)
const COLUMN_ALIASES = {
  name: ['name', 'nombre', 'item name', 'item', 'product', 'producto', 'dish', 'platillo'],
  price: ['price', 'precio', 'cost', 'costo', 'unit price', 'precio unitario'],
  category: ['category', 'categoría', 'categoria', 'section', 'sección', 'seccion', 'group', 'grupo'],
  description: ['description', 'descripción', 'descripcion', 'notes', 'notas', 'details', 'detalles'],
  ingredients: ['ingredients', 'ingredientes', 'recipe', 'receta'],
  prep_time: ['prep time', 'prep_time', 'tiempo', 'tiempo de preparación', 'prep_time_minutes'],
};

function normalizeHeader(h) {
  return (h || '').toLowerCase().trim().replace(/[_\-]/g, ' ').replace(/\s+/g, ' ');
}

function detectColumns(headers) {
  const mapping = {};
  for (const header of headers) {
    const normalized = normalizeHeader(header);
    for (const [canonical, aliases] of Object.entries(COLUMN_ALIASES)) {
      if (aliases.includes(normalized) && !mapping[canonical]) {
        mapping[canonical] = header;
        break;
      }
    }
  }
  return mapping;
}

function parsePrice(val) {
  if (val == null || val === '') return null;
  const cleaned = String(val).replace(/[$,\s]/g, '').trim();
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : Math.round(num * 100) / 100;
}

// POST /api/menu/import - CSV import (preview or commit)
router.post('/import', requireAuth('manage_menu'), csvUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const mode = req.query.mode || 'preview';
    const csvText = req.file.buffer.toString('utf-8');
    const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: true, dynamicTyping: false });

    if (parsed.errors.length > 0 && parsed.data.length === 0) {
      return res.status(400).json({ error: 'Failed to parse CSV', details: parsed.errors.slice(0, 5) });
    }

    const headers = parsed.meta.fields || [];
    const columnMap = req.body?.column_map ? JSON.parse(req.body.column_map) : detectColumns(headers);

    if (!columnMap.name) {
      return res.status(400).json({
        error: 'Could not detect a "name" column. Please provide a column mapping.',
        detected_columns: headers,
      });
    }

    const validRows = [];
    const invalidRows = [];
    const categorySet = new Set();

    for (let i = 0; i < parsed.data.length; i++) {
      const row = parsed.data[i];
      const name = (row[columnMap.name] || '').trim();
      const price = parsePrice(row[columnMap.price]);
      const category = columnMap.category ? (row[columnMap.category] || '').trim() : '';
      const description = columnMap.description ? (row[columnMap.description] || '').trim() : '';
      const ingredients = columnMap.ingredients ? (row[columnMap.ingredients] || '').trim() : '';
      const prepTime = columnMap.prep_time ? parseInt(row[columnMap.prep_time]) || 5 : 5;

      if (!name) {
        if (Object.values(row).some(v => (v || '').trim())) {
          invalidRows.push({ row: i + 1, data: row, reason: 'Missing name' });
        }
        continue;
      }

      if (price === null && columnMap.price) {
        invalidRows.push({ row: i + 1, data: row, reason: 'Invalid price' });
        continue;
      }

      const validRow = {
        name,
        price: price || 0,
        category: category || 'General',
        description,
        ingredients,
        prep_time_minutes: prepTime,
      };

      validRows.push(validRow);
      categorySet.add(validRow.category);
    }

    // ─── Preview mode ───
    if (mode === 'preview') {
      return res.json({
        detected_columns: headers,
        column_mapping: columnMap,
        detected_categories: Array.from(categorySet),
        valid_rows: validRows.slice(0, 50),
        invalid_rows: invalidRows.slice(0, 20),
        total: parsed.data.length,
        valid_count: validRows.length,
        invalid_count: invalidRows.length,
      });
    }

    // ─── Commit mode ───
    const categories = Array.from(categorySet).map((name, i) => ({
      name,
      sort_order: i + 1,
    }));

    const items = validRows.map(r => ({
      name: r.name,
      category: r.category,
      price: r.price,
      description: r.description,
      prep_time_minutes: r.prep_time_minutes,
    }));

    // Build inventory from ingredient columns if present
    const inventory = [];
    const recipes = [];
    if (columnMap.ingredients) {
      const ingredientSet = new Set();
      for (const row of validRows) {
        if (!row.ingredients) continue;
        const ings = row.ingredients.split(/[,;]/).map(s => s.trim()).filter(Boolean);
        for (const ing of ings) {
          if (!ingredientSet.has(ing.toLowerCase())) {
            ingredientSet.add(ing.toLowerCase());
            inventory.push({ name: ing, unit: 'unit', quantity: 0, low_stock_threshold: 5, category: 'Imported', cost_price: 0 });
          }
          recipes.push({ item_name: row.name, ingredient_name: ing, quantity_used: 1 });
        }
      }
    }

    const plan = req.tenant?.plan || 'free';
    const importMode = req.body?.import_mode || 'append';
    const stats = await bulkInsertMenu(
      { categories, items, inventory, recipes },
      { plan, mode: importMode }
    );

    audit({
      tenantId: req.tenant?.id || 'default',
      actorType: 'employee',
      actorId: req.headers['x-employee-id'] || 'unknown',
      action: 'import_csv',
      resource: 'menu',
      resourceId: req.file.originalname,
      details: stats,
      ip: req.ip,
    });

    res.json(stats);
  } catch (error) {
    if (error.message?.includes('Only .csv')) {
      return res.status(400).json({ error: error.message });
    }
    console.error('Error importing CSV:', error);
    res.status(500).json({ error: 'Failed to import CSV' });
  }
});

export default router;
