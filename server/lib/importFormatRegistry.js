// Shared delivery-export format registry — read/write side.
//
// The durable half of "users just upload": once any tenant confirms which
// column is which for a given file layout, every later upload of that same
// layout — by anyone — starts pre-mapped. See migration 0102 for the schema
// and the not-tenant-scoped rationale.
//
// INVARIANT: only column names and the mapping between them are persisted
// here. This table is shared across tenants; a cell value written into it
// would leak one merchant's sales data to another. If you add a field, ask
// whether it could contain a value from the file — if yes, it doesn't belong.

import { getConn } from '../db/index.js';

// Ranked so a weaker source never silently overwrites a stronger one. A human
// correcting the mapping in the preview is the strongest signal we get; the
// candidate lists are the weakest.
const SOURCE_RANK = { heuristic: 0, ai: 1, human: 2 };

/**
 * Look up a previously confirmed mapping for this file layout.
 * @returns {Promise<{mapping: object, source: string, confirmed_count: number, label: string|null} | null>}
 */
export async function lookupFormat(fingerprint) {
  if (!fingerprint) return null;
  try {
    const conn = getConn();
    const [row] = await conn`
      SELECT mapping, source, confirmed_count, label
      FROM import_formats WHERE fingerprint = ${fingerprint}
    `;
    if (!row) return null;
    return {
      mapping: row.mapping || {},
      source: row.source,
      confirmed_count: Number(row.confirmed_count) || 0,
      label: row.label ?? null,
    };
  } catch (err) {
    // A registry miss must never block an import — the heuristics and the
    // preview UI still work without it.
    console.warn('[importFormats] lookup skipped:', err.message);
    return null;
  }
}

/**
 * Record a mapping for this layout so the next tenant to upload it starts
 * pre-mapped.
 *
 * Called on COMMIT, not on preview: a mapping the user actually imported
 * against is evidence, a mapping they merely looked at is not.
 *
 * Upsert rules — a stronger source always wins; an equal source refreshes the
 * mapping (the user corrected it again) and bumps the count. A weaker source
 * only increments the count, leaving the better mapping in place.
 *
 * @param {string} fingerprint
 * @param {'settlement'|'products'} kind
 * @param {string[]} headers  column NAMES only
 * @param {object} mapping    { logical_field: column name | null }
 * @param {'heuristic'|'ai'|'human'} source
 * @param {string|null} label
 */
export async function recordFormat(fingerprint, kind, headers, mapping, source = 'heuristic', label = null) {
  if (!fingerprint || !mapping) return;
  const rank = SOURCE_RANK[source] ?? 0;
  try {
    const conn = getConn();
    await conn`
      INSERT INTO import_formats (fingerprint, kind, headers, mapping, source, confirmed_count, label)
      VALUES (
        ${fingerprint}, ${kind},
        ${conn.json(Array.isArray(headers) ? headers.slice(0, 200) : [])},
        ${conn.json(mapping)}, ${source}, 1, ${label}
      )
      ON CONFLICT (fingerprint) DO UPDATE SET
        mapping = CASE
          WHEN ${rank} >= COALESCE(
            (CASE import_formats.source
               WHEN 'human' THEN 2 WHEN 'ai' THEN 1 ELSE 0 END), 0)
          THEN EXCLUDED.mapping ELSE import_formats.mapping END,
        source = CASE
          WHEN ${rank} >= COALESCE(
            (CASE import_formats.source
               WHEN 'human' THEN 2 WHEN 'ai' THEN 1 ELSE 0 END), 0)
          THEN EXCLUDED.source ELSE import_formats.source END,
        headers = EXCLUDED.headers,
        label = COALESCE(EXCLUDED.label, import_formats.label),
        confirmed_count = import_formats.confirmed_count + 1,
        updated_at = NOW()
    `;
  } catch (err) {
    // Never fail an import because the shared registry write failed — the
    // orders and stock movements are the real work.
    console.warn('[importFormats] record skipped:', err.message);
  }
}

/**
 * Did the user change the detected mapping? That edit is the strongest signal
 * the registry gets, so the commit path records it as 'human' rather than
 * re-recording whatever the detector originally guessed.
 */
export function mappingDiffers(a, b) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) {
    if ((a?.[k] ?? null) !== (b?.[k] ?? null)) return true;
  }
  return false;
}
