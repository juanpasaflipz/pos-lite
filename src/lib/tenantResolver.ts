/**
 * Single source of truth for frontend tenant detection.
 * Mirrors backend RESERVED_SUBDOMAINS from server/middleware/tenant.js.
 */

const RESERVED_SUBDOMAINS = new Set([
  'pos', 'app', 'api', 'admin', 'www', 'es', 'docs', 'staging',
]);

const PLATFORM_DOMAIN = 'desktop.kitchen';

export type TenantMode = 'platform' | 'tenant' | 'local';

export interface TenantInfo {
  mode: TenantMode;
  tenantSlug: string | null;
  isPlatformHost: boolean;
}

/**
 * Resolve the current tenant context from the URL / environment.
 *
 * - Production subdomain (e.g. acme.desktop.kitchen): mode='tenant'
 * - Platform host (pos.desktop.kitchen): mode='platform'
 * - Localhost / Capacitor: mode='local' or 'tenant' based on localStorage
 */
export function resolveTenant(): TenantInfo {
  const hostname = window.location.hostname;

  // Capacitor native or localhost
  if (hostname === 'localhost' || hostname === '127.0.0.1' || (window as any).Capacitor?.isNativePlatform?.()) {
    const storedTenantId = localStorage.getItem('tenant_id');
    if (storedTenantId) {
      return { mode: 'tenant', tenantSlug: storedTenantId, isPlatformHost: false };
    }
    return { mode: 'local', tenantSlug: null, isPlatformHost: false };
  }

  // Production: check for subdomain
  const parts = hostname.split('.');
  if (parts.length >= 3 && hostname.endsWith(`.${PLATFORM_DOMAIN}`)) {
    const subdomain = parts[0];
    if (RESERVED_SUBDOMAINS.has(subdomain)) {
      // pos.desktop.kitchen, www.desktop.kitchen, etc.
      return { mode: 'platform', tenantSlug: null, isPlatformHost: true };
    }
    // acme.desktop.kitchen
    return { mode: 'tenant', tenantSlug: subdomain, isPlatformHost: false };
  }

  // Bare desktop.kitchen or unknown host — treat as platform
  return { mode: 'platform', tenantSlug: null, isPlatformHost: true };
}

/**
 * Build the full URL for a tenant subdomain.
 */
export function tenantUrl(slug: string): string {
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    return window.location.origin; // stay on localhost
  }
  return `https://${slug}.${PLATFORM_DOMAIN}`;
}

/**
 * Redirect the browser to a tenant's subdomain.
 * On localhost, sets localStorage and reloads instead.
 */
export function redirectToTenant(slug: string): void {
  const hostname = window.location.hostname;
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    localStorage.setItem('tenant_id', slug);
    window.location.reload();
    return;
  }
  window.location.href = `https://${slug}.${PLATFORM_DOMAIN}`;
}
