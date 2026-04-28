import { useEffect, useRef } from 'react';

export function useIdleTimer(onIdle: () => void, timeoutMs: number) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onIdleRef = useRef(onIdle);
  onIdleRef.current = onIdle;

  useEffect(() => {
    const reset = () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => onIdleRef.current(), timeoutMs);
    };

    reset();
    const events: (keyof DocumentEventMap)[] = ['touchstart', 'click', 'keydown'];
    events.forEach((e) => document.addEventListener(e, reset, { passive: true }));

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      events.forEach((e) => document.removeEventListener(e, reset));
    };
  }, [timeoutMs]);
}
