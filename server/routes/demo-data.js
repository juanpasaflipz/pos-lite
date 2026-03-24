import { Router } from 'express';
import { adminSql } from '../db/index.js';
import { generateDemoData } from '../lib/demoDataGenerator.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
const DEMO_SOURCE = 'demo_generator';

// Helper: check if request came via admin secret (super-admin context)
function isAdminRequest(req) {
  return req.headers['x-admin-secret'] === process.env.ADMIN_SECRET && process.env.ADMIN_SECRET;
}

// All endpoints require authenticated employee (unless admin-secret provided)
router.use((req, res, next) => {
  if (isAdminRequest(req)) return next();
  requireAuth()(req, res, next);
});

// GET /api/demo-data/status — check demo data counts for current tenant
router.get('/status', async (req, res) => {
  try {
    const tenantId = req.tenant?.id;
    if (!tenantId) return res.status(400).json({ error: 'No tenant context' });

    // Safety: only allow on free tenants (admin-secret bypasses)
    if (!isAdminRequest(req)) {
      const [tenant] = await adminSql`SELECT plan FROM tenants WHERE id = ${tenantId}`;
      if (!tenant || tenant.plan !== 'free') {
        return res.json({ allowed: false, reason: 'Demo data is only available for free accounts' });
      }
    }

    const [[orderCount], [customerCount], [deliveryCount], [snapshotCount], [financialCount]] = await Promise.all([
      adminSql`SELECT COUNT(*)::int AS c FROM orders WHERE tenant_id = ${tenantId} AND source = ${DEMO_SOURCE}`,
      adminSql`SELECT COUNT(*)::int AS c FROM loyalty_customers WHERE tenant_id = ${tenantId} AND demo_batch_id IS NOT NULL`,
      adminSql`SELECT COUNT(*)::int AS c FROM delivery_orders WHERE tenant_id = ${tenantId} AND order_id IN (SELECT id FROM orders WHERE tenant_id = ${tenantId} AND source = ${DEMO_SOURCE})`,
      adminSql`SELECT COUNT(*)::int AS c FROM ai_hourly_snapshots WHERE tenant_id = ${tenantId} AND demo_batch_id IS NOT NULL`,
      adminSql`SELECT COUNT(*)::int AS c FROM financial_actuals WHERE tenant_id = ${tenantId} AND demo_batch_id IS NOT NULL`,
    ]);

    res.json({
      allowed: true,
      hasDemo: orderCount.c > 0 || customerCount.c > 0,
      counts: {
        orders: orderCount.c,
        customers: customerCount.c,
        delivery_orders: deliveryCount.c,
        ai_snapshots: snapshotCount.c,
        financial_actuals: financialCount.c,
      },
    });
  } catch (error) {
    console.error('[DemoData] Status error:', error);
    res.status(500).json({ error: 'Failed to fetch demo data status' });
  }
});

// POST /api/demo-data/generate — generate demo data for current tenant
router.post('/generate', async (req, res) => {
  try {
    const tenantId = req.tenant?.id;
    if (!tenantId) return res.status(400).json({ error: 'No tenant context' });

    // Safety: only allow on free tenants (admin-secret bypasses)
    if (!isAdminRequest(req)) {
      const [tenant] = await adminSql`SELECT plan FROM tenants WHERE id = ${tenantId}`;
      if (!tenant || tenant.plan !== 'free') {
        return res.status(403).json({ error: 'Demo data is only available for free accounts' });
      }
    }

    // Check for existing demo data
    const [existing] = await adminSql`
      SELECT COUNT(*)::int AS c FROM orders
      WHERE tenant_id = ${tenantId} AND source = ${DEMO_SOURCE}
    `;
    if (existing.c > 0) {
      return res.status(409).json({ error: 'Demo data already exists. Clear it first.' });
    }

    const [run] = await adminSql`
      INSERT INTO stress_test_runs (tenant_id, config)
      VALUES (${tenantId}, ${JSON.stringify({ volume: 'medium', date_range_days: 30, source: 'pos_admin' })})
      RETURNING id
    `;

    const summary = await generateDemoData(adminSql, {
      tenantId,
      batchId: run.id,
      volume: 'medium',
      dateRangeDays: 30,
      includeDelivery: true,
      includeLoyalty: true,
      includeAi: true,
      includeFinancials: true,
    });

    await adminSql`UPDATE stress_test_runs SET summary = ${JSON.stringify(summary)} WHERE id = ${run.id}`;

    res.json({ run_id: run.id, summary });
  } catch (error) {
    console.error('[DemoData] Generate error:', error);
    res.status(500).json({ error: error.message || 'Failed to generate demo data' });
  }
});

