import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
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
 * Shared across screens; the menu screen calls refresh() on mount so a kiosk
 * that runs for days picks up modifier groups added after app boot — the menu
 * itself is refetched per visit, and an item that arrives without its groups
 * silently skips the options modal.
 */
interface KioskSuggestionsState {
  modifierMap: KioskModifierMap;
  anonPopular: SuggestionItem[];
  loading: boolean;
  refresh: () => void;
}

const Ctx = createContext<KioskSuggestionsState | null>(null);

export const KioskSuggestionsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { tenantId, kioskToken } = useKioskBinding();
  const [modifierMap, setModifierMap] = useState<KioskModifierMap>({});
  const [anonPopular, setAnonPopular] = useState<SuggestionItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const auth = useMemo(
    () => (tenantId && kioskToken ? { tenantId, kioskToken } : null),
    [tenantId, kioskToken],
  );

  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    if (!auth) {
      setModifierMap({});
      setAnonPopular([]);
      return;
    }
    let alive = true;
    setLoading(true);
    // A failed fetch resolves null and keeps the last-known-good data — a
    // transient blip must not wipe the modifier map mid-shift.
    Promise.all([
      fetchModifierMap(auth).catch(() => null),
      fetchPopular(auth).catch(() => null),
    ])
      .then(([mods, popular]) => {
        if (!alive) return;
        if (mods) setModifierMap(mods);
        if (popular) setAnonPopular(popular);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [auth, reloadKey]);

  const value = useMemo(
    () => ({ modifierMap, anonPopular, loading, refresh }),
    [modifierMap, anonPopular, loading, refresh],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
};

export const useKioskSuggestions = (): KioskSuggestionsState => {
  const v = useContext(Ctx);
  if (!v) throw new Error('useKioskSuggestions must be used inside KioskSuggestionsProvider');
  return v;
};
