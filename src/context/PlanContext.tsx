import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';

export type PlanTier = 'free' | 'pro';

export interface PlanLimits {
  menuItems: number;
  inventoryItems: number;
  employees: number;
  modifierGroups: number;
  combos: number;
  maxBankConnections: number;
  reports: { editVariables: boolean };
  reportsHistoryDays: number;
  ai: { mode: 'none' | 'full'; dailySuggestions: number; monthlyAnalyses: number };
  printers: { functional: boolean; max: number };
  kiosk: { functional: boolean };
  qrOrdering: { functional: boolean };
  kdsDevices: { max: number; stations: string[] };
  delivery: { functional: boolean };
  permissions: { locked: boolean };
  loyalty: { locked: boolean; smsEnabled: boolean };
  branding: { canRename: boolean; watermark: boolean };
  prepForecast: { locked: boolean };
  inventoryTwoStage: { locked: boolean };
  menuBoard: { canRenameBrands: boolean };
  dynamicPricing: { aiSuggestions: boolean; scheduledRules: boolean; priceHistory: boolean; guardrails: boolean; abTesting: boolean; deliveryIntegration: boolean };
  banking: { locked: boolean };
  bankReconciliation: { locked: boolean };
  dataExport: { locked: boolean };
  cfdi: { locked: boolean };
}

/** Non-integrated bank terminal (Inbursa, BBVA, ...) registered for this tenant. */
export interface ExternalTerminalRef {
  id: number;
  name: string;
}

interface PlanContextType {
  plan: PlanTier;
  limits: PlanLimits;
  /** Non-null while the signup's full-Pro trial is active (plan reads 'pro'). */
  trialEndsAt: string | null;
  /** Whole days left in the trial (>= 1 while active), or null. */
  trialDaysLeft: number | null;
  isTrial: boolean;
  ownerEmail: string | null;
  mpUserId: string | null;
  mpDefaultTerminalId: string | null;
  timezone: string;
  weekStartDow: number;
  isPaid: boolean;
  isFree: boolean;
  isMpConnected: boolean;
  isGetnetConfigured: boolean;
  isGetnetEnabled: boolean;
  isClipConfigured: boolean;
  /** Active non-integrated bank terminals (empty when none registered). */
  externalTerminals: ExternalTerminalRef[];
  isAtLimit: (resource: 'menuItems' | 'inventoryItems' | 'employees' | 'modifierGroups' | 'combos', currentCount: number) => boolean;
  isFeatureLocked: (feature: 'printers' | 'delivery' | 'permissions' | 'loyalty' | 'prepForecast' | 'inventoryTwoStage' | 'banking' | 'bankReconciliation' | 'dataExport' | 'cfdi' | 'ai' | 'kiosk' | 'qrOrdering') => boolean;
  refresh: () => Promise<void>;
}

const DEFAULT_LIMITS: PlanLimits = {
  menuItems: Infinity, inventoryItems: Infinity, employees: 3,
  modifierGroups: Infinity, combos: Infinity, maxBankConnections: 0,
  reports: { editVariables: false },
  reportsHistoryDays: 7,
  ai: { mode: 'none', dailySuggestions: 0, monthlyAnalyses: 0 },
  printers: { functional: true, max: Infinity },
  kiosk: { functional: false },
  qrOrdering: { functional: false },
  kdsDevices: { max: 1, stations: ['kds'] },
  delivery: { functional: false },
  permissions: { locked: false },
  loyalty: { locked: false, smsEnabled: false },
  branding: { canRename: true, watermark: true },
  prepForecast: { locked: true },
  inventoryTwoStage: { locked: true },
  menuBoard: { canRenameBrands: true },
  dynamicPricing: { aiSuggestions: false, scheduledRules: false, priceHistory: false, guardrails: false, abTesting: false, deliveryIntegration: false },
  banking: { locked: true },
  bankReconciliation: { locked: true },
  dataExport: { locked: true },
  cfdi: { locked: true },
};

const PlanContext = createContext<PlanContextType | undefined>(undefined);

