import jwt from 'jsonwebtoken';
import { tenantContext, tenantSql } from '../db/index.js';
import { getTenant, getTenantBySubdomain } from '../tenants.js';
import { JWT_SECRET } from '../lib/constants.js';
import { effectivePlan } from '../planLimits.js';

// A valid kiosk JWT already proves the caller is bound to that specific tenant,
// so it can stand in for ADMIN_SECRET when authorizing an X-Tenant-ID header
// on the platform domain. Kiosks live on pos.desktop.kitchen (no tenant
// subdomain), so header-based tenant resolution is the only path they have.
function hasValidKioskTokenForTenant(req, tenantId) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return false;
  try {
    const decoded = jwt.verify(header.slice(7), JWT_SECRET);
    return decoded?.type === 'kiosk' && decoded?.tenantId === tenantId;
  } catch {
    return false;
  }
}

// Same idea for owner / employee JWTs: any token we signed that embeds this
// exact tenantId proves the caller is bound to that tenant, so it can
// authorize an X-Tenant-ID header on the platform domain. This is what lets
// the onboarding wizard (which runs on pos.desktop.kitchen, a reserved
// subdomain) write the new menu to the buyer's tenant instead of falling
// through to DEFAULT_TENANT_ID.
function hasValidTenantBoundToken(req, tenantId) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return false;
  try {
    const decoded = jwt.verify(header.slice(7), JWT_SECRET);
    if (!decoded?.tenantId || decoded.tenantId !== tenantId) return false;
    return decoded.type === 'owner' || decoded.type === 'employee' || decoded.employeeId != null;
  } catch {
    return false;
  }
}

// Subdomains that belong to the platform itself and should NOT be resolved as tenants.
const RESERVED_SUBDOMAINS = new Set([
  'pos', 'app', 'api', 'admin', 'www', 'es', 'docs', 'staging', 'sales',
]);

/**
 * Tenant resolution middleware (async, Postgres + RLS).
 *
 * Resolution order:
 *   1. X-Tenant-ID header (dev: unrestricted, production: requires admin secret)
 *   2. Subdomain from Host header (production)
 *   3. Default tenant from DEFAULT_TENANT_ID env var
 *   4. No tenant — REJECT in production, warn in dev
 */
