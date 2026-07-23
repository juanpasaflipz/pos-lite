// Freemium trial plan resolution (2026-07-22).
//
// New self-serve signups keep plan='free' in the DB and get Pro via
// tenants.trial_ends_at — effectivePlan() is the single source of truth
// for gating (tenant middleware, /api/branding, /api/account, /api/billing).
// These are pure-logic tests: no DB needed.

import { describe, expect, it } from 'vitest';
// @ts-ignore — server files are plain JS
import { effectivePlan, isTrialActive, getPlanLimits, getRequiredPlan } from '../server/planLimits.js';

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

  it('trial grants the full pro limit set (kiosk, AI, CFDI unlock)', () => {
    const limits = getPlanLimits(effectivePlan({ plan: 'free', trial_ends_at: inDays(14) }));
    expect(limits.ai.mode).toBe('full');
    expect(limits.kiosk.functional).toBe(true);
    expect(limits.qrOrdering.functional).toBe(true);
    expect(limits.employees).toBe(Infinity);
    expect(limits.kdsDevices.max).toBe(Infinity);
    expect(limits.reportsHistoryDays).toBe(Infinity);
    expect(limits.delivery.functional).toBe(true);
    expect(limits.cfdi.locked).toBe(false);
    expect(limits.branding.watermark).toBe(false);
  });

  // Repackaged 2026-07-23: free = "la caja" (counter POS, never order-capped);
  // the growth features — kiosk, QR ordering, extra staff/stations, report
  // history — are the Pro upgrade pressure. Trial expiry must flip them off.
  it('after expiry the POS core stays functional on free', () => {
    const limits = getPlanLimits(effectivePlan({ plan: 'free', trial_ends_at: inDays(-1) }));
    expect(limits.menuItems).toBe(Infinity);
    expect(limits.inventoryItems).toBe(Infinity);
    expect(limits.combos).toBe(Infinity);
    expect(limits.printers.functional).toBe(true);
    expect(limits.loyalty.locked).toBe(false);
  });

  it('after expiry the growth features lock (kiosk is the upgrade incentive)', () => {
    const limits = getPlanLimits(effectivePlan({ plan: 'free', trial_ends_at: inDays(-1) }));
    expect(limits.kiosk.functional).toBe(false);
    expect(limits.qrOrdering.functional).toBe(false);
    expect(limits.employees).toBe(3);
    expect(limits.kdsDevices.max).toBe(1);
    expect(limits.kdsDevices.stations).toEqual(['kds']);
    expect(limits.reportsHistoryDays).toBe(7);
    expect(limits.cfdi.locked).toBe(true);
    expect(limits.branding.watermark).toBe(true);
  });

  it('getRequiredPlan puts the repackaged gates on the right tier', () => {
    expect(getRequiredPlan('kiosk')).toBe('pro');
    expect(getRequiredPlan('qrOrdering')).toBe('pro');
    expect(getRequiredPlan('cfdi')).toBe('pro');
    // Numeric caps and functional-on-free features resolve to free.
    expect(getRequiredPlan('employees')).toBe('free');
    expect(getRequiredPlan('printers')).toBe('free');
    expect(getRequiredPlan('kdsDevices')).toBe('free');
  });
});
