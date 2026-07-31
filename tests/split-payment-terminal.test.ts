// Split-payment terminal binding tests.
//
// Guards the regression that broke check-splitting in production for 13 days
// (2026-07-17 → 2026-07-30). Commit a79eb02 removed the server-side fallback to
// `tenants.mp_default_terminal_id`, making `terminal_id` mandatory on every MP
// Point charge. PaymentModal was updated to send the per-workstation binding;
// SplitPaymentModal was not — so every card leg of every split 400'd with
// `terminal_unpaired` before MP was ever contacted. Cashiers had no way forward
// and voided + re-rang whole checks.
//
// Two halves are covered:
//   1. pickBoundTerminal() — the resolution order every charge surface shares:
//      this workstation's stored binding, else the tenant default, else the
//      first terminal. A stale stored id (terminal removed from the account)
//      must never be sent.
//   2. Call-site guards — the charge routes require terminal_id, and every
//      client call site supplies one. This is the check that would have caught
//      a79eb02: the type signature made the argument optional, so nothing
//      failed at build time.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pickBoundTerminal, type MpTerminal } from '../src/lib/mpTerminal.js';

const repoRoot = resolve(__dirname, '..');
const read = (rel: string) => readFileSync(resolve(repoRoot, rel), 'utf8');

const term = (id: string): MpTerminal => ({ id, external_pos_id: '', operating_mode: 'PDV' });

describe('pickBoundTerminal: per-workstation binding resolution', () => {
  const list = [term('NEWLAND__AAA'), term('NEWLAND__BBB')];

  it('keeps this workstation\'s stored binding when it still exists', () => {
    expect(pickBoundTerminal(list, 'NEWLAND__BBB', 'NEWLAND__AAA')).toBe('NEWLAND__BBB');
  });

  it('falls back to the tenant default when nothing is stored', () => {
    expect(pickBoundTerminal(list, '', 'NEWLAND__BBB')).toBe('NEWLAND__BBB');
  });

  it('drops a stored id that no longer exists on the account', () => {
    expect(pickBoundTerminal(list, 'NEWLAND__GONE', 'NEWLAND__BBB')).toBe('NEWLAND__BBB');
  });

  it('drops a tenant default that no longer exists on the account', () => {
    expect(pickBoundTerminal(list, '', 'NEWLAND__GONE')).toBe('NEWLAND__AAA');
  });

  it('falls back to the first terminal when there is no hint at all', () => {
    expect(pickBoundTerminal(list, '', null)).toBe('NEWLAND__AAA');
  });

  it('returns empty (not undefined) when the account has no terminals', () => {
    expect(pickBoundTerminal([], 'NEWLAND__AAA', 'NEWLAND__BBB')).toBe('');
  });
});

describe('MP Point charge routes require an explicit terminal', () => {
  const payments = read('server/routes/payments.js');

  it('the split charge route rejects a request with no terminal_id', () => {
    const route = payments.slice(payments.indexOf("router.post('/split/charge-card'"));
    expect(route).toContain('terminal_unpaired');
    // No resurrection of the tenant-wide default: that fallback is what made
    // the split path look fine while it silently depended on it.
    const guard = route.slice(0, route.indexOf('createPointOrder'));
    expect(guard).not.toContain('tenant.mp_default_terminal_id');
  });
});

describe('every split card charge sends a terminal', () => {
  const modal = read('src/components/SplitPaymentModal.tsx');

  it('SplitPaymentModal passes a terminal id to splitChargeCard', () => {
    const calls = modal.match(/splitChargeCard\([^)]*\)/g) || [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call).toMatch(/splitChargeCard\([^,]+,[^)]+\)/);
    }
  });

  it('SplitPaymentModal reads the shared workstation binding, not its own key', () => {
    expect(modal).toContain("from '../lib/mpTerminal'");
    expect(modal).not.toContain('dk_mp_terminal_id');
  });

  it('the storage key lives in exactly one module', () => {
    const paymentModal = read('src/components/pos/PaymentModal.tsx');
    expect(paymentModal).not.toMatch(/const MP_TERMINAL_STORAGE_KEY = 'dk_mp_terminal_id'/);
    expect(read('src/lib/mpTerminal.ts')).toContain("'dk_mp_terminal_id'");
  });

  it('PayTogetherModal sends the same binding on the grouped charge', () => {
    const payTogetherModal = read('src/components/pos/PayTogetherModal.tsx');
    expect(payTogetherModal).toContain("from '../../lib/mpTerminal'");
    const call = payTogetherModal.slice(
      payTogetherModal.indexOf("payment_method: 'mp_terminal'"),
    );
    expect(call.slice(0, 200)).toContain('mp_terminal_id');
  });

  it('the cashier can bail out of a stuck split without voiding the check', () => {
    expect(modal).toContain('splitAbandon');
    expect(modal).toContain('chargeFullInstead');
    // Never offer the escape hatch once money has been collected.
    expect(modal).toMatch(/onChargeFull && paidSplitsCount === 0/);
  });
});
