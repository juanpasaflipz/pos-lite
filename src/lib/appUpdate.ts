/**
 * New-deploy detection for the POS/admin bundle.
 *
 * How a client learns a new version exists:
 *   1. Every /api response carries `X-App-Version`. Because every surface is
 *      already polling something, detection is effectively instant and costs
 *      no extra requests. See noteServerVersionHeaders().
 *   2. A 5-minute poll of /api/version as a floor, for screens that go quiet.
 *
 * How it gets the new version: a plain reload. index.html is served
 * network-first by the service worker and revalidated by the server, so one
 * reload pulls fresh HTML → new content-hashed asset URLs → new JS. No hard
 * reload, no cache clearing.
 *
 * When it reloads: never mid-work. Screens register blockers (an open cart, a
 * payment in flight, a non-empty KDS queue) and the watcher only auto-reloads
 * when nothing is blocking AND the operator has been idle. Staff can always
 * reload sooner via the banner.
 */

declare const __APP_BUILD_ID__: string;
declare const __APP_VERSION__: string;
declare const __APP_COMMIT__: string;
declare const __APP_BUILT_AT__: string;

export const APP_BUILD = {
  buildId: typeof __APP_BUILD_ID__ === 'string' ? __APP_BUILD_ID__ : 'dev',
  version: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0',
  commit: typeof __APP_COMMIT__ === 'string' ? __APP_COMMIT__ : 'dev',
  builtAt: typeof __APP_BUILT_AT__ === 'string' ? __APP_BUILT_AT__ : '',
} as const;

export interface AppUpdateState {
  /** A different build is live on the server. */
  available: boolean;
  /** The running bundle is below MIN_CLIENT_VERSION — reload is not optional. */
  forced: boolean;
  /** Build id the server reported, for display/debugging. */
  serverBuildId: string | null;
}

const POLL_INTERVAL_MS = 5 * 60 * 1000;
const TICK_INTERVAL_MS = 15 * 1000;
/** Quiet time before an idle surface reloads itself. */
const IDLE_BEFORE_RELOAD_MS = 60 * 1000;
/**
 * How long a forced update tolerates being blocked. The bundle is known
 * incompatible with the server, so past this point staying put is worse than
 * interrupting whatever is holding the blocker.
 */
const FORCED_BLOCKED_GRACE_MS = 5 * 60 * 1000;
const UPDATE_PENDING_KEY = 'app-update-pending';

let state: AppUpdateState = { available: false, forced: false, serverBuildId: null };
const listeners = new Set<(s: AppUpdateState) => void>();
const blockers = new Set<() => boolean>();

let lastInteractionAt = Date.now();
let forcedSinceMs: number | null = null;
let watcherStarted = false;

/** Numeric semver compare. Returns <0 when `a` is older than `b`. */
export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Decide what a reported server build means for this client. Pure so the rule
 * can be tested without a DOM or a build stamp.
 *
 * A `dev` build id on either side means identity is unknown — report nothing.
 * A build that lost its git context would otherwise show every tenant a
 * phantom "update available" banner that no reload can ever clear.
 */
export function evaluateUpdate(input: {
  clientBuildId: string;
  clientVersion: string;
  serverBuildId: string | null | undefined;
  minVersion?: string | null;
}): { comparable: boolean; available: boolean; forced: boolean } {
  const { clientBuildId, clientVersion, serverBuildId, minVersion } = input;

  if (!serverBuildId || serverBuildId === 'dev' || clientBuildId === 'dev') {
    return { comparable: false, available: false, forced: false };
  }

  return {
    comparable: true,
    available: serverBuildId !== clientBuildId,
    forced: !!minVersion && compareSemver(clientVersion, minVersion) < 0,
  };
}

function emit() {
  for (const cb of listeners) cb(state);
}

function setState(next: Partial<AppUpdateState>) {
  const merged = { ...state, ...next };
  if (
    merged.available === state.available &&
    merged.forced === state.forced &&
    merged.serverBuildId === state.serverBuildId
  ) {
    return;
  }
  state = merged;
  if (state.forced && forcedSinceMs === null) forcedSinceMs = Date.now();
  if (!state.forced) forcedSinceMs = null;
  emit();
}

export function getAppUpdateState(): AppUpdateState {
  return state;
}

