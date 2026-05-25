import jwt from 'jsonwebtoken';
import { get, run } from '../db/index.js';
import { JWT_SECRET } from '../lib/constants.js';

// Verify a paired-device JWT. On success, attaches req.device and bumps
// last_seen_at. Tokens carry { type:'device', deviceId, tenantId,
// deviceType, jti } — jti is checked against the DB row, so rotating
// token_jti revokes the token instantly even though the JWT itself is
// long-lived.
export function requireDevice(allowedTypes) {
  const allowed = Array.isArray(allowedTypes) && allowedTypes.length
    ? allowedTypes
    : ['kds', 'bar', 'expo'];
  return async (req, res, next) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Device authentication required' });
    }
    let decoded;
    try {
      decoded = jwt.verify(header.slice(7), JWT_SECRET);
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({ error: 'Device token expired' });
      }
      return res.status(401).json({ error: 'Invalid device token' });
    }
    if (decoded.type !== 'device') {
      return res.status(401).json({ error: 'Not a device token' });
    }
    const currentTenant = req.tenant?.id;
    if (!currentTenant || decoded.tenantId !== currentTenant) {
      return res.status(403).json({ error: 'Device does not match this tenant' });
    }
    if (!allowed.includes(decoded.deviceType)) {
      return res.status(403).json({ error: 'Device type not permitted' });
    }
    const device = await get(
      `SELECT id, device_label, device_type, token_jti, revoked_at
       FROM kds_devices WHERE id = $1`,
      [decoded.deviceId]
    );
    if (!device || device.revoked_at) {
      return res.status(401).json({ error: 'Device revoked' });
    }
    if (device.token_jti !== decoded.jti) {
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
