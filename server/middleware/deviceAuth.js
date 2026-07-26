import jwt from 'jsonwebtoken';
import { get, run } from '../db/index.js';
import { JWT_SECRET } from '../lib/constants.js';

// Verify a paired-device JWT. On success, attaches req.device and bumps
// last_seen_at. Tokens carry { type:'device', deviceId, tenantId,
// deviceType, jti } — jti is checked against the DB row, so rotating
// token_jti revokes the token instantly even though the JWT itself is
// long-lived.
//
// Diagnostic logging: every rejection is logged with the specific reason
// plus enough context (deviceId, hostname, tenant ids) to tell apart the
// three real causes of a KDS screen "un-binding" from a browser losing its
// localStorage token: (1) the JWT itself is malformed/expired, (2) the
// request resolved to a different tenant than the one the device paired
// under (host/subdomain routing issue — not an actual revoke), or (3) the
// device really was revoked / superseded server-side. Search Railway logs
// for "[deviceAuth]" to see which one fired for a given incident.
export function requireDevice(allowedTypes) {
  const allowed = Array.isArray(allowedTypes) && allowedTypes.length
    ? allowedTypes
    : ['kds', 'bar', 'expo'];
  return async (req, res, next) => {
    const host = req.headers['host'] || 'unknown-host';
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      console.warn(`[deviceAuth] no bearer token — host=${host} path=${req.path}`);
      return res.status(401).json({ error: 'Device authentication required' });
    }
    let decoded;
    try {
      decoded = jwt.verify(header.slice(7), JWT_SECRET);
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        console.warn(`[deviceAuth] token expired — host=${host} path=${req.path}`);
        return res.status(401).json({ error: 'Device token expired' });
      }
      console.warn(`[deviceAuth] invalid token (${err.name}: ${err.message}) — host=${host} path=${req.path}`);
      return res.status(401).json({ error: 'Invalid device token' });
    }
    if (decoded.type !== 'device') {
      console.warn(`[deviceAuth] wrong token type=${decoded.type} deviceId=${decoded.deviceId} — host=${host}`);
      return res.status(401).json({ error: 'Not a device token' });
    }
    const currentTenant = req.tenant?.id;
    if (!currentTenant || decoded.tenantId !== currentTenant) {
      console.warn(
        `[deviceAuth] tenant mismatch deviceId=${decoded.deviceId} tokenTenant=${decoded.tenantId} ` +
        `resolvedTenant=${currentTenant ?? 'none'} host=${host} — likely a subdomain/host resolution ` +
        `issue, NOT a revoke; the device's token is still otherwise valid`
      );
      return res.status(403).json({ error: 'Device does not match this tenant' });
    }
    if (!allowed.includes(decoded.deviceType)) {
      console.warn(`[deviceAuth] device type not permitted deviceId=${decoded.deviceId} type=${decoded.deviceType} allowed=${allowed} host=${host}`);
      return res.status(403).json({ error: 'Device type not permitted' });
    }
    const device = await get(
      `SELECT id, device_label, device_type, token_jti, revoked_at
       FROM kds_devices WHERE id = $1`,
      [decoded.deviceId]
    );
    if (!device) {
      console.warn(`[deviceAuth] deviceId=${decoded.deviceId} not found in kds_devices (row deleted?) — host=${host}`);
      return res.status(401).json({ error: 'Device revoked' });
    }
    if (device.revoked_at) {
      console.warn(`[deviceAuth] deviceId=${decoded.deviceId} label="${device.device_label || ''}" is revoked (revoked_at=${device.revoked_at}) — host=${host}`);
      return res.status(401).json({ error: 'Device revoked' });
    }
    if (device.token_jti !== decoded.jti) {
      console.warn(
        `[deviceAuth] deviceId=${decoded.deviceId} label="${device.device_label || ''}" token superseded ` +
        `(tokenJti=${decoded.jti} currentJti=${device.token_jti}) — device was re-claimed/re-paired ` +
        `since this browser got its token — host=${host}`
      );
      return res.status(401).json({ error: 'Device token superseded' });
    }
    req.device = device;
    // Best-effort heartbeat; never block the request.
    run(
      `UPDATE kds_devices
       SET last_seen_at = NOW(), last_seen_ip = $2, user_agent = $3
       WHERE id = $1`,
      [device.id, req.ip || null, (req.headers['user-agent'] || '').slice(0, 500)]
    ).catch(() => {});
    next();
  };
}
