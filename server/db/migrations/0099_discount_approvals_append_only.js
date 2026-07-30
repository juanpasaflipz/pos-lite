export const version = 99;
export const name = 'discount_approvals_append_only';

// Make discount_approvals genuinely append-only for the request role.
//
// 0098 granted only SELECT/INSERT/UPDATE and said "no DELETE", but that grant
// was a no-op: this database carries a default ACL
// (`ALTER DEFAULT PRIVILEGES ... GRANT` by neondb_owner) handing app_user
// `arwd` on every newly created table. So the table shipped DELETE-able by the
// role every /api/* request runs as, which is exactly wrong for a table whose
// job is to prove who authorized a discount — anything able to run SQL through
// the app path could erase the evidence it was about to create.
//
// Safe because nothing deletes these through the app: `purgeTenant`
// (helpers/tenantPurge.js) and the test-fixture teardown both run on
// `adminSql`, which connects with the DATABASE_URL owner credentials, not
// PG_APP_USER. Tenant offboarding still removes the rows.
//
// NOTE for whoever picks this up: `audit_log` has the same exposure from the
// same default ACL and is deliberately NOT changed here — it is pre-existing,
// unrelated to this change, and deserves its own look at whether anything
// legitimately deletes from it first.
export async function up(sql) {
  await sql`REVOKE DELETE, TRUNCATE ON discount_approvals FROM app_user`;
}
