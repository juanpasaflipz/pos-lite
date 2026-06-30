// Tenant data purge — discovers every table with a `tenant_id` column via
// information_schema, derives a safe deletion order from the live FK graph
// in pg_catalog, and deletes the tenant's rows in reverse topological order
// (children first).
//
// This replaces the hand-coded layered cascade that previously lived inline
// in DELETE /admin/tenants/:id. The old list missed payroll, scheduling,
// cash-drawer, expenses, voice-intents and a dozen others — silently leaving
// PII behind on offboarding (LFPDPPP / GDPR exposure).
//
// Design notes:
// - Self-referential FKs (e.g. loyalty_customers.referred_by) are NOT
//   represented as graph edges; we NULL the referencing column for the
//   tenant's rows before deleting the table itself.
// - The full delete order is executed TWICE inside the transaction. Some
//   background workers (AI scheduler, voice-intent dispatcher) may INSERT
//   into already-deleted child tables between the first DELETE on the child
//   and the parent DELETE that follows. A second pass mops up those late
//   inserts. If a third pass would still find rows, we throw — that's a
//   signal that an external writer is racing harder than expected and the
//   purge should be retried in a quieter window.

import { adminSql } from '../db/index.js';

const SCHEMA = 'public';

// Tables that should be skipped even though they carry a tenant_id column.
// Empty for now — every tenant_id-bearing table represents tenant-owned PII
// or operational state that must go on offboarding. Add here only with a
// written justification.
const SKIP_TABLES = new Set();

async function discoverTenantTables(sql) {
  const rows = await sql`
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.column_name = 'tenant_id'
      AND c.table_schema = ${SCHEMA}
      AND t.table_type = 'BASE TABLE'
    ORDER BY c.table_name
  `;
  return rows.map((r) => r.table_name).filter((t) => !SKIP_TABLES.has(t));
}

// Returns { edges: [[from, to], ...], selfRefs: [{ table, column }, ...] }.
// edges contains intra-tenant-table FK relationships ONLY — we ignore FKs
// that reference platform-level tables (tenants, migrations, etc.) because
// those won't block our deletes.
async function discoverFkGraph(sql, tenantTables) {
  const tableSet = new Set(tenantTables);

  const rows = await sql`
    SELECT
      conrelid::regclass::text   AS from_table,
      confrelid::regclass::text  AS to_table,
      conrelid = confrelid       AS is_self_ref,
      a.attname                  AS from_column
    FROM pg_constraint c
    JOIN pg_attribute a
      ON a.attrelid = c.conrelid
     AND a.attnum   = c.conkey[1]
    WHERE c.contype = 'f'
      AND c.connamespace = ${SCHEMA}::regnamespace
  `;

  const edges = [];
  const selfRefs = [];
  for (const r of rows) {
    if (!tableSet.has(r.from_table) || !tableSet.has(r.to_table)) continue;
    if (r.is_self_ref) {
      selfRefs.push({ table: r.from_table, column: r.from_column });
    } else {
      edges.push([r.from_table, r.to_table]);
    }
  }
  return { edges, selfRefs };
}

// Kahn's algorithm. Returns an array ordered "parents first" — meaning the
// caller should delete in REVERSE order (children, then parents).
function topologicalOrder(nodes, edges) {
  const indegree = new Map(nodes.map((n) => [n, 0]));
  const adj = new Map(nodes.map((n) => [n, []]));
  for (const [from, to] of edges) {
    // from depends on to (FK from→to means `to` must exist for `from` to
    // exist). For deletion, parents (to) must wait for children (from).
    // So edge "to → from" in the topo graph (to comes before from).
    if (!adj.has(to)) adj.set(to, []);
    adj.get(to).push(from);
    indegree.set(from, (indegree.get(from) || 0) + 1);
  }

  const queue = [];
  for (const [n, deg] of indegree) if (deg === 0) queue.push(n);

  const order = [];
  while (queue.length) {
    const n = queue.shift();
    order.push(n);
    for (const m of adj.get(n) || []) {
      indegree.set(m, indegree.get(m) - 1);
      if (indegree.get(m) === 0) queue.push(m);
    }
  }

  if (order.length !== nodes.length) {
    // A cycle made it through self-ref filtering. Surface the leftover set
    // so an operator can investigate which FK is the culprit.
    const remaining = nodes.filter((n) => !order.includes(n));
    throw new Error(
      `Cycle in tenant-table FK graph; unresolved: ${remaining.join(', ')}`
    );
  }
  return order;
}

