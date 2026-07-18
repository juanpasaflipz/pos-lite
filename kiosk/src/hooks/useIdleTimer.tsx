import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

// Kiosk idle handling. Screens call `useIdleTimer(onIdle, timeoutMs)`, then
// render `{warning}` from the return value so the countdown surfaces at the
// portal level (fixed overlay, works regardless of the screen's own layout).
//
// Behavior: after `timeoutMs - WARNING_MS` of silence we show a full-screen
// "Tu sesión se cerrará en X" overlay. Any tap/click/key on the document (the
// overlay's "Sigo aquí" button included) resets both timers and hides the
// overlay. If the customer really has walked away, the countdown hits 0 and
// `onIdle` fires — same behavior as before, now with a heads-up.

const WARNING_MS = 15_000;
const BLINK_THRESHOLD_S = 5;

export function useIdleTimer(onIdle: () => void, timeoutMs: number) {
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const idleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const warnRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onIdleRef = useRef(onIdle);
  onIdleRef.current = onIdle;

  useEffect(() => {
    const clearAll = () => {
      if (idleRef.current) clearTimeout(idleRef.current);
      if (warnRef.current) clearTimeout(warnRef.current);
      if (tickRef.current) clearInterval(tickRef.current);
      idleRef.current = null;
      warnRef.current = null;
      tickRef.current = null;
    };

    const startWarning = () => {
      const total = Math.ceil(WARNING_MS / 1000);
      setSecondsLeft(total);
      tickRef.current = setInterval(() => {
        setSecondsLeft((s) => (s === null ? null : Math.max(0, s - 1)));
      }, 1000);
      idleRef.current = setTimeout(() => {
        clearAll();
        setSecondsLeft(null);
        onIdleRef.current();
      }, WARNING_MS);
    };

    const reset = () => {
      clearAll();
      setSecondsLeft(null);
      if (timeoutMs <= WARNING_MS) {
        // Short timeout — no room for a pre-warning; behave like the legacy hook.
        idleRef.current = setTimeout(() => onIdleRef.current(), timeoutMs);
      } else {
        warnRef.current = setTimeout(startWarning, timeoutMs - WARNING_MS);
      }
    };

    reset();
    const events: (keyof DocumentEventMap)[] = ['touchstart', 'click', 'keydown'];
    events.forEach((e) => document.addEventListener(e, reset, { passive: true }));

    return () => {
      clearAll();
      events.forEach((e) => document.removeEventListener(e, reset));
    };
  }, [timeoutMs]);

  const warning = secondsLeft !== null ? (
    <IdleWarningOverlay seconds={secondsLeft} />
  ) : null;
  return { warning };
}

interface IdleWarningOverlayProps {
  seconds: number;
}

const IdleWarningOverlay: React.FC<IdleWarningOverlayProps> = ({ seconds }) => {
  const { t } = useTranslation();
  const blink = seconds <= BLINK_THRESHOLD_S;
  const content = (
    <div
      className={`fixed inset-0 z-[9999] flex items-center justify-center bg-black/85 backdrop-blur-sm p-8 ${blink ? 'motion-safe:animate-pulse' : ''}`}
    >
      <div
        className={`w-full max-w-lg rounded-3xl border-4 p-10 text-center bg-neutral-900 ${
          blink ? 'border-red-500' : 'border-brand-500'
        }`}
      >
        <p className="text-2xl font-black text-white/85">{t('idle.closesIn')}</p>
        <p
          className={`mt-4 text-[160px] leading-none font-black tabular-nums ${
            blink ? 'text-red-400' : 'text-brand-300'
          }`}
        >
          {seconds}
        </p>
        <p className="mt-2 text-2xl font-black text-white/70">
          {t('idle.second', { count: seconds })}
        </p>
        <button
          type="button"
          onClick={() => { /* click handler is a no-op — document listener resets the timer */ }}
          className="mt-10 w-full h-20 rounded-2xl bg-brand-600 active:bg-brand-700 text-white text-3xl font-black touch-manipulation"
        >
          {t('idle.stillHere')}
        </button>
      </div>
    </div>
  );
  return createPortal(content, document.body);
};
