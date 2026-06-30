// Live-fire verification: run the full cascade against a real tenant inside
// a transaction that ROLLs BACK at the end. Catches FK violations or missed
// dependencies without persisting any change.
//
// Usage: PROBE_TENANT=demo node scripts/test-purge-rollback.mjs

import { adminSql } from '../server/db/index.js';

const SCHEMA = 'public';

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
  return rows.map((r) => r.table_name);
}

async function discoverFkGraph(sql, tables) {
  const set = new Set(tables);
  const rows = await sql`
    SELECT
      conrelid::regclass::text AS from_table,
      confrelid::regclass::text AS to_table,
      conrelid = confrelid AS is_self,
      a.attname AS from_col
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
    WHERE c.contype = 'f' AND c.connamespace = ${SCHEMA}::regnamespace
  `;
  const edges = [];
  const selfRefs = [];
  for (const r of rows) {
    if (!set.has(r.from_table) || !set.has(r.to_table)) continue;
    if (r.is_self) selfRefs.push({ table: r.from_table, column: r.from_col });
    else edges.push([r.from_table, r.to_table]);
  }
  return { edges, selfRefs };
}

function topo(nodes, edges) {
  const indegree = new Map(nodes.map((n) => [n, 0]));
  const adj = new Map(nodes.map((n) => [n, []]));
  for (const [from, to] of edges) {
    adj.get(to).push(from);
    indegree.set(from, (indegree.get(from) || 0) + 1);
  }
  const queue = [];
  for (const [n, d] of indegree) if (d === 0) queue.push(n);
  const order = [];
  while (queue.length) {
    const n = queue.shift();
    order.push(n);
    for (const m of adj.get(n) || []) {
      indegree.set(m, indegree.get(m) - 1);
      if (indegree.get(m) === 0) queue.push(m);
    }
  }
  return order;
}

const probe = process.env.PROBE_TENANT;
if (!probe) {
  console.error('Set PROBE_TENANT=<tenant_id>');
  process.exit(1);
}

const tables = await discoverTenantTables(adminSql);
const { edges, selfRefs } = await discoverFkGraph(adminSql, tables);
const order = topo(tables, edges).reverse();

console.log(`Probing tenant: ${probe}`);
console.log(`Tables: ${tables.length}, self-refs: ${selfRefs.length}`);

try {
  await adminSql.begin(async (sql) => {
    for (const { table, column } of selfRefs) {
      await sql.unsafe(
        `UPDATE ${table} SET ${column} = NULL WHERE tenant_id = $1`,
        [probe]
      );
    }
    let totalRows = 0;
    for (const t of order) {
      const result = await sql.unsafe(
        `DELETE FROM ${t} WHERE tenant_id = $1`,
        [probe]
      );
      totalRows += Number(result?.count ?? 0);
    }
    console.log(`First pass deleted: ${totalRows} rows`);

    // Second pass
    let second = 0;
    for (const t of order) {
      const result = await sql.unsafe(
        `DELETE FROM ${t} WHERE tenant_id = $1`,
        [probe]
      );
      second += Number(result?.count ?? 0);
    }
    console.log(`Second pass deleted: ${second} rows (should be 0 unless race)`);

    // Third pass — must be 0
    let third = 0;
    for (const t of order) {
      const result = await sql.unsafe(
        `DELETE FROM ${t} WHERE tenant_id = $1`,
        [probe]
      );
      third += Number(result?.count ?? 0);
    }
    if (third !== 0) {
      console.log(`THIRD PASS NONZERO (${third}) — would have failed in prod`);
    } else {
      console.log('Third pass: 0 rows (clean)');
    }

    // Confirm tenant row would delete cleanly too
    await sql`DELETE FROM tenants WHERE id = ${probe}`;
    console.log('tenants row delete: OK');

    // Bail out — we are NEVER actually committing this. Throw to roll back.
    throw new Error('__ROLLBACK__');
  });
} catch (e) {
  if (e.message === '__ROLLBACK__') {
    console.log('\nTransaction rolled back — no data was changed.');
  } else {
    console.error('\nFAILURE during cascade:', e.message);
    process.exit(1);
  }
}

// Confirm tenant still exists
const [{ count }] = await adminSql`SELECT COUNT(*)::int AS count FROM tenants WHERE id = ${probe}`;
console.log(`Post-rollback: tenant '${probe}' still present: ${count === 1}`);

await adminSql.end();