// Build the deletion order once (cached for the life of the process). The
// schema only changes via a deploy, and at deploy time the process restarts.
let _orderCache = null;
async function buildDeletionOrder(sql) {
  if (_orderCache) return _orderCache;
  const tables = await discoverTenantTables(sql);
  const { edges, selfRefs } = await discoverFkGraph(sql, tables);
  const topo = topologicalOrder(tables, edges);
  _orderCache = {
    tables,
    selfRefs,
    deletionOrder: [...topo].reverse(), // children first
  };
  return _orderCache;
}

// Exposed for tests / scripts that want to invalidate after a migration.
export function _resetOrderCache() {
  _orderCache = null;
}

// dryRunPurge — returns the deletion order along with a row count per table
// for the given tenant. Does not modify any data. Caller is responsible for
// surfacing this to the operator before confirming a destructive delete.
export async function dryRunPurge(tenantId) {
  const { tables, selfRefs, deletionOrder } = await buildDeletionOrder(adminSql);
  const counts = {};
  for (const t of tables) {
    const [row] = await adminSql.unsafe(
      `SELECT COUNT(*)::int AS n FROM ${t} WHERE tenant_id = $1`,
      [tenantId]
    );
    counts[t] = row?.n ?? 0;
  }
  return {
    tenant_id: tenantId,
    table_count: tables.length,
    self_refs: selfRefs,
    deletion_order: deletionOrder,
    row_counts: counts,
    total_rows: Object.values(counts).reduce((a, b) => a + b, 0),
  };
}

// purgeTenant — executes the cascade inside a single transaction.
//   1) NULL out self-referential columns scoped to this tenant
//   2) For each table in deletionOrder: DELETE WHERE tenant_id
//   3) Repeat step 2 once more to catch any late inserts from background
//      workers that fired between our DELETEs
//   4) DELETE FROM tenants WHERE id = $tenantId
// Returns { tables_purged, rows_deleted_first_pass, rows_deleted_second_pass }.
export async function purgeTenant(tenantId) {
  const { selfRefs, deletionOrder } = await buildDeletionOrder(adminSql);

  let firstPass = 0;
  let secondPass = 0;

  await adminSql.begin(async (sql) => {
    // Defuse self-referential FKs first — once children are NULLed there's
    // no intra-table ordering left for the upcoming DELETE.
    for (const { table, column } of selfRefs) {
      await sql.unsafe(
        `UPDATE ${table} SET ${column} = NULL WHERE tenant_id = $1`,
        [tenantId]
      );
    }

    for (const t of deletionOrder) {
      const result = await sql.unsafe(
        `DELETE FROM ${t} WHERE tenant_id = $1`,
        [tenantId]
      );
      firstPass += Number(result?.count ?? 0);
    }

    // Race-condition mop-up. Background schedulers can INSERT after we
    // already cleared the child table; the second pass handles that.
    for (const t of deletionOrder) {
      const result = await sql.unsafe(
        `DELETE FROM ${t} WHERE tenant_id = $1`,
        [tenantId]
      );
      secondPass += Number(result?.count ?? 0);
    }

    // Third pass — if there are STILL rows, an external writer is racing
    // harder than the cascade can mop up. Fail loud so the operator can
    // pause the offending worker and retry.
    let thirdPass = 0;
    for (const t of deletionOrder) {
      const result = await sql.unsafe(
        `DELETE FROM ${t} WHERE tenant_id = $1`,
        [tenantId]
      );
      thirdPass += Number(result?.count ?? 0);
    }
    if (thirdPass > 0) {
      throw new Error(
        `tenant_purge: ${thirdPass} rows kept appearing after two cascade passes — pause background writers and retry`
      );
    }

    await sql`DELETE FROM tenants WHERE id = ${tenantId}`;
  });

  return {
    tables_purged: deletionOrder.length,
    rows_deleted_first_pass: firstPass,
    rows_deleted_second_pass: secondPass,
  };
}
