/**
 * Per-workstation MP Point terminal binding.
 *
 * Stored in localStorage so each PC/register keeps its own nearest terminal,
 * independent of the tenant default. The server stopped falling back to
 * `tenants.mp_default_terminal_id` in a79eb02 — every charge path must send an
 * explicit `terminal_id` or it 400s with `terminal_unpaired`. Both PaymentModal
 * and SplitPaymentModal read this same key so a register paired once stays
 * paired across every charge surface.
 */

export const MP_TERMINAL_STORAGE_KEY = 'dk_mp_terminal_id';

export interface MpTerminal {
  id: string;
  external_pos_id: string;
  operating_mode: string;
}

export function terminalDisplayName(term: MpTerminal): string {
  if (term.external_pos_id) return term.external_pos_id;
  const parts = term.id.split('__');
  return parts[parts.length - 1] || term.id;
}

export function readBoundTerminalId(): string {
  try {
    return localStorage.getItem(MP_TERMINAL_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

export function writeBoundTerminalId(terminalId: string): void {
  try {
    localStorage.setItem(MP_TERMINAL_STORAGE_KEY, terminalId);
  } catch {
    // Private mode / storage disabled — the in-memory binding still works for
    // this session.
  }
}

/**
 * Pick the terminal to charge on: this workstation's stored binding when it
 * still exists on the account, else the tenant default, else the first one.
 */
export function pickBoundTerminal(
  terminals: MpTerminal[],
  stored: string,
  tenantDefault?: string | null,
): string {
  if (stored && terminals.some((term) => term.id === stored)) return stored;
  if (tenantDefault && terminals.some((term) => term.id === tenantDefault)) return tenantDefault;
  return terminals[0]?.id || '';
}
