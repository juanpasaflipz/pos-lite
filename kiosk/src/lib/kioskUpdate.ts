/**
 * New-deploy handling for the kiosk.
 *
 * The kiosk is 100% customer-facing, so there is no banner and no button — a
 * customer must never be asked to administer the tablet. It updates itself,
 * silently, and only at a moment where nothing is lost: parked on the attract
 * screen with an empty cart.
 *
 * The Android APK is the exception. Its assets are bundled at build time, so a
 * reload changes nothing — reloading would just churn. Those devices report the
 * build they are running and a stale tablet shows up in the kiosk device list
 * for someone to run `npm run android:install`.
 */

declare const __APP_BUILD_ID__: string;
declare const __APP_VERSION__: string;

export const KIOSK_BUILD = {
  buildId: typeof __APP_BUILD_ID__ === 'string' ? __APP_BUILD_ID__ : 'dev',
  version: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0',
} as const;

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) || '';

/** Capacitor serves the bundle from the APK — a reload cannot change the build. */
export const IS_NATIVE_SHELL =
  typeof window !== 'undefined' && !!(window as { Capacitor?: unknown }).Capacitor;

const VERSION_POLL_MS = 5 * 60 * 1000;
const HEARTBEAT_MS = 15 * 60 * 1000;
const IDLE_CHECK_MS = 20 * 1000;
/** Attract screen has to be genuinely settled, not just passed through. */
const ATTRACT_SETTLE_MS = 30 * 1000;

interface KioskAuth {
  tenantId: string;
  kioskToken: string;
}

let started = false;
let serverBuildId: string | null = null;
let attractSinceMs: number | null = null;
let isCartEmpty = () => true;
let currentAuth: KioskAuth | null = null;

function comparable(id: string | null | undefined): boolean {
  return !!id && id !== 'dev' && KIOSK_BUILD.buildId !== 'dev';
}

/** Feed version headers off any kiosk API response. */
export function noteKioskServerVersion(headers: Headers): void {
  const id = headers.get('X-App-Version');
  if (comparable(id)) serverBuildId = id;
}

/** Called by the cart context so the updater knows when an order is in flight. */
export function setKioskCartEmptyProbe(probe: () => boolean): void {
  isCartEmpty = probe;
}

function onAttractScreen(): boolean {
  // HashRouter: the attract screen is '#/' (or a bare URL on first load).
  const hash = window.location.hash;
  return hash === '' || hash === '#' || hash === '#/';
}

async function pollVersion(): Promise<void> {
  try {
    const res = await fetch(`${API_BASE}/api/version`, { cache: 'no-store' });
    if (!res.ok) return;
    const data = (await res.json()) as { buildId?: string };
    if (comparable(data.buildId)) serverBuildId = data.buildId!;
  } catch {
    // Offline — try again next interval.
  }
}

async function sendHeartbeat(): Promise<void> {
  if (!currentAuth) return;
  try {
    await fetch(`${API_BASE}/api/kiosk/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-ID': currentAuth.tenantId,
        Authorization: `Bearer ${currentAuth.kioskToken}`,
      },
      body: JSON.stringify({
        client_version: KIOSK_BUILD.buildId,
        client_platform: IS_NATIVE_SHELL ? 'android' : 'web',
      }),
    });
  } catch {
    // Heartbeat is observability, never correctness — drop it silently.
  }
}

function tick(): void {
  if (!comparable(serverBuildId) || serverBuildId === KIOSK_BUILD.buildId) {
    attractSinceMs = null;
    return;
  }

  // Frozen bundle: reloading would not pick up the new build, so don't.
  if (IS_NATIVE_SHELL) return;

  if (!onAttractScreen() || !isCartEmpty()) {
    attractSinceMs = null;
    return;
  }

  const now = Date.now();
  if (attractSinceMs === null) {
    attractSinceMs = now;
    return;
  }
  if (now - attractSinceMs < ATTRACT_SETTLE_MS) return;

  window.location.reload();
}

/**
 * Start version polling, device heartbeat, and the silent self-update loop.
 * Called once the device is bound (auth is needed for the heartbeat).
 */
export function startKioskUpdateWatcher(auth: KioskAuth): void {
  currentAuth = auth;

  if (started) return;
  started = true;

  void pollVersion();
  void sendHeartbeat();

  window.setInterval(() => void pollVersion(), VERSION_POLL_MS);
  window.setInterval(() => void sendHeartbeat(), HEARTBEAT_MS);
  window.setInterval(tick, IDLE_CHECK_MS);
}
