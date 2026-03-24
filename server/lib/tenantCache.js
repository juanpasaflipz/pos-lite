/**
 * Simple in-memory tenant cache with TTL.
 * Avoids hitting Postgres on every single API request for tenant resolution.
 */

const DEFAULT_TTL_MS = 60_000; // 60 seconds

class TenantCache {
  constructor(ttlMs = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
    this.byId = new Map();
    this.bySubdomain = new Map();
  }

  getById(id) {
    const entry = this.byId.get(id);
    if (!entry) return undefined;
    if (Date.now() - entry.ts > this.ttlMs) {
      this.byId.delete(id);
      return undefined;
    }
    return entry.value;
  }

  getBySubdomain(subdomain) {
    const entry = this.bySubdomain.get(subdomain);
    if (!entry) return undefined;
    if (Date.now() - entry.ts > this.ttlMs) {
      this.bySubdomain.delete(subdomain);
      return undefined;
    }
    return entry.value;
  }

  set(tenant) {
    if (!tenant) return;
    const entry = { value: tenant, ts: Date.now() };
    this.byId.set(tenant.id, entry);
    if (tenant.subdomain) {
      this.bySubdomain.set(tenant.subdomain, entry);
    }
  }

  invalidate(tenantId) {
    const entry = this.byId.get(tenantId);
    if (entry?.value?.subdomain) {
      this.bySubdomain.delete(entry.value.subdomain);
    }
    this.byId.delete(tenantId);
  }

  clear() {
    this.byId.clear();
    this.bySubdomain.clear();
  }
}

export const tenantCache = new TenantCache();