export async function tenantMiddleware(req, res, next) {
  let tenantId = null;
  let tenant = null;

  try {
    // 1. Explicit header — dev: unrestricted; production: requires ADMIN_SECRET.
    // Without this gate, an anonymous caller on the platform domain could
    // impersonate any tenant by setting X-Tenant-ID, which combined with
    // unauthenticated routes turns into cross-tenant reach.
    const headerTenantId = req.headers['x-tenant-id'];
    if (headerTenantId) {
      // Enforce whenever we're in production OR an ADMIN_SECRET is configured.
      // Any real or staging deploy sets ADMIN_SECRET, so a mis-set NODE_ENV on a
      // network-reachable box can't silently unlock cross-tenant header access.
      // Pure local dev (no ADMIN_SECRET set) stays unrestricted for convenience.
      if (process.env.NODE_ENV === 'production' || process.env.ADMIN_SECRET) {
        const provided = req.headers['x-admin-secret'];
        const adminOk = process.env.ADMIN_SECRET && provided === process.env.ADMIN_SECRET;
        const kioskOk = hasValidKioskTokenForTenant(req, headerTenantId);
        const tokenOk = hasValidTenantBoundToken(req, headerTenantId);
        if (!adminOk && !kioskOk && !tokenOk) {
          return res.status(403).json({ error: 'X-Tenant-ID header requires admin secret' });
        }
      }
      tenant = await getTenant(headerTenantId);
      if (!tenant) return res.status(404).json({ error: `Tenant '${headerTenantId}' not found` });
      if (!tenant.active) return res.status(403).json({ error: 'Tenant account is inactive' });
      tenantId = tenant.id;
    }

    // 2. Subdomain resolution
    if (!tenantId) {
      const host = req.hostname || req.headers.host?.split(':')[0];
      if (host && host !== 'localhost' && host !== '127.0.0.1') {
        const parts = host.split('.');
        if (parts.length >= 3) {
          const subdomain = parts[0];
          if (!RESERVED_SUBDOMAINS.has(subdomain)) {
            tenant = await getTenantBySubdomain(subdomain);
            if (tenant) {
              if (!tenant.active) return res.status(403).json({ error: 'Tenant account is inactive' });
              tenantId = tenant.id;
            }
          }
        }
      }
    }

    // 3. Default tenant fallback
    if (!tenantId && process.env.DEFAULT_TENANT_ID) {
      tenant = await getTenant(process.env.DEFAULT_TENANT_ID);
      if (tenant && tenant.active) tenantId = tenant.id;
    }

    // 4. No tenant resolved
    if (!tenantId) {
      if (process.env.NODE_ENV !== 'production') {
        console.warn('[Tenant] No tenant resolved — proceeding without tenant scope (dev mode)');
        req.tenant = null;
        return next();
      }
      return res.status(401).json({ error: 'Could not resolve tenant. Check your subdomain or X-Tenant-ID header.' });
    }

    // Reserve a dedicated connection from the tenant pool (with timeout)
    let conn;
    try {
      conn = await Promise.race([
        tenantSql.reserve(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Connection pool exhausted')), 5000)
        ),
      ]);
    } catch (poolErr) {
      console.error('[Tenant] Connection pool exhausted:', poolErr.message);
      return res.status(503).json({ error: 'Service temporarily unavailable. Please try again.' });
    }

    // Double-release guard.
    //
    // We COMMIT only on successful responses (statusCode < 400). On 4xx/5xx
    // we ROLLBACK so that partial DML from a caught error (e.g. a route that
    // inserted an order row, then threw and responded 500) doesn't persist.
    // Without this, every route in the app was silently committing partial
    // state on errors.
    let released = false;
    const releaseConn = (shouldCommit) => {
      if (!released) {
        released = true;
        const finish = shouldCommit
          ? conn`COMMIT`.catch(() => conn`ROLLBACK`.catch(() => {}))
          : conn`ROLLBACK`.catch(() => {});
        finish.finally(() => conn.release());
      }
    };

    res.on('finish', () => releaseConn(res.statusCode < 400));
    res.on('close', () => {
      if (!res.writableFinished) releaseConn(false);
    });

    // Start explicit transaction + set tenant_id (PgBouncer-safe)
    try {
      await conn`BEGIN`;
      await conn`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    } catch (txErr) {
      console.error('[Tenant] Failed to initialize connection:', txErr.message);
      releaseConn(false);
      return res.status(503).json({ error: 'Service temporarily unavailable. Please try again.' });
    }

    // Effective plan: paid 'pro' wins; an active signup trial also grants
    // 'pro' (freemium launch). Everything downstream (planLimits gates,
    // /api/branding → PlanContext) reads this computed value.
    const plan = effectivePlan(tenant);

    req.tenant = {
      id: tenant.id,
      name: tenant.name,
      plan,
      stored_plan: (tenant.plan === 'pro') ? 'pro' : 'free',
      trial_ends_at: tenant.trial_ends_at || null,
      subscription_status: tenant.subscription_status,
      branding: tenant.branding_json ? JSON.parse(tenant.branding_json) : null,
      owner_email: tenant.owner_email || null,
      mp_user_id: tenant.mp_user_id || null,
      mp_default_terminal_id: tenant.mp_default_terminal_id || null,
      mp_default_kiosk_terminal_id: tenant.mp_default_kiosk_terminal_id || null,
      timezone: tenant.timezone || 'UTC',
      // Which inventory model this tenant runs on. Routes branch on it to
      // decide whether a sale consumes prepped portions at ring-up or raw
      // ingredients at payment (migration 0103).
      inventory_mode: tenant.inventory_mode || 'ingredients',
    };

    tenantContext.run({ conn, tenantId }, () => {
      next();
    });
  } catch (err) {
    console.error('[Tenant] Middleware error:', err.message);
    return res.status(500).json({ error: 'Tenant resolution failed' });
  }
}
