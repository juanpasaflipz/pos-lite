/**
 * APNs push for Apple Wallet pass updates.
 *
 * Pass-update pushes authenticate with the SAME pass certificate used for
 * signing (TLS client cert), topic = the Pass Type ID, and an empty payload.
 * The device responds by silently re-fetching the pass from our web service.
 *
 * Raw HTTP/2 — no APNs SDK dependency (~40 lines is all this needs).
 * Best-effort by design: a missed push self-heals the next time the
 * device opens Wallet, because GET /v1/passes rebuilds from DB truth.
 */

import http2 from 'node:http2';

const APNS_HOST = 'https://api.push.apple.com';

function getClientCert() {
  return {
    cert: Buffer.from(process.env.APPLE_PASS_CERT_BASE64 || '', 'base64'),
    key: Buffer.from(process.env.APPLE_PASS_KEY_BASE64 || '', 'base64'),
    passphrase: process.env.APPLE_PASS_KEY_PASSPHRASE || undefined,
  };
}

/**
 * Push a pass-update notification to one device.
 * Resolves { ok, status, unregistered } — never rejects.
 * `unregistered: true` (410/BadDeviceToken) means the caller should delete
 * the registration row.
 */
export function pushPassUpdate(pushToken) {
  return new Promise((resolve) => {
    let client;
    try {
      client = http2.connect(APNS_HOST, getClientCert());
    } catch (err) {
      console.error('[APNs] connect failed:', err.message);
      return resolve({ ok: false, status: 0, unregistered: false });
    }

    const finish = (result) => {
      try { client.close(); } catch {}
      resolve(result);
    };

    client.on('error', (err) => {
      console.error('[APNs] connection error:', err.message);
      finish({ ok: false, status: 0, unregistered: false });
    });

    const req = client.request({
      ':method': 'POST',
      ':path': `/3/device/${pushToken}`,
      'apns-topic': process.env.APPLE_PASS_TYPE_ID,
      'apns-push-type': 'alert',
      'content-type': 'application/json',
    });

    let status = 0;
    let body = '';
    req.setTimeout(10_000, () => {
      req.close(http2.constants.NGHTTP2_CANCEL);
      finish({ ok: false, status: 0, unregistered: false });
    });
    req.on('response', (headers) => { status = headers[':status']; });
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const unregistered =
        status === 410 || (status === 400 && body.includes('BadDeviceToken'));
      if (status !== 200 && !unregistered) {
        console.error(`[APNs] push failed (${status}): ${body}`);
      }
      finish({ ok: status === 200, status, unregistered });
    });
    req.on('error', (err) => {
      console.error('[APNs] request error:', err.message);
      finish({ ok: false, status: 0, unregistered: false });
    });

    req.end(JSON.stringify({}));
  });
}
