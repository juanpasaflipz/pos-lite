import { useEffect, useRef, useState, useCallback } from 'react';

const ACTIVITY_EVENTS = ['mousedown', 'keydown', 'touchstart', 'wheel'] as const;

interface UseIdleLogoutOptions {
  enabled: boolean;
  idleMs: number;
  warningMs: number;
  onLogout: () => void;
}

export function useIdleLogout({ enabled, idleMs, warningMs, onLogout }: UseIdleLogoutOptions) {
  const [warningRemaining, setWarningRemaining] = useState<number | null>(null);
  const resetRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!enabled) {
      setWarningRemaining(null);
      resetRef.current = () => {};
      return;
    }

    let idleSince = Date.now();
    let lastDisplayedMs: number | null = null;

    const reset = () => {
      idleSince = Date.now();
      if (lastDisplayedMs !== null) {
        lastDisplayedMs = null;
        setWarningRemaining(null);
      }
    };
    resetRef.current = reset;

    const tick = () => {
      const remaining = idleMs - (Date.now() - idleSince);
      if (remaining <= 0) {
        lastDisplayedMs = null;
        setWarningRemaining(null);
        onLogout();
        return;
      }
      if (remaining <= warningMs) {
        const rounded = Math.ceil(remaining / 1000) * 1000;
        if (rounded !== lastDisplayedMs) {
          lastDisplayedMs = rounded;
          setWarningRemaining(rounded);
        }
      } else if (lastDisplayedMs !== null) {
        lastDisplayedMs = null;
        setWarningRemaining(null);
      }
    };

    const intervalId = window.setInterval(tick, 250);
    ACTIVITY_EVENTS.forEach((e) => window.addEventListener(e, reset, { passive: true }));

    return () => {
      window.clearInterval(intervalId);
      ACTIVITY_EVENTS.forEach((e) => window.removeEventListener(e, reset));
      resetRef.current = () => {};
    };
  }, [enabled, idleMs, warningMs, onLogout]);

  const dismissWarning = useCallback(() => resetRef.current(), []);

  return { warningRemaining, dismissWarning };
}
