export const version = 102;
export const name = 'import_formats';

// Shared delivery-export format registry (2026-07-31, migration 0102).
//
// Why: Rappi's "Relación de ventas" has the same 71 columns for every merchant
// in Mexico, and DiDi's product report the same 10 — but today every tenant
// re-derives the column mapping from scratch, and a format nobody has coded
// candidate strings for needs a human every single time. This table makes the
// FIRST confirmation of a format teach every tenant that follows.
//
// ============================ NOT TENANT-SCOPED ============================
// This is the one table in the schema that is deliberately shared across
// tenants: no tenant_id, no RLS policy. That is the entire point — a mapping
// confirmed by tenant A must be visible to tenant B.
//
// What makes that safe is the column set, and it is the invariant to hold when
// touching this file: **only column NAMES and the mapping between them are
// stored here — never a cell value.** Header names are format metadata
// published by Rappi and DiDi, not merchant data. Sales figures, order ids,
// product names and totals must never reach this table.
//
// Second safety property: a registry hit is a SUGGESTION, never an auto-commit.
// Both preview endpoints still render the mapping for confirmation, so the
// worst a bad entry can do is offer a wrong starting guess that the next tenant
// corrects — which then overwrites it. Nothing imports unattended.
// ===========================================================================
export async function up(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS import_formats (
      id SERIAL PRIMARY KEY,
      -- sha256 of (kind + normalized, sorted header names). Same export layout
      -- from any merchant on any platform hashes identically.
      fingerprint TEXT NOT NULL UNIQUE,
      -- Which parser this mapping feeds: 'settlement' (revenue + commission)
      -- or 'products' (units + COGS). Folded into the fingerprint so the same
      -- headers can never collide across the two.
      kind TEXT NOT NULL,
      -- Column names as the file wrote them, for debugging a bad match.
      -- Names only — see the note above.
      headers JSONB NOT NULL DEFAULT '[]'::jsonb,
      -- { logical_field: "Column Name" | null }
      mapping JSONB NOT NULL DEFAULT '{}'::jsonb,
      -- 'heuristic' (candidate lists), 'ai' (model cold start), or 'human'
      -- (a tenant corrected it in the preview). Human always wins.
      source TEXT NOT NULL DEFAULT 'heuristic',
      -- How many separate imports have committed against this mapping. A
      -- rough confidence signal and a way to spot formats worth hard-coding.
      confirmed_count INTEGER NOT NULL DEFAULT 0,
      -- Free-text label for humans reading the table ("DiDi productos diario").
      label TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_import_formats_kind
    ON import_formats (kind, confirmed_count DESC)
  `;

  // No ENABLE ROW LEVEL SECURITY here, and that is intentional — see the
  // header note. Every other tenant table in this schema is RLS-scoped; if you
  // are copying this migration as a template for one that holds tenant data,
  // copy 0095 instead.
  await sql.unsafe(`GRANT SELECT, INSERT, UPDATE ON import_formats TO app_user`);
  await sql.unsafe(`
    DO $$
    BEGIN
      IF to_regclass('public.import_formats_id_seq') IS NOT NULL THEN
        EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE import_formats_id_seq TO app_user';
      END IF;
    END $$;
  `);
}
