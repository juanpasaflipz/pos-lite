// Single source of truth for the app's build identity.
//
// Both Vite builds (POS + kiosk) and the Express server read from here, so a
// running client and the server it talks to agree on exactly one string. The
// comparison unit is `buildId` (`<semver>+<commit>`); `version` alone is for
// display and for the MIN_CLIENT_VERSION force-update gate.
//
// `npm run build` regenerates version.json first (scripts/gen-version.mjs), so
// every deploy stamps client and server from the same file. Reading a stale
// file is not a concern on Railway — each deploy is a fresh container.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION_FILE = path.join(ROOT, 'version.json');

function resolveCommit() {
  // Railway injects the deployed SHA at build and runtime. The others are
  // fallbacks for CI environments that set their own.
  const fromEnv =
    process.env.RAILWAY_GIT_COMMIT_SHA ||
    process.env.GIT_COMMIT_SHA ||
    process.env.SOURCE_VERSION;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim().slice(0, 7);

  try {
    return execSync('git rev-parse --short=7 HEAD', {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

/**
 * Compute build identity without touching disk.
 *
 * When no commit can be resolved, buildId is `dev`. Clients treat a `dev`
 * buildId on either side as "updates unknown" and stay silent — otherwise a
 * build that lost its git context would show every tenant a phantom
 * "update available" banner forever.
 */
export function computeAppVersion() {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const commit = resolveCommit();
  return {
    version: pkg.version,
    commit: commit || 'dev',
    buildId: commit ? `${pkg.version}+${commit}` : 'dev',
    builtAt: new Date().toISOString(),
  };
}

/** Compute and persist to version.json. Called once per build. */
export function writeAppVersion() {
  const info = computeAppVersion();
  writeFileSync(VERSION_FILE, `${JSON.stringify(info, null, 2)}\n`);
  return info;
}

/** Read version.json if the build wrote one; otherwise compute on the fly. */
export function resolveAppVersion() {
  if (existsSync(VERSION_FILE)) {
    try {
      const parsed = JSON.parse(readFileSync(VERSION_FILE, 'utf8'));
      if (parsed && typeof parsed.buildId === 'string') return parsed;
    } catch {
      // Corrupt file — fall through to computing.
    }
  }
  return computeAppVersion();
}
