import { useEffect, useRef } from 'react';
import { registerUpdateBlocker } from '../lib/appUpdate';

/**
 * While `busy` is true, this surface will not be auto-reloaded for an app
 * update. Use it for anything a reload would destroy: an open cart, a payment
 * in flight, tickets on the kitchen screen.
 *
 * The banner's manual "Update now" button deliberately ignores blockers — that
 * is an explicit choice by whoever clicked it.
 */
export function useUpdateBlocker(busy: boolean): void {
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useEffect(() => registerUpdateBlocker(() => busyRef.current), []);
}
