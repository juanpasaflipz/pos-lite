import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { setKioskAuthFailureHandler, setKioskPlanLockHandler, fetchKioskConfig, type KioskMode } from '../lib/kioskApi';

interface BindingPayload {
  tenant_id: string;
  tenant_name: string;
  kiosk_token: string;
  device_id?: string;
}

// Each kiosk device can pair to its own MP Point terminal so two kiosks at the
// counter don't race to the same device. Stored on this device only — separate
// from `mp_default_terminal_id` (tenant-wide fallback for un-paired kiosks).
interface TerminalPairing {
  id: string;
  label: string;
}

interface BindingState {
  tenantId: string | null;
  tenantName: string | null;
  kioskToken: string | null;
  deviceId: string | null;
  terminalId: string | null;
  terminalLabel: string | null;
  /** True when the server said the kiosk is not in the tenant's plan
   *  (403 PLAN_UPGRADE_REQUIRED). Binding is kept; UI shows unavailable. */
  planLocked: boolean;
  /** Effective kiosk mode for THIS device (device override ?? tenant mode).
   *  Default 'grid' before the first /api/kiosk/config response resolves, so a
   *  slow first poll never accidentally shows the wizard on a grid device. */
  kioskMode: KioskMode;
  clearPlanLock: () => void;
  bind: (payload: BindingPayload) => void;
  unbind: () => void;
  setTerminal: (pairing: TerminalPairing | null) => void;
}

const BINDING_KEY = 'kiosk-binding-v1';
const TERMINAL_KEY = 'kiosk-terminal-v1';

const Ctx = createContext<BindingState | null>(null);

function readStored<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export const KioskBindingProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [stored, setStored] = useState<BindingPayload | null>(() => readStored<BindingPayload>(BINDING_KEY));
  const [terminal, setTerminalState] = useState<TerminalPairing | null>(() => readStored<TerminalPairing>(TERMINAL_KEY));
  const [planLocked, setPlanLocked] = useState(false);
  const [kioskMode, setKioskMode] = useState<KioskMode>('grid');
  const configPollRef = useRef<number | null>(null);

  const bind = useCallback((payload: BindingPayload) => {
    localStorage.setItem(BINDING_KEY, JSON.stringify(payload));
    setStored(payload);
  }, []);

  const unbind = useCallback(() => {
    localStorage.removeItem(BINDING_KEY);
    localStorage.removeItem(TERMINAL_KEY);
    setStored(null);
    setTerminalState(null);
  }, []);

  useEffect(() => {
    setKioskAuthFailureHandler(() => {
      localStorage.removeItem(BINDING_KEY);
      localStorage.removeItem(TERMINAL_KEY);
      setStored(null);
      setTerminalState(null);
    });
    setKioskPlanLockHandler(() => setPlanLocked(true));
    return () => {
      setKioskAuthFailureHandler(null);
      setKioskPlanLockHandler(null);
    };
  }, []);

  // Poll /api/kiosk/config every 30s so a super-admin flip (grid ↔ wizard, or
  // set/clear a per-device override) propagates without a rebind. Skipped when
  // there's no binding, plan-locked (endpoint would 403), or on an offline gap
  // (silent failure — next tick retries).
  useEffect(() => {
    if (!stored?.tenant_id || !stored?.kiosk_token || planLocked) {
      if (configPollRef.current !== null) {
        clearInterval(configPollRef.current);
        configPollRef.current = null;
      }
      return;
    }
    const auth = { tenantId: stored.tenant_id, kioskToken: stored.kiosk_token };
    let cancelled = false;
    const tick = async () => {
      try {
        const cfg = await fetchKioskConfig(auth);
        if (!cancelled && (cfg.mode === 'grid' || cfg.mode === 'wizard')) {
          setKioskMode(cfg.mode);
        }
      } catch {
        // network/offline — keep last known mode
      }
    };
    tick();
    configPollRef.current = window.setInterval(tick, 30_000);
    return () => {
      cancelled = true;
      if (configPollRef.current !== null) {
        clearInterval(configPollRef.current);
        configPollRef.current = null;
      }
    };
  }, [stored?.tenant_id, stored?.kiosk_token, planLocked]);

  const setTerminal = useCallback((pairing: TerminalPairing | null) => {
    if (pairing) {
      localStorage.setItem(TERMINAL_KEY, JSON.stringify(pairing));
    } else {
      localStorage.removeItem(TERMINAL_KEY);
    }
    setTerminalState(pairing);
  }, []);

  return (
    <Ctx.Provider
      value={{
        tenantId: stored?.tenant_id ?? null,
        tenantName: stored?.tenant_name ?? null,
        kioskToken: stored?.kiosk_token ?? null,
        deviceId: stored?.device_id ?? null,
        terminalId: terminal?.id ?? null,
        terminalLabel: terminal?.label ?? null,
        planLocked,
        kioskMode,
        clearPlanLock: () => setPlanLocked(false),
        bind,
        unbind,
        setTerminal,
      }}
    >
      {children}
    </Ctx.Provider>
  );
};

export const useKioskBinding = (): BindingState => {
  const v = useContext(Ctx);
  if (!v) throw new Error('useKioskBinding must be used inside KioskBindingProvider');
  return v;
};
