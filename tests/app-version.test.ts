// Versioning + new-deploy detection.
//
// The update rule is the part worth pinning down: it decides whether a running
// terminal reloads itself. Both failure directions are expensive — never
// updating leaves tenants on stale JS, and a false positive reload-loops a
// register mid-shift.

import { describe, expect, it } from 'vitest';
import { compareSemver, evaluateUpdate } from '../src/lib/appUpdate';
// @ts-ignore — plain ESM helper shared by the builds and the server
import { computeAppVersion, resolveAppVersion } from '../scripts/app-version.mjs';
// @ts-ignore
import { versionPayload } from '../server/helpers/appVersion.js';

describe('compareSemver', () => {
  it('orders by major, minor, then patch', () => {
    expect(compareSemver('1.0.0', '1.0.1')).toBeLessThan(0);
    expect(compareSemver('1.2.0', '1.10.0')).toBeLessThan(0);
    expect(compareSemver('2.0.0', '1.99.99')).toBeGreaterThan(0);
    expect(compareSemver('1.4.2', '1.4.2')).toBe(0);
  });

  it('treats missing segments as zero', () => {
    expect(compareSemver('1.1', '1.1.0')).toBe(0);
    expect(compareSemver('2', '1.9.9')).toBeGreaterThan(0);
  });
});

describe('evaluateUpdate', () => {
  const client = { clientBuildId: '1.0.0+aaaaaaa', clientVersion: '1.0.0' };

  it('reports an update when the server is on a different build', () => {
    const v = evaluateUpdate({ ...client, serverBuildId: '1.0.0+bbbbbbb' });
    expect(v).toEqual({ comparable: true, available: true, forced: false });
  });

  it('stays quiet when client and server agree', () => {
    const v = evaluateUpdate({ ...client, serverBuildId: '1.0.0+aaaaaaa' });
    expect(v.available).toBe(false);
  });

  // A build that lost its git context must not spam every tenant with a
  // banner that no reload can clear.
  it('refuses to compare when either side is a dev build', () => {
    expect(evaluateUpdate({ ...client, serverBuildId: 'dev' }).comparable).toBe(false);
    expect(
      evaluateUpdate({ clientBuildId: 'dev', clientVersion: '0.0.0', serverBuildId: '1.0.0+bbbbbbb' })
        .comparable,
    ).toBe(false);
  });

  it('is quiet when the server sends no version header at all', () => {
    expect(evaluateUpdate({ ...client, serverBuildId: null }).comparable).toBe(false);
    expect(evaluateUpdate({ ...client, serverBuildId: undefined }).comparable).toBe(false);
  });

  it('forces the reload only below minVersion', () => {
    expect(evaluateUpdate({ ...client, serverBuildId: '1.1.0+bbbbbbb', minVersion: '1.1.0' }).forced)
      .toBe(true);
    expect(evaluateUpdate({ ...client, serverBuildId: '1.1.0+bbbbbbb', minVersion: '1.0.0' }).forced)
      .toBe(false);
    expect(evaluateUpdate({ ...client, serverBuildId: '1.1.0+bbbbbbb', minVersion: null }).forced)
      .toBe(false);
  });
});

describe('build stamp', () => {
  it('produces a comparable buildId of <semver>+<commit>', () => {
    const info = computeAppVersion();
    expect(info.version).toMatch(/^\d+\.\d+\.\d+$/);
    // CI and dev machines both have git; a 'dev' buildId here would mean the
    // stamp silently degraded and update detection would be disabled in prod.
    expect(info.buildId).toBe(`${info.version}+${info.commit}`);
    expect(info.commit).not.toBe('dev');
    expect(new Date(info.builtAt).toString()).not.toBe('Invalid Date');
  });

  it('serves the same identity the bundles were stamped with', () => {
    const payload = versionPayload();
    const resolved = resolveAppVersion();
    expect(payload.buildId).toBe(resolved.buildId);
    expect(payload).toHaveProperty('minVersion');
  });
});
