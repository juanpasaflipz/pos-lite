import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { IdentifyResult, KioskSuggestions, StampStatus } from '../lib/kioskApi';

/**
 * One customer's ordering session: who they are, their loyalty status, and the
 * personalized suggestions returned by /identify. Deliberately NOT persisted —
 * it lives only from the welcome screen through the confirmation screen, then
 * AttractScreen clears it so the next customer starts fresh.
 */
export interface CustomerSession {
  customerId: number;
  name: string;
  firstName: string;
  customerToken: string;
  isNew: boolean;
  aiPowered: boolean;
  visitCount: number;
  stamp: StampStatus | null;
  suggestions: KioskSuggestions;
}

interface KioskCustomerState {
  session: CustomerSession | null;
  setSessionFromIdentify: (result: IdentifyResult) => CustomerSession | null;
  clearSession: () => void;
}

const Ctx = createContext<KioskCustomerState | null>(null);

const EMPTY_SUGGESTIONS: KioskSuggestions = {
  usual: null,
  for_you: [],
  house: null,
  popular: [],
};

export const KioskCustomerProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [session, setSession] = useState<CustomerSession | null>(null);

  const setSessionFromIdentify = useCallback((result: IdentifyResult): CustomerSession | null => {
    if (!result.found || !result.customer || !result.customer_token) {
      return null;
    }
    const next: CustomerSession = {
      customerId: result.customer.id,
      name: result.customer.name,
      firstName: result.customer.first_name || result.customer.name,
      customerToken: result.customer_token,
      isNew: !!result.is_new,
      aiPowered: !!result.ai_powered,
      visitCount: result.visit_count || 0,
      stamp: result.stamp || null,
      suggestions: result.suggestions || EMPTY_SUGGESTIONS,
    };
    setSession(next);
    return next;
  }, []);

  const clearSession = useCallback(() => setSession(null), []);

  const value = useMemo(
    () => ({ session, setSessionFromIdentify, clearSession }),
    [session, setSessionFromIdentify, clearSession],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
};

export const useKioskCustomer = (): KioskCustomerState => {
  const v = useContext(Ctx);
  if (!v) throw new Error('useKioskCustomer must be used inside KioskCustomerProvider');
  return v;
};
