import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { resolveTenant } from '../lib/tenantResolver';

export interface BrandingConfig {
  logoUrl?: string;
  restaurantName?: string;
  tagline?: string;
  address?: string;
}

interface BrandingContextType {
  branding: BrandingConfig | null;
  isLoaded: boolean;
  setBranding: (config: BrandingConfig) => void;
  refresh: () => Promise<void>;
}

const BrandingContext = createContext<BrandingContextType | undefined>(undefined);

export const BrandingProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [branding, setBrandingState] = useState<BrandingConfig | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);

  const setBranding = useCallback((config: BrandingConfig) => {
    setBrandingState(config);
  }, []);

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
        setBranding({
          logoUrl: data.logoUrl,
          restaurantName: data.restaurantName,
          tagline: data.tagline,
          address: data.address,
        });
        setIsLoaded(true);
        return true;
      }
    } catch {
      // Server unreachable
    }
    return false;
  }, [setBranding]);

  const refresh = useCallback(async () => {
    await fetchBranding();
  }, [fetchBranding]);

  useEffect(() => {
    let cancelled = false;

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

      try {
        const cached = localStorage.getItem('branding');
        if (!cancelled && cached) {
          const parsed = JSON.parse(cached);
          setBranding(parsed);
          setIsLoaded(true);
          return;
        }
      } catch {
        // Invalid cache — ignore
      }

      if (!cancelled) setIsLoaded(true);
    }

    loadBranding();
    return () => { cancelled = true; };
  }, [fetchBranding, setBranding]);

  useEffect(() => {
    if (branding) {
      try {
        localStorage.setItem('branding', JSON.stringify(branding));
      } catch {
        // Storage full — non-critical
      }
    }
  }, [branding]);

  useEffect(() => {
    const { mode } = resolveTenant();
    if (mode === 'platform' || mode === 'local') {
      document.title = 'Desktop Kitchen';
    } else if (branding?.restaurantName) {
      document.title = `${branding.restaurantName} POS`;
    }
  }, [branding?.restaurantName]);

  return (
    <BrandingContext.Provider value={{ branding, isLoaded, setBranding, refresh }}>
      {children}
    </BrandingContext.Provider>
  );
};

export const useBranding = (): BrandingContextType => {
  const ctx = useContext(BrandingContext);
  if (!ctx) throw new Error('useBranding must be used within BrandingProvider');
  return ctx;
};
