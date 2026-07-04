import 'dotenv/config';
import { purgeTenant, dryRunPurge, _resetOrderCache } from '../server/helpers/tenantPurge.js';
import { adminSql } from '../server/db/index.js';

_resetOrderCache();

const TARGETS = [
  'juanito-s',
  'apple-demo',
  'juanitos',
  'taco-demo',
  'bobbys',
];

const dryRun = process.argv.includes('--dry-run');

for (const id of TARGETS) {
  const [t] = await adminSql`SELECT id, name FROM tenants WHERE id = ${id}`;
  if (!t) {
    console.log(`SKIP ${id} (not found)`);
    continue;
  }

  if (dryRun) {
    const plan = await dryRunPurge(id);
    console.log(`DRY  ${id}  rows=${plan.total_rows}  tables=${plan.table_count}`);
    continue;
  }

  const result = await purgeTenant(id);
  console.log(
    `DONE ${id}  tables=${result.tables_purged}  pass1=${result.rows_deleted_first_pass}  pass2=${result.rows_deleted_second_pass}`
  );
}

process.exit(0);
