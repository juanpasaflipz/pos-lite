import { Router } from 'express';
import { all } from '../db/index.js';
import { getDisplayMenuSettings, isCalloutActive } from '../lib/displayMenu.js';

const router = Router();

router.get('/data', async (req, res) => {
  try {
    const branding = req.tenant?.branding || {};
    const displayMenu = getDisplayMenuSettings(branding);
    const tv = displayMenu.tv;

    const categoryIds = tv.menuCategoryIds;
    const categoryConditions = ['active = true'];
    const itemConditions = ['active = true'];
    const categoryParams = [];
    const itemParams = [];

    if (categoryIds.length > 0) {
      const categoryPlaceholders = categoryIds.map((_, index) => `$${index + 1}`).join(', ');
      categoryConditions.push(`id IN (${categoryPlaceholders})`);
      itemConditions.push(`category_id IN (${categoryPlaceholders})`);
      categoryParams.push(...categoryIds);
      itemParams.push(...categoryIds);
    }

    const categories = await all(`
      SELECT id, name, sort_order
      FROM menu_categories
      WHERE ${categoryConditions.join(' AND ')}
      ORDER BY sort_order ASC NULLS LAST, id ASC
    `, categoryParams);

    const items = await all(`
      SELECT id, category_id, name, price, description, sort_order
      FROM menu_items
      WHERE ${itemConditions.join(' AND ')}
      ORDER BY category_id ASC, sort_order ASC NULLS LAST, id ASC
    `, itemParams);

    const categoryMap = new Map();
    for (const category of categories) {
      categoryMap.set(category.id, {
        id: category.id,
        name: category.name,
        sort_order: category.sort_order,
        items: [],
      });
    }

    for (const item of items) {
      const category = categoryMap.get(item.category_id);
      if (!category) continue;
      category.items.push({
        id: item.id,
        name: item.name,
        price: Number(item.price) || 0,
        description: item.description || undefined,
        sort_order: item.sort_order ?? 0,
      });
    }

    const filledCategories = [...categoryMap.values()].filter((category) => category.items.length > 0);

    const now = new Date();
    let assets = await all(`
      SELECT id, kind, title, body, image_url, sort_order, starts_at, ends_at
      FROM display_assets
      WHERE active = true
        AND (starts_at IS NULL OR starts_at <= NOW())
        AND (ends_at IS NULL OR ends_at >= NOW())
      ORDER BY sort_order ASC NULLS LAST, id ASC
    `);

    if (tv.activeAssetIds.length > 0) {
      const allowed = new Set(tv.activeAssetIds);
      assets = assets.filter((asset) => allowed.has(String(asset.id)));
    }

    const seasonalCallout = isCalloutActive(tv.seasonalCallout, now)
      ? {
          title: tv.seasonalCallout.title || undefined,
          body: tv.seasonalCallout.body || undefined,
        }
      : null;

    res.json({
      shop: {
        name: req.tenant?.name || branding.restaurantName || 'Menu',
        tagline: branding.tagline || undefined,
        logoUrl: branding.logoUrl || null,
        primaryColor: branding.primaryColor || '#0d9488',
        address: branding.address || undefined,
      },
      layout: {
        template: tv.layout,
        enabled: tv.enabled,
        showPrices: tv.showPrices,
        showLogo: tv.showLogo,
        showTagline: tv.showTagline,
        footerText: tv.footerText || undefined,
        rotationSeconds: tv.rotationSeconds,
      },
      categories: filledCategories,
      atmosphere: {
        assets: assets.map((asset) => ({
          id: String(asset.id),
          kind: asset.kind,
          title: asset.title || undefined,
          body: asset.body || undefined,
          imageUrl: asset.image_url || null,
          sortOrder: asset.sort_order ?? 0,
        })),
        seasonalCallout,
      },
    });
  } catch (error) {
    console.error('Error fetching menu board data:', error);
    res.status(500).json({ error: 'Failed to fetch menu board data' });
  }
});

export default router;
