import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { generatePalette, applyBrandPalette, resetBrandPalette, type BrandPalette } from '../lib/colorUtils';
import { resolveTenant } from '../lib/tenantResolver';

export interface BrandingConfig {
  primaryColor: string;
  logoUrl?: string;
  restaurantName?: string;
  tagline?: string;
  address?: string;
}

interface BrandingContextType {
  branding: BrandingConfig | null;
  palette: BrandPalette | null;
  isLoaded: boolean;
  setBranding: (config: BrandingConfig) => void;
  refresh: () => Promise<void>;
}

const BrandingContext = createContext<BrandingContextType | undefined>(undefined);

const DEFAULT_PRIMARY = '#0d9488';

export const BrandingProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [branding, setBrandingState] = useState<BrandingConfig | null>(null);
  const [palette, setPalette] = useState<BrandPalette | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);

  // Apply branding and generate palette
  const setBranding = useCallback((config: BrandingConfig) => {
    setBrandingState(config);
    const p = generatePalette(config.primaryColor || DEFAULT_PRIMARY);
    setPalette(p);
    applyBrandPalette(p);
  }, []);

  // Fetch branding from server
  const fetchBranding = useCallback(async () => {
    try {
      const isCapacitor = !!(window as any).Capacitor?.isNativePlatform?.();
      const tenantSlug = localStorage.getItem('tenant_id');
      const baseUrl = isCapacitor
        ? (tenantSlug ? `https://${tenantSlug}.desktop.kitchen/api` : 'https://pos.desktop.kitchen/api')
        : '/api';
      const headers: Record<string, string> = {};
      if (!isCapacitor && tenantSlug) headers['X-Tenant-ID'] = tenantSlug;
      const res = await fetch(`${baseUrl}/branding`, { headers });
      if (res.ok) {
        const data = await res.json();
        if (data.primaryColor) {
          setBranding(data);
          setIsLoaded(true);
          return true;
        }
      }
    } catch {
      // Server unreachable
    }
    return false;
  }, [setBranding]);

  // Refresh branding from server (called after saving settings)
  const refresh = useCallback(async () => {
    await fetchBranding();
  }, [fetchBranding]);

  // Fetch branding from server on mount (skip on platform/local mode — keep teal defaults)
  useEffect(() => {
    let cancelled = false;

    // Ensure teal defaults are applied immediately (clears any stale CSS variables)
    resetBrandPalette();

    const { mode } = resolveTenant();
    const isCapacitorNative = !!(window as any).Capacitor?.isNativePlatform?.();
    if ((mode === 'platform' || mode === 'local') && !isCapacitorNative) {
      setIsLoaded(true);
      return;
    }

    async function loadBranding() {
      const fetched = await fetchBranding();
      if (cancelled) return;
      if (fetched) return;

      // Check localStorage for cached branding
      try {
        const cached = localStorage.getItem('branding');
        if (!cancelled && cached) {
          const parsed = JSON.parse(cached);
          if (parsed.primaryColor) {
            setBranding(parsed);
            setIsLoaded(true);
            return;
          }
        }
      } catch {
        // Invalid cache — ignore
      }

      // Fall back to defaults
      if (!cancelled) {
        resetBrandPalette();
        setIsLoaded(true);
      }
    }

    loadBranding();
    return () => { cancelled = true; };
  }, [fetchBranding, setBranding]);

  // Cache branding to localStorage whenever it changes
  useEffect(() => {
    if (branding) {
      try {
        localStorage.setItem('branding', JSON.stringify(branding));
      } catch {
        // Storage full — non-critical
      }
    }
  }, [branding]);

  // Update document title with restaurant name
  useEffect(() => {
    const { mode } = resolveTenant();
    if (mode === 'platform' || mode === 'local') {
      document.title = 'Desktop Kitchen';
    } else if (branding?.restaurantName) {
      document.title = `${branding.restaurantName} POS`;
    }
  }, [branding?.restaurantName]);

  return (
    <BrandingContext.Provider value={{ branding, palette, isLoaded, setBranding, refresh }}>
      {children}
    </BrandingContext.Provider>
  );
};

export const useBranding = (): BrandingContextType => {
  const ctx = useContext(BrandingContext);
  if (!ctx) throw new Error('useBranding must be used within BrandingProvider');
  return ctx;
};
