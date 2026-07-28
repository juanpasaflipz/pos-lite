// Server-side view of the build identity the client bundles were stamped with.
// See scripts/app-version.mjs for how the value is produced.

import { resolveAppVersion } from '../../scripts/app-version.mjs';

const build = resolveAppVersion();

export const APP_BUILD = Object.freeze({
  version: build.version,
  commit: build.commit,
  buildId: build.buildId,
  builtAt: build.builtAt,
});

/**
 * Semver below which clients must reload immediately rather than being asked.
 * Set MIN_CLIENT_VERSION only when an API contract change makes older bundles
 * actually broken — it interrupts whatever the user is doing.
 */
export const MIN_CLIENT_VERSION = (process.env.MIN_CLIENT_VERSION || '').trim() || null;

export function versionPayload() {
  return {
    ...APP_BUILD,
    minVersion: MIN_CLIENT_VERSION,
  };
}
