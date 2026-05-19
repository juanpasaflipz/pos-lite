import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useKioskBinding } from './KioskBindingContext';
import {
  fetchModifierMap,
  fetchPopular,
  type KioskModifierMap,
  type SuggestionItem,
} from '../lib/kioskApi';

/**
 * Device-scoped data that both the menu and cart screens consume:
 *   - modifierMap: every menu item's attached modifier groups, so any surface
 *     can decide whether tapping an item opens the modifier modal.
 *   - anonPopular: time-of-day popular picks for customers without a session.
 *     For known customers, suggestions come from session.suggestions instead;
 *     anonPopular is the fallback the cart upsell strip uses for walk-ins.
 *
 * Fetched once per kiosk binding so each screen doesn't re-request.
 */
interface KioskSuggestionsState {
  modifierMap: KioskModifierMap;
  anonPopular: SuggestionItem[];
  loading: boolean;
}

const Ctx = createContext<KioskSuggestionsState | null>(null);

export const KioskSuggestionsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { tenantId, kioskToken } = useKioskBinding();
  const [modifierMap, setModifierMap] = useState<KioskModifierMap>({});
  const [anonPopular, setAnonPopular] = useState<SuggestionItem[]>([]);
  const [loading, setLoading] = useState(false);

  const auth = useMemo(
    () => (tenantId && kioskToken ? { tenantId, kioskToken } : null),
    [tenantId, kioskToken],
  );

  useEffect(() => {
    if (!auth) {
      setModifierMap({});
      setAnonPopular([]);
      return;
    }
    let alive = true;
    setLoading(true);
    Promise.all([
      fetchModifierMap(auth).catch(() => ({}) as KioskModifierMap),
      fetchPopular(auth).catch(() => [] as SuggestionItem[]),
    ])
      .then(([mods, popular]) => {
        if (!alive) return;
        setModifierMap(mods);
        setAnonPopular(popular);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [auth]);

  const value = useMemo(
    () => ({ modifierMap, anonPopular, loading }),
    [modifierMap, anonPopular, loading],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
};

export const useKioskSuggestions = (): KioskSuggestionsState => {
  const v = useContext(Ctx);
  if (!v) throw new Error('useKioskSuggestions must be used inside KioskSuggestionsProvider');
  return v;
};