export function PlanProvider({ children }: { children: ReactNode }) {
  const [plan, setPlan] = useState<PlanTier>('free');
  const [limits, setLimits] = useState<PlanLimits>(DEFAULT_LIMITS);
  const [trialEndsAt, setTrialEndsAt] = useState<string | null>(null);
  const [ownerEmail, setOwnerEmail] = useState<string | null>(null);
  const [mpUserId, setMpUserId] = useState<string | null>(null);
  const [mpDefaultTerminalId, setMpDefaultTerminalId] = useState<string | null>(null);
  const [getnetConfigured, setGetnetConfigured] = useState(false);
  const [getnetEnabled, setGetnetEnabled] = useState(false);
  const [clipConfigured, setClipConfigured] = useState(false);
  const [externalTerminals, setExternalTerminals] = useState<ExternalTerminalRef[]>([]);
  const [timezone, setTimezone] = useState<string>('UTC');
  // 0=Sun..6=Sat. Default Monday — matches payroll_settings.period_start_dow default.
  const [weekStartDow, setWeekStartDow] = useState<number>(1);

  const fetchPlan = useCallback(async () => {
    try {
      const isCapacitor = !!(window as any).Capacitor?.isNativePlatform?.();
      const tenantSlug = localStorage.getItem('tenant_id');
      const baseUrl = isCapacitor && tenantSlug
        ? `https://${tenantSlug}.desktop.kitchen/api`
        : '/api';
      const headers: Record<string, string> = {};
      if (!isCapacitor && tenantSlug) headers['X-Tenant-ID'] = tenantSlug;
      const res = await fetch(`${baseUrl}/branding`, { headers });
      if (res.ok) {
        const data = await res.json();
        if (data.plan) setPlan(data.plan === 'pro' ? 'pro' : 'free');
        if (data.limits) setLimits(data.limits);
        setTrialEndsAt(typeof data.trialEndsAt === 'string' ? data.trialEndsAt : null);
        if (data.ownerEmail !== undefined) setOwnerEmail(data.ownerEmail);
        if (data.mpUserId !== undefined) setMpUserId(data.mpUserId);
        if (data.mpDefaultTerminalId !== undefined) setMpDefaultTerminalId(data.mpDefaultTerminalId);
        if (data.getnetConfigured !== undefined) setGetnetConfigured(data.getnetConfigured);
        if (data.getnetEnabled !== undefined) setGetnetEnabled(data.getnetEnabled);
        if (data.clipConfigured !== undefined) setClipConfigured(data.clipConfigured);
        if (Array.isArray(data.externalTerminals)) setExternalTerminals(data.externalTerminals);
        if (typeof data.timezone === 'string' && data.timezone) setTimezone(data.timezone);
        if (typeof data.weekStartDow === 'number' && data.weekStartDow >= 0 && data.weekStartDow <= 6) {
          setWeekStartDow(data.weekStartDow);
        }
      }
    } catch {
      // Server unreachable — keep defaults
    }
  }, []);

  useEffect(() => { fetchPlan(); }, [fetchPlan]);

  const isPaid = plan === 'pro';
  const isFree = plan === 'free';
  const trialMsLeft = trialEndsAt ? new Date(trialEndsAt).getTime() - Date.now() : 0;
  const isTrial = plan === 'pro' && trialMsLeft > 0;
  const trialDaysLeft = isTrial ? Math.max(1, Math.ceil(trialMsLeft / 86_400_000)) : null;
  const isMpConnected = !!mpUserId && plan === 'pro';
  const isGetnetConfigured = getnetConfigured;
  const isGetnetEnabled = getnetEnabled;
  const isClipConfigured = clipConfigured;

  const isAtLimit = useCallback((resource: string, currentCount: number) => {
    const max = (limits as unknown as Record<string, unknown>)[resource];
    if (typeof max !== 'number') return false;
    return currentCount >= max;
  }, [limits]);

  const isFeatureLocked = useCallback((feature: string) => {
    const cfg = (limits as unknown as Record<string, unknown>)[feature];
    if (!cfg || typeof cfg !== 'object') return false;
    const obj = cfg as Record<string, unknown>;
    // AI: mode 'none' means locked
    if ('mode' in obj) return obj.mode === 'none';
    if ('locked' in obj) return obj.locked as boolean;
    if ('functional' in obj) return !(obj.functional as boolean);
    return false;
  }, [limits]);

  return (
    <PlanContext.Provider value={{ plan, limits, trialEndsAt, trialDaysLeft, isTrial, ownerEmail, mpUserId, mpDefaultTerminalId, timezone, weekStartDow, isPaid, isFree, isMpConnected, isGetnetConfigured, isGetnetEnabled, isClipConfigured, externalTerminals, isAtLimit, isFeatureLocked, refresh: fetchPlan }}>
      {children}
    </PlanContext.Provider>
  );
}

export const usePlan = (): PlanContextType => {
  const ctx = useContext(PlanContext);
  if (!ctx) throw new Error('usePlan must be used within PlanProvider');
  return ctx;
};
