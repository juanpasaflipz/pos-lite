export const version = 77;
export const name = 'menu_item_image_metadata';

// Image metadata for menu photos (TODOS 0d). `menu_items.image_url` already
// exists and holds the rendered (card) variant URL; these columns carry the
// extra data the photo pipeline produces:
//   image_width / image_height — source dimensions, for layout-shift-free <img>
//   image_blurhash             — reserved for a future progressive-load placeholder
//   image_uploaded_at / _by    — audit trail (who set the photo, when)
//
// NOTE: the original TODOS draft referenced `users(id)`; this schema has no
// users table — employees is the actor table, so the FK points there.
// RLS is inherited from menu_items (no policy changes needed).

export async function up(sql) {
  await sql`
    ALTER TABLE menu_items
      ADD COLUMN IF NOT EXISTS image_width INTEGER,
      ADD COLUMN IF NOT EXISTS image_height INTEGER,
      ADD COLUMN IF NOT EXISTS image_blurhash TEXT,
      ADD COLUMN IF NOT EXISTS image_uploaded_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS image_uploaded_by INTEGER REFERENCES employees(id)
  `;
}
