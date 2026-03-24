import { offlineDb, type CachedMenuData } from './offlineDb';
import {
  getCategories,
  getMenuItems,
  getItemsWithModifiers,
  getPopularItems,
  getCategorySuggestedOrder,
  getCombos,
  getOrderTemplates,
  getPosBrands,
} from '../api';
import type { MenuCategory, MenuItem, ComboDefinition, OrderTemplate, VirtualBrand } from '../types';

const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

async function cacheGet<T>(key: string): Promise<T | null> {
  const entry = await offlineDb.menuCache.get(key);
  if (!entry) return null;
  // Still return even if stale — caller decides freshness
  return entry.data as T;
}

async function cacheSet(key: string, data: any): Promise<void> {
  const entry: CachedMenuData = { key, data, updatedAt: Date.now() };
  await offlineDb.menuCache.put(entry);
}

/**
 * Cache-first wrapper: try server, fall back to IndexedDB.
 * First launch must be online (no cache = error).
 */
async function withCache<T>(
  key: string,
  fetcher: () => Promise<T>,
): Promise<T> {
  try {
    const fresh = await fetcher();
    await cacheSet(key, fresh);
    return fresh;
  } catch {
    // Server failed — read from cache
    const cached = await cacheGet<T>(key);
    if (cached !== null) return cached;
    throw new Error(`No cached data for "${key}" — connect to internet for initial setup`);
  }
}

/**
 * Invalidate all menu-related caches (IndexedDB + Service Worker).
 * Call this after any menu mutation (toggle, edit, add, delete) so the
 * POS screen picks up fresh data on next load.
 */
export async function invalidateMenuCache(): Promise<void> {
  // 1. Clear IndexedDB menu cache entries
  await offlineDb.menuCache.bulkDelete([
    'menuItems',
    'categories',
    'popularItems',
    'combos',
    'itemsWithModifiers',
    'categorySuggestedOrder',
    'posBrands',
  ]);

  // 2. Clear the Service Worker API cache so stale-while-revalidate
  //    doesn't serve old data on the next page load
  if ('caches' in window) {
    const cache = await caches.open('dk-api-v1');
    const keys = await cache.keys();
    await Promise.all(
      keys
        .filter(req => req.url.includes('/api/menu/') || req.url.includes('/api/combos'))
        .map(req => cache.delete(req))
    );
  }
}

/* ==================== Cached API Functions ==================== */

export function getCachedCategories(): Promise<MenuCategory[]> {
  return withCache('categories', () => getCategories());
}

export function getCachedMenuItems(): Promise<MenuItem[]> {
  return withCache('menuItems', () => getMenuItems());
}

export function getCachedItemsWithModifiers(): Promise<{ itemIds: number[] }> {
  return withCache('itemsWithModifiers', () => getItemsWithModifiers());
}

export function getCachedPopularItems(limit: number = 8): Promise<MenuItem[]> {
  return withCache('popularItems', () => getPopularItems(limit));
}

export function getCachedCategorySuggestedOrder(): Promise<number[]> {
  return withCache('categorySuggestedOrder', () => getCategorySuggestedOrder());
}

export function getCachedCombos(): Promise<ComboDefinition[]> {
  return withCache('combos', () => getCombos());
}

export function getCachedOrderTemplates(): Promise<OrderTemplate[]> {
  return withCache('orderTemplates', () => getOrderTemplates());
}

export function getCachedPosBrands(): Promise<VirtualBrand[]> {
  return withCache('posBrands', () => getPosBrands());
}
