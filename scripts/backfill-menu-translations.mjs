// Backfill menu_items.name_en / description_en for every active row where
// the English cache is missing. New writes populate these columns
// automatically (see server/routes/menu.js scheduleMenuTranslation); this
// script fills in items that existed before that hook shipped.
//
// Idempotent + resumable — filters on `name_en IS NULL`, so re-running only
// picks up items that still need translation. Rate-limited so a large menu
// doesn't slam the Anthropic API. Set TENANT_ID=<slug> to limit to one
// tenant; leave unset to run every tenant.
//
// Usage:
//   DRY_RUN=1 node scripts/backfill-menu-translations.mjs           ← preview
//              node scripts/backfill-menu-translations.mjs           ← write
//              TENANT_ID=juanbertos node scripts/backfill-menu-translations.mjs
//
// Requires ANTHROPIC_API_KEY + DATABASE_URL in env.

import 'dotenv/config';
import postgres from 'postgres';
import { translateMenuItem } from '../server/helpers/menuTranslate.js';

const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const TENANT_FILTER = process.env.TENANT_ID || null;
const CONCURRENCY = Number(process.env.CONCURRENCY) || 3;
const DELAY_MS = Number(process.env.DELAY_MS) || 150;

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is required');
  process.exit(1);
}

const sql = postgres(process.env.DATABASE_URL, { ssl: 'require', max: 2 });

async function main() {
  await sql`SET row_security = off`;

  const rows = await sql`
    SELECT id, tenant_id, name, description
    FROM menu_items
    WHERE name_en IS NULL
      AND active = true
      ${TENANT_FILTER ? sql`AND tenant_id = ${TENANT_FILTER}` : sql``}
    ORDER BY tenant_id, id
  `;

  if (rows.length === 0) {
    console.log('Nothing to backfill.');
    return;
  }

  console.log(`Rows to translate: ${rows.length}${TENANT_FILTER ? ` (tenant=${TENANT_FILTER})` : ''}${DRY_RUN ? ' [DRY RUN]' : ''}`);

  let done = 0;
  let failed = 0;
  const queue = [...rows];
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const row = queue.shift();
      if (!row) break;
      try {
        const { name_en, description_en } = await translateMenuItem({
          name: row.name,
          description: row.description,
        });
        if (DRY_RUN) {
          console.log(`  [dry] #${row.id} (${row.tenant_id}) "${row.name}" → "${name_en}"`);
        } else {
          await sql`
            UPDATE menu_items
            SET name_en = ${name_en || null}, description_en = ${description_en || null}
            WHERE id = ${row.id} AND tenant_id = ${row.tenant_id}
          `;
        }
        done += 1;
        if (done % 10 === 0) console.log(`  ${done}/${rows.length} done`);
      } catch (err) {
        failed += 1;
        console.warn(`  #${row.id} (${row.tenant_id}) failed: ${err.message}`);
      }
      if (DELAY_MS > 0) await new Promise((r) => setTimeout(r, DELAY_MS));
    }
  });

  await Promise.all(workers);
  console.log(`Done. Success: ${done}, failed: ${failed}.`);
}

try {
  await main();
} finally {
  await sql.end({ timeout: 5 });
}
