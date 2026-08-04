import { useEffect, useState } from 'react';
import { getPrepRuns } from '../api';
import type { InventoryMode } from '../types';

// Which inventory model this tenant is on. Every tenant is 'ingredients' until
// an owner opts in, and in that mode none of the two-stage UI renders.
//
// Read from GET /api/prep-runs rather than a settings endpoint: nothing else
// carries tenant settings to an employee JWT (GET /api/account is owner-only),
// and the prep-runs list already has to answer for both modes. Module-scoped
// cache so the several screens that ask don't each pay a round-trip.
let cached: InventoryMode | null = null;
let inFlight: Promise<InventoryMode> | null = null;

async function fetchMode(): Promise<InventoryMode> {
  if (cached) return cached;
  if (!inFlight) {
    inFlight = getPrepRuns(1)
      .then((res) => {
        cached = res.mode === 'two_stage' ? 'two_stage' : 'ingredients';
        return cached;
      })
      .catch(() => 'ingredients' as InventoryMode)
      .finally(() => { inFlight = null; });
  }
  return inFlight;
}

/** Clear the cache after an owner flips the mode in Account settings. */
export function resetInventoryModeCache() {
  cached = null;
  inFlight = null;
}

export function useInventoryMode(): { mode: InventoryMode; isTwoStage: boolean; loading: boolean } {
  const [mode, setMode] = useState<InventoryMode>(cached ?? 'ingredients');
  const [loading, setLoading] = useState(cached === null);

  useEffect(() => {
    let alive = true;
    fetchMode().then((m) => {
      if (!alive) return;
      setMode(m);
      setLoading(false);
    });
    return () => { alive = false; };
  }, []);

  return { mode, isTwoStage: mode === 'two_stage', loading };
}
