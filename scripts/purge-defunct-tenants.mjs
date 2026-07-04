import 'dotenv/config';
import { purgeTenant, _resetOrderCache } from '../server/helpers/tenantPurge.js';
import { adminSql } from '../server/db/index.js';
import bcrypt from 'bcrypt';

_resetOrderCache();

// Legacy tenants whose tenants row is already gone but whose child data
// (menu_items, employees, orders, etc.) never got cleaned up. We insert a
// throwaway tenants stub so purgeTenant() can run its topological cascade
// against the orphan rows, then it deletes the stub as its last step.
const DEFUNCT = [
  'test-alpha-4x2c',
  'test-alpha-7vqm',
  'test-alpha-esrf',
  'test-alpha-m5ig',
  'test-alpha-m6cs',
  'test-alpha-q8fz',
  'test-alpha-zi3a',
  'test-beta-m6cs',
];

const hash = await bcrypt.hash('unused', 4);

for (const id of DEFUNCT) {
  const [existing] = await adminSql`SELECT id FROM tenants WHERE id = ${id}`;
  if (!existing) {
    await adminSql`
      INSERT INTO tenants (id, name, owner_email, owner_password_hash, active)
      VALUES (${id}, ${`stub-${id}`}, ${`${id}@stub.local`}, ${hash}, false)
    `;
    console.log(`STUB ${id}  inserted`);
  }

  const result = await purgeTenant(id);
  console.log(
    `DONE ${id}  tables=${result.tables_purged}  pass1=${result.rows_deleted_first_pass}  pass2=${result.rows_deleted_second_pass}`
  );
}

process.exit(0);
