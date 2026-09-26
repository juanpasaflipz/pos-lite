/**
 * Per-workstation Clip PinPad reader binding — the Clip twin of mpTerminal.ts.
 *
 * Readers are addressed by serial number. The server never falls back to a
 * tenant default: every Clip charge sends an explicit `terminal_id` or it 400s
 * with `terminal_unpaired`, so a register paired once stays on its own reader.
 */

import type { ClipDevice } from '../api';

export const CLIP_TERMINAL_STORAGE_KEY = 'dk_clip_terminal_id';

export function readBoundClipTerminalId(): string {
  try {
    return localStorage.getItem(CLIP_TERMINAL_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

export function writeBoundClipTerminalId(serial: string): void {
  try {
    localStorage.setItem(CLIP_TERMINAL_STORAGE_KEY, serial);
  } catch {
    // Private mode / storage disabled — the in-memory binding still works for
    // this session.
  }
}

/**
 * Clip reports `active` only while the PinPad app is open and idle (heartbeat
 * <20s). `inactive` also covers a reader that is mid-charge, so "not active"
 * means unavailable right now, not necessarily offline.
 */
export function isClipDeviceOnline(device: ClipDevice): boolean {
  return device.status === 'active';
}

/**
 * Pick the reader to charge on: this workstation's stored binding when it is
 * still on the account, else the tenant default, else the only/first online
 * reader, else the first one.
 */
export function pickBoundClipTerminal(
  devices: ClipDevice[],
  stored: string,
  tenantDefault?: string | null,
): string {
  if (stored && devices.some((d) => d.serial_number === stored)) return stored;
  if (tenantDefault && devices.some((d) => d.serial_number === tenantDefault)) return tenantDefault;
  const online = devices.find(isClipDeviceOnline);
  return online?.serial_number || devices[0]?.serial_number || '';
}