// DELETE /api/demo-data — clear all demo data for current tenant
router.delete('/', async (req, res) => {
  try {
    const tenantId = req.tenant?.id;
    if (!tenantId) return res.status(400).json({ error: 'No tenant context' });

    const deleted = {};

    // Ensure demo_batch_id columns exist (they're added by generateDemoData,
    // but may not exist if clearing old data created before the column was introduced)
    await Promise.all([
      adminSql`ALTER TABLE inventory_counts ADD COLUMN IF NOT EXISTS demo_batch_id UUID`,
      adminSql`ALTER TABLE shrinkage_alerts ADD COLUMN IF NOT EXISTS demo_batch_id UUID`,
      adminSql`ALTER TABLE delivery_markup_rules ADD COLUMN IF NOT EXISTS demo_batch_id UUID`,
      adminSql`ALTER TABLE vendors ADD COLUMN IF NOT EXISTS demo_batch_id UUID`,
      adminSql`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS demo_batch_id UUID`,
      adminSql`ALTER TABLE menu_item_ingredients ADD COLUMN IF NOT EXISTS demo_batch_id UUID`,
      adminSql`ALTER TABLE pricing_guardrails ADD COLUMN IF NOT EXISTS demo_batch_id UUID`,
      adminSql`ALTER TABLE pricing_rules ADD COLUMN IF NOT EXISTS demo_batch_id UUID`,
      adminSql`ALTER TABLE pricing_experiments ADD COLUMN IF NOT EXISTS demo_batch_id UUID`,
      adminSql`ALTER TABLE price_history ADD COLUMN IF NOT EXISTS demo_batch_id UUID`,
      adminSql`ALTER TABLE virtual_brands ADD COLUMN IF NOT EXISTS demo_batch_id UUID`,
      adminSql`ALTER TABLE virtual_brand_items ADD COLUMN IF NOT EXISTS demo_batch_id UUID`,
      adminSql`ALTER TABLE delivery_recapture ADD COLUMN IF NOT EXISTS demo_batch_id UUID`,
      adminSql`ALTER TABLE tenant_credentials ADD COLUMN IF NOT EXISTS demo_batch_id UUID`,
      adminSql`ALTER TABLE ai_suggestion_events ADD COLUMN IF NOT EXISTS demo_batch_id UUID`,
    ]);

    await adminSql.begin(async (sql) => {
      // ─── Recipes (demo-seeded ingredients) ──────────────────
      const r_mii = await sql.unsafe(`DELETE FROM menu_item_ingredients WHERE tenant_id = $1 AND demo_batch_id IS NOT NULL`, [tenantId]);
      deleted.menu_item_ingredients = r_mii.count;

      // ─── Order-related child tables ─────────────────────────
      const r1 = await sql.unsafe(`
        DELETE FROM order_item_modifiers WHERE tenant_id = $1
          AND order_item_id IN (
            SELECT oi.id FROM order_items oi
            JOIN orders o ON o.id = oi.order_id
            WHERE o.tenant_id = $1 AND o.source = $2
          )
      `, [tenantId, DEMO_SOURCE]);
      deleted.order_item_modifiers = r1.count;

      // Refunds (track via demo orders)
      const r_ref = await sql.unsafe(`
        DELETE FROM refunds WHERE tenant_id = $1
          AND order_id IN (SELECT id FROM orders WHERE tenant_id = $1 AND source = $2)
      `, [tenantId, DEMO_SOURCE]);
      deleted.refunds = r_ref.count;

      const r2 = await sql.unsafe(`DELETE FROM stamp_events WHERE tenant_id = $1 AND demo_batch_id IS NOT NULL`, [tenantId]);
      deleted.stamp_events = r2.count;

      const r3 = await sql.unsafe(`DELETE FROM referral_events WHERE tenant_id = $1 AND demo_batch_id IS NOT NULL`, [tenantId]);
      deleted.referral_events = r3.count;

      const r4 = await sql.unsafe(`DELETE FROM order_items WHERE tenant_id = $1 AND order_id IN (SELECT id FROM orders WHERE tenant_id = $1 AND source = $2)`, [tenantId, DEMO_SOURCE]);
      deleted.order_items = r4.count;

      const r5 = await sql.unsafe(`DELETE FROM order_payments WHERE tenant_id = $1 AND order_id IN (SELECT id FROM orders WHERE tenant_id = $1 AND source = $2)`, [tenantId, DEMO_SOURCE]);
      deleted.order_payments = r5.count;

      // Delivery recapture (FK → delivery_orders) — must delete before delivery_orders
      const r_drc = await sql.unsafe(`DELETE FROM delivery_recapture WHERE tenant_id = $1 AND demo_batch_id IS NOT NULL`, [tenantId]);
      deleted.delivery_recapture = r_drc.count;

      const r6 = await sql.unsafe(`DELETE FROM delivery_orders WHERE tenant_id = $1 AND order_id IN (SELECT id FROM orders WHERE tenant_id = $1 AND source = $2)`, [tenantId, DEMO_SOURCE]);
      deleted.delivery_orders = r6.count;

      const r7 = await sql.unsafe(`DELETE FROM stamp_cards WHERE tenant_id = $1 AND customer_id IN (SELECT id FROM loyalty_customers WHERE tenant_id = $1 AND demo_batch_id IS NOT NULL)`, [tenantId]);
      deleted.stamp_cards = r7.count;

      // ─── AI tables ──────────────────────────────────────────
      // Clear all suggestion cache (includes both demo_batch_id tagged AND AI-pipeline generated)
      const r8 = await sql.unsafe(`DELETE FROM ai_suggestion_cache WHERE tenant_id = $1`, [tenantId]);
      deleted.ai_suggestion_cache = r8.count;

      const r9 = await sql.unsafe(`DELETE FROM ai_item_pairs WHERE tenant_id = $1 AND demo_batch_id IS NOT NULL`, [tenantId]);
      deleted.ai_item_pairs = r9.count;

      const r10 = await sql.unsafe(`DELETE FROM ai_inventory_velocity WHERE tenant_id = $1 AND demo_batch_id IS NOT NULL`, [tenantId]);
      deleted.ai_inventory_velocity = r10.count;

      const r11 = await sql.unsafe(`DELETE FROM ai_hourly_snapshots WHERE tenant_id = $1 AND demo_batch_id IS NOT NULL`, [tenantId]);
      deleted.ai_hourly_snapshots = r11.count;

      // AI category roles (clear all — recreated on next populate)
      const r_acr = await sql.unsafe(`DELETE FROM ai_category_roles WHERE tenant_id = $1`, [tenantId]);
      deleted.ai_category_roles = r_acr.count;

      // ─── Financial tables ───────────────────────────────────
      const r12 = await sql.unsafe(`DELETE FROM financial_actuals WHERE tenant_id = $1 AND demo_batch_id IS NOT NULL`, [tenantId]);
      deleted.financial_actuals = r12.count;

      // Financial targets (clear all — recreated on next populate)
      const r_ft = await sql.unsafe(`DELETE FROM financial_targets WHERE tenant_id = $1`, [tenantId]);
      deleted.financial_targets = r_ft.count;

      // ─── Inventory tables ───────────────────────────────────
      const r_wl = await sql.unsafe(`DELETE FROM waste_log WHERE tenant_id = $1 AND demo_batch_id IS NOT NULL`, [tenantId]);
      deleted.waste_log = r_wl.count;

      const r_ic = await sql.unsafe(`DELETE FROM inventory_counts WHERE tenant_id = $1 AND demo_batch_id IS NOT NULL`, [tenantId]);
      deleted.inventory_counts = r_ic.count;

      // Shrinkage alerts — clear all (includes both demo and AI-pipeline generated)
      const r_sa = await sql.unsafe(`DELETE FROM shrinkage_alerts WHERE tenant_id = $1`, [tenantId]);
      deleted.shrinkage_alerts = r_sa.count;

      // ─── Delivery markup rules ──────────────────────────────
      const r_dmr = await sql.unsafe(`DELETE FROM delivery_markup_rules WHERE tenant_id = $1 AND demo_batch_id IS NOT NULL`, [tenantId]);
      deleted.delivery_markup_rules = r_dmr.count;

      // ─── Dynamic Pricing (FK order: price_history first) ───
      const r_ph = await sql.unsafe(`DELETE FROM price_history WHERE tenant_id = $1 AND demo_batch_id IS NOT NULL`, [tenantId]);
      deleted.price_history = r_ph.count;

      const r_pe = await sql.unsafe(`DELETE FROM pricing_experiments WHERE tenant_id = $1 AND demo_batch_id IS NOT NULL`, [tenantId]);
      deleted.pricing_experiments = r_pe.count;

      const r_pr = await sql.unsafe(`DELETE FROM pricing_rules WHERE tenant_id = $1 AND demo_batch_id IS NOT NULL`, [tenantId]);
      deleted.pricing_rules = r_pr.count;

      const r_pg = await sql.unsafe(`DELETE FROM pricing_guardrails WHERE tenant_id = $1 AND demo_batch_id IS NOT NULL`, [tenantId]);
      deleted.pricing_guardrails = r_pg.count;

      // ─── Virtual Brands (FK order: items first) ────────────
      const r_vbi = await sql.unsafe(`DELETE FROM virtual_brand_items WHERE tenant_id = $1 AND demo_batch_id IS NOT NULL`, [tenantId]);
      deleted.virtual_brand_items = r_vbi.count;

      const r_vb = await sql.unsafe(`DELETE FROM virtual_brands WHERE tenant_id = $1 AND demo_batch_id IS NOT NULL`, [tenantId]);
      deleted.virtual_brands = r_vb.count;

      // ─── AI Suggestion Events ─────────────────────────────
      const r_ase = await sql.unsafe(`DELETE FROM ai_suggestion_events WHERE tenant_id = $1 AND demo_batch_id IS NOT NULL`, [tenantId]);
      deleted.ai_suggestion_events = r_ase.count;

      // ─── Integration Credentials ──────────────────────────
      const r_tc = await sql.unsafe(`DELETE FROM tenant_credentials WHERE tenant_id = $1 AND demo_batch_id IS NOT NULL`, [tenantId]);
      deleted.tenant_credentials = r_tc.count;

      // ─── Vendors & Purchase Orders (FK order matters) ───────
      const r_poi = await sql.unsafe(`
        DELETE FROM purchase_order_items WHERE tenant_id = $1
          AND po_id IN (SELECT id FROM purchase_orders WHERE tenant_id = $1 AND demo_batch_id IS NOT NULL)
      `, [tenantId]);
      deleted.purchase_order_items = r_poi.count;

      const r_po = await sql.unsafe(`DELETE FROM purchase_orders WHERE tenant_id = $1 AND demo_batch_id IS NOT NULL`, [tenantId]);
      deleted.purchase_orders = r_po.count;

      const r_vi = await sql.unsafe(`
        DELETE FROM vendor_items WHERE tenant_id = $1
          AND vendor_id IN (SELECT id FROM vendors WHERE tenant_id = $1 AND demo_batch_id IS NOT NULL)
      `, [tenantId]);
      deleted.vendor_items = r_vi.count;

      const r_v = await sql.unsafe(`DELETE FROM vendors WHERE tenant_id = $1 AND demo_batch_id IS NOT NULL`, [tenantId]);
      deleted.vendors = r_v.count;

      // ─── Loyalty & Core ─────────────────────────────────────
      const r13 = await sql.unsafe(`DELETE FROM loyalty_customers WHERE tenant_id = $1 AND demo_batch_id IS NOT NULL`, [tenantId]);
      deleted.loyalty_customers = r13.count;

      const r14 = await sql.unsafe(`DELETE FROM orders WHERE tenant_id = $1 AND source = $2`, [tenantId, DEMO_SOURCE]);
      deleted.orders = r14.count;

      const r15 = await sql.unsafe(`DELETE FROM stress_test_runs WHERE tenant_id = $1`, [tenantId]);
      deleted.stress_test_runs = r15.count;
    });

    res.json({ deleted });
  } catch (error) {
    console.error('[DemoData] Delete error:', error);
    res.status(500).json({ error: 'Failed to clear demo data' });
  }
});

export default router;
