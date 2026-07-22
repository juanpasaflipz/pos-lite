// Freemium trial plan resolution (2026-07-22).
//
// New self-serve signups keep plan='free' in the DB and get Pro via
// tenants.trial_ends_at — effectivePlan() is the single source of truth
// for gating (tenant middleware, /api/branding, /api/account, /api/billing).
// These are pure-logic tests: no DB needed.

import { describe, expect, it } from 'vitest';
// @ts-ignore — server files are plain JS
import { effectivePlan, isTrialActive, getPlanLimits } from '../server/planLimits.js';

const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

describe('effectivePlan', () => {
  it('paid pro is pro regardless of trial fields', () => {
    expect(effectivePlan({ plan: 'pro', trial_ends_at: null })).toBe('pro');
    expect(effectivePlan({ plan: 'pro', trial_ends_at: inDays(-5) })).toBe('pro');
  });

  it('free tenant with active trial is pro', () => {
    expect(effectivePlan({ plan: 'free', trial_ends_at: inDays(14) })).toBe('pro');
    expect(effectivePlan({ plan: 'free', trial_ends_at: inDays(0.01) })).toBe('pro');
  });

  it('free tenant with expired trial is free', () => {
    expect(effectivePlan({ plan: 'free', trial_ends_at: inDays(-0.01) })).toBe('free');
    expect(effectivePlan({ plan: 'free', trial_ends_at: inDays(-30) })).toBe('free');
  });

  it('free tenant without trial is free', () => {
    expect(effectivePlan({ plan: 'free' })).toBe('free');
    expect(effectivePlan({ plan: 'free', trial_ends_at: null })).toBe('free');
  });

  it('unknown/legacy plan values resolve to free (unless trial active)', () => {
    expect(effectivePlan({ plan: 'starter' })).toBe('free');
    expect(effectivePlan({ plan: 'starter', trial_ends_at: inDays(3) })).toBe('pro');
    expect(effectivePlan(null)).toBe('free');
    expect(effectivePlan(undefined)).toBe('free');
  });

  it('garbage trial_ends_at is treated as no trial', () => {
    expect(isTrialActive({ trial_ends_at: 'not-a-date' })).toBe(false);
    expect(effectivePlan({ plan: 'free', trial_ends_at: 'not-a-date' })).toBe('free');
  });

  it('trial grants the full pro limit set (AI, delivery, CFDI unlock)', () => {
    const limits = getPlanLimits(effectivePlan({ plan: 'free', trial_ends_at: inDays(14) }));
    expect(limits.ai.mode).toBe('full');
    expect(limits.delivery.functional).toBe(true);
    expect(limits.cfdi.locked).toBe(false);
    expect(limits.branding.watermark).toBe(false);
  });

  it('after expiry the POS core stays functional on free', () => {
    const limits = getPlanLimits(effectivePlan({ plan: 'free', trial_ends_at: inDays(-1) }));
    expect(limits.menuItems).toBe(Infinity);
    expect(limits.employees).toBe(Infinity);
    expect(limits.printers.functional).toBe(true);
    expect(limits.cfdi.locked).toBe(true);
    expect(limits.branding.watermark).toBe(true);
  });
});
