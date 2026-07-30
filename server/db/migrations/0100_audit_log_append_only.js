export const version = 100;
export const name = 'audit_log_append_only';

// Make audit_log append-only for the request role.
//
// Same root cause as 0099: this database carries a default ACL
// (`ALTER DEFAULT PRIVILEGES` by neondb_owner) granting app_user `arwd` on
// every table, so the forensic log has always been DELETE-able by the role
// every /api/* request runs as. A log that the request path can erase is not
// evidence — and audit_log is the only place a deleted order survives, now
// that DELETE /orders/:id snapshots into it.
//
// Verified safe before revoking (2026-07-30): nothing removes these rows
// through the app path. There is no `DELETE FROM audit_log` anywhere in the
// codebase and no retention sweep (pruneOldPrintJobs only touches print_jobs).
// The single writer (lib/auditLog.js) and single reader
// (sentinel/playbooks.js) both run on `adminSql`. The two paths that DO delete
// — `purgeTenant` and the test-fixture teardown — discover tenant tables
// dynamically and also run on `adminSql`, which connects with the
// DATABASE_URL owner credentials and holds DELETE/TRUNCATE independently, so
// tenant offboarding is unaffected.
//
// Deliberately narrow: INSERT/SELECT/UPDATE are left in place. The
// tamper-resistance property comes entirely from DELETE and TRUNCATE, and
// leaving the rest means a future audit write on the tenant connection fails
// safe rather than silently losing its log line.
export async function up(sql) {
  await sql`REVOKE DELETE, TRUNCATE ON audit_log FROM app_user`;
}
