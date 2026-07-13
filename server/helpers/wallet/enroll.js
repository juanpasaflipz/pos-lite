/**
 * Shared wallet-pass enrollment: find-or-create the Apple pass row for a
 * loyalty customer and make sure it has a capability (enroll) token.
 *
 * Used by two surfaces with different auth models:
 *   - POST /api/wallet/enroll        (staff JWT, tenant middleware context)
 *   - POST /api/kiosk/wallet-enroll  (kiosk device token + customer session)
 * Both run inside a tenant-scoped (RLS) connection — this helper uses the
 * ambient get/run so it inherits whichever transaction the caller opened.
 */

import crypto from 'crypto';
import { get, run } from '../../db/index.js';

/**
 * @param {number} customerId  loyalty_customers.id (must exist in this tenant)
 * @returns {Promise<{ pass: object, created: boolean }>}
 */
export async function ensureApplePass(customerId) {
  let pass = await get(
    `SELECT * FROM wallet_passes WHERE customer_id = $1 AND platform = 'apple' AND revoked = false`,
    [customerId]
  );

  let created = false;
  if (!pass) {
    const serial = crypto.randomUUID();
    const authToken = crypto.randomBytes(24).toString('hex'); // Apple spec: >= 16 chars
    const enrollToken = crypto.randomBytes(16).toString('base64url');
    const { lastInsertRowid } = await run(
      `INSERT INTO wallet_passes (customer_id, platform, serial_number, auth_token, enroll_token)
       VALUES ($1, 'apple', $2, $3, $4)`,
      [customerId, serial, authToken, enrollToken]
    );
    pass = await get('SELECT * FROM wallet_passes WHERE id = $1', [lastInsertRowid]);
    created = true;
  } else if (!pass.enroll_token) {
    const enrollToken = crypto.randomBytes(16).toString('base64url');
    await run('UPDATE wallet_passes SET enroll_token = $1 WHERE id = $2', [enrollToken, pass.id]);
    pass.enroll_token = enrollToken;
  }

  return { pass, created };
}