export function subscribeAppUpdate(cb: (s: AppUpdateState) => void): () => void {
  listeners.add(cb);
  cb(state);
  return () => listeners.delete(cb);
}

/**
 * Register a predicate that returns true while this surface must not reload.
 * Returns an unregister function — call it on unmount.
 */
export function registerUpdateBlocker(isBusy: () => boolean): () => void {
  blockers.add(isBusy);
  return () => {
    blockers.delete(isBusy);
  };
}

function isBlocked(): boolean {
  for (const fn of blockers) {
    try {
      if (fn()) return true;
    } catch {
      // A throwing blocker is treated as busy — failing closed here only costs
      // a delayed update, while failing open could reload mid-order.
      return true;
    }
  }
  return false;
}

/** Feed version headers from any API response. Cheap, safe to call often. */
export function noteServerVersionHeaders(headers: Headers): void {
  const serverBuildId = headers.get('X-App-Version');
  const verdict = evaluateUpdate({
    clientBuildId: APP_BUILD.buildId,
    clientVersion: APP_BUILD.version,
    serverBuildId,
    minVersion: headers.get('X-App-Min-Version'),
  });
  if (!verdict.comparable) return;

  setState({
    serverBuildId,
    available: verdict.available,
    forced: verdict.forced,
  });
}

async function pollVersion(): Promise<void> {
  try {
    const res = await fetch('/api/version', { cache: 'no-store' });
    if (!res.ok) return;
    const data = (await res.json()) as { buildId?: string; minVersion?: string | null };
    const verdict = evaluateUpdate({
      clientBuildId: APP_BUILD.buildId,
      clientVersion: APP_BUILD.version,
      serverBuildId: data.buildId,
      minVersion: data.minVersion,
    });
    if (!verdict.comparable) return;
    setState({
      serverBuildId: data.buildId!,
      available: verdict.available,
      forced: verdict.forced,
    });
  } catch {
    // Offline or server restarting — the next tick tries again.
  }
}

/**
 * Reload into the new build. The service worker is nudged first so the waiting
 * worker takes over on this reload instead of the next one; the reload itself
 * is what actually swaps the bundle, so SW failures are non-fatal.
 */
export async function applyAppUpdate(): Promise<void> {
  try {
    sessionStorage.setItem(UPDATE_PENDING_KEY, '1');
  } catch {
    // Private mode / storage disabled — the reload still works.
  }
  try {
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) {
        await reg.update().catch(() => undefined);
        reg.waiting?.postMessage({ type: 'SKIP_WAITING' });
      }
    }
  } catch {
    // Best effort only.
  }
  window.location.reload();
}

/** True when the page was loaded by applyAppUpdate() — used by the SW
 *  registration to let a waiting worker take over immediately. */
export function consumeUpdatePendingFlag(): boolean {
  try {
    const pending = sessionStorage.getItem(UPDATE_PENDING_KEY) === '1';
    if (pending) sessionStorage.removeItem(UPDATE_PENDING_KEY);
    return pending;
  } catch {
    return false;
  }
}

function markInteraction() {
  lastInteractionAt = Date.now();
}

function tick() {
  if (!state.available) return;

  if (state.forced) {
    const blockedTooLong =
      forcedSinceMs !== null && Date.now() - forcedSinceMs > FORCED_BLOCKED_GRACE_MS;
    if (!isBlocked() || blockedTooLong) void applyAppUpdate();
    return;
  }

  if (isBlocked()) return;
  if (Date.now() - lastInteractionAt < IDLE_BEFORE_RELOAD_MS) return;
  void applyAppUpdate();
}

/** Start polling + the idle auto-reload loop. Safe to call more than once. */
export function startAppUpdateWatcher(): void {
  if (watcherStarted) return;
  watcherStarted = true;

  for (const evt of ['pointerdown', 'keydown', 'touchstart'] as const) {
    window.addEventListener(evt, markInteraction, { passive: true, capture: true });
  }

  window.setInterval(tick, TICK_INTERVAL_MS);
  window.setInterval(() => void pollVersion(), POLL_INTERVAL_MS);

  // A tab that was backgrounded for hours should check on the way back in
  // rather than waiting out the poll interval.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void pollVersion();
  });
}
