import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { setKioskAuthFailureHandler } from '../lib/kioskApi';

interface BindingPayload {
  tenant_id: string;
  tenant_name: string;
  kiosk_token: string;
}

interface BindingState {
  tenantId: string | null;
  tenantName: string | null;
  kioskToken: string | null;
  bind: (payload: BindingPayload) => void;
  unbind: () => void;
}

const STORAGE_KEY = 'kiosk-binding-v1';

const Ctx = createContext<BindingState | null>(null);

function readStored(): BindingPayload | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as BindingPayload;
  } catch {
    return null;
  }
}

export const KioskBindingProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [stored, setStored] = useState<BindingPayload | null>(() => readStored());

  const bind = useCallback((payload: BindingPayload) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    setStored(payload);
  }, []);

  const unbind = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setStored(null);
  }, []);

  useEffect(() => {
    setKioskAuthFailureHandler(() => {
      localStorage.removeItem(STORAGE_KEY);
      setStored(null);
    });
    return () => setKioskAuthFailureHandler(null);
  }, []);

  return (
    <Ctx.Provider
      value={{
        tenantId: stored?.tenant_id ?? null,
        tenantName: stored?.tenant_name ?? null,
        kioskToken: stored?.kiosk_token ?? null,
        bind,
        unbind,
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
