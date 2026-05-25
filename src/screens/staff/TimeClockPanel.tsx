import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Clock, AlertTriangle, Users, Save, X, Pencil, Wallet, LogIn, LogOut, UserPlus } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import {
  adminClockInEmployee,
  adminClockOutEmployee,
  getActiveShifts,
  getEmployees,
  getShifts,
  updateShift,
  updateShiftCashDrawer,
} from '../../api';
import type { ActiveShift, CashDrawerCounts, Employee, ShiftRow } from '../../types';
import { formatPrice } from '../../utils/currency';

const DAY_MS = 24 * 60 * 60 * 1000;
const RANGE_OPTIONS = [
  { key: 'today', days: 1 },
  { key: '7', days: 7 },
  { key: '14', days: 14 },
  { key: '30', days: 30 },
];
const DENOMINATIONS = [1000, 500, 200, 100, 50, 20, 10, 5, 2, 1, 0.5];

function formatDuration(seconds: number | null): string {
  if (seconds === null || seconds === undefined) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m.toString().padStart(2, '0')}m`;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString([], {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function formatMoney(amount: number | null | undefined): string {
  if (amount == null) return '—';
  return formatPrice(amount);
}

function toLocalInputValue(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInputValue(value: string): string | null {
  if (!value) return null;
  return new Date(value).toISOString();
}

interface EditState {
  id: number;
  clockIn: string;
  clockOut: string;
  notes: string;
}

interface CashEditState {
  shiftId: number;
  employeeName: string;
  isClosed: boolean;
  hadClosingCounts: boolean;
  openingCounts: CashDrawerCounts;
  closingCounts: CashDrawerCounts;
  varianceNote: string;
  expectedCashTotal: number;
}

function zeroCounts(): CashDrawerCounts {
  return Object.fromEntries(DENOMINATIONS.map((value) => [String(value), 0]));
}

function normalizeCounts(counts?: CashDrawerCounts | null): CashDrawerCounts {
  return { ...zeroCounts(), ...(counts || {}) };
}

function totalFromCounts(counts: CashDrawerCounts): number {
  return Math.round(
    Object.entries(counts).reduce(
      (sum, [d, c]) => sum + Number(d) * Number(c || 0), 0,
    ) * 100
  ) / 100;
}

function formatDenomination(value: number): string {
  return `$${value >= 1 ? value.toLocaleString('en-US') : value.toFixed(2)}`;
}

/**
 * Time Clock panel for the Staff hub.
 * Active shifts, hours by employee, full shift log + cash drawer reconciliation.
 * Chrome-less — the hub provides the page header.
 */
export default function TimeClockPanel() {
  const { t } = useTranslation('common');
  const { currentEmployee } = useAuth();
  const { addToast } = useToast();
  const canEdit = !!currentEmployee && ['manager', 'admin'].includes(currentEmployee.role);

  const [active, setActive] = useState<ActiveShift[]>([]);
  const [shifts, setShifts] = useState<ShiftRow[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [rangeDays, setRangeDays] = useState(7);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [editing, setEditing] = useState<EditState | null>(null);
  const [cashEditing, setCashEditing] = useState<CashEditState | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [clockInOpen, setClockInOpen] = useState(false);
  const [clockInEmployeeId, setClockInEmployeeId] = useState<number | null>(null);
  const [clockInBusy, setClockInBusy] = useState(false);
  const [clockOutBusyId, setClockOutBusyId] = useState<number | null>(null);

  const load = async (days: number) => {
    try {
      setLoading(true);
      setError(null);
      const to = new Date();
      const from = new Date(to.getTime() - days * DAY_MS);
      const [activeRows, listRows] = await Promise.all([
        getActiveShifts(),
        getShifts({ from: from.toISOString(), to: to.toISOString() }),
      ]);
      setActive(activeRows);
      setShifts(listRows);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load shifts');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(rangeDays); }, [rangeDays]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30 * 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!canEdit) return;
    let cancelled = false;
    (async () => {
      try {
        const rows = await getEmployees();
        if (!cancelled) setEmployees(rows);
      } catch {
        // non-fatal: clock-in picker just won't populate
      }
    })();
    return () => { cancelled = true; };
  }, [canEdit]);

  const activeEmployeeIds = useMemo(() => new Set(active.map(a => a.employee_id)), [active]);
  const clockInCandidates = useMemo(
    () => employees.filter(e => e.active && !activeEmployeeIds.has(e.id)),
    [employees, activeEmployeeIds]
  );

  const openClockInModal = () => {
    setClockInEmployeeId(clockInCandidates[0]?.id ?? null);
    setClockInOpen(true);
  };

  const submitClockIn = async () => {
    if (!clockInEmployeeId) return;
    try {
      setClockInBusy(true);
      const result = await adminClockInEmployee(clockInEmployeeId);
      addToast(
        result.already_open
          ? `${result.employee.name} was already clocked in`
          : `${result.employee.name} clocked in`,
        'success'
      );
      setClockInOpen(false);
      await load(rangeDays);
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Failed to clock in employee', 'error');
    } finally {
      setClockInBusy(false);
    }
  };

  const handleClockOut = async (employeeId: number, employeeName: string) => {
    try {
      setClockOutBusyId(employeeId);
      await adminClockOutEmployee(employeeId);
      addToast(`${employeeName} clocked out`, 'success');
      await load(rangeDays);
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Failed to clock out employee', 'error');
    } finally {
      setClockOutBusyId(null);
    }
  };

  const totalsByEmployee = useMemo(() => {
    const map = new Map<number, { name: string; role: string; seconds: number; openShift: boolean }>();
    for (const s of shifts) {
      const dur = s.duration_seconds || 0;
      const existing = map.get(s.employee_id);
      if (existing) {
        existing.seconds += dur;
        if (!s.clock_out_at) existing.openShift = true;
      } else {
        map.set(s.employee_id, {
          name: s.employee_name,
          role: s.employee_role,
          seconds: dur,
          openShift: !s.clock_out_at,
        });
      }
    }
    return Array.from(map.entries())
      .map(([id, v]) => ({ employee_id: id, ...v }))
      .sort((a, b) => b.seconds - a.seconds);
  }, [shifts]);

  const flagged = useMemo(() => shifts.filter(s => s.flagged_long_open), [shifts]);

  const liveActive = useMemo(() => active.map(a => ({
    ...a,
    elapsed_seconds: Math.max(0, Math.floor((now - new Date(a.clock_in_at).getTime()) / 1000)),
  })), [active, now]);

  const startEdit = (row: ShiftRow) => setEditing({
    id: row.id,
    clockIn: toLocalInputValue(row.clock_in_at),
    clockOut: toLocalInputValue(row.clock_out_at),
    notes: row.notes || '',
  });
  const cancelEdit = () => setEditing(null);

  const startCashEdit = (row: ShiftRow) => setCashEditing({
    shiftId: row.id,
    employeeName: row.employee_name,
    isClosed: Boolean(row.clock_out_at),
    hadClosingCounts: Boolean(row.cash_drawer?.closing_counts),
    openingCounts: normalizeCounts(row.cash_drawer?.opening_counts),
    closingCounts: normalizeCounts(row.cash_drawer?.closing_counts),
    varianceNote: row.cash_drawer?.variance_note || '',
    expectedCashTotal: row.cash_drawer?.expected_cash_total ?? row.cash_drawer_preview?.expected_cash_total ?? 0,
  });

  const saveEdit = async () => {
    if (!editing) return;
    try {
      setSavingEdit(true);
      const clockIn = fromLocalInputValue(editing.clockIn);
      const clockOut = editing.clockOut ? fromLocalInputValue(editing.clockOut) : null;
      if (!clockIn) {
        addToast('Clock in time is required', 'error');
        return;
      }
      await updateShift(editing.id, {
        clock_in_at: clockIn,
        clock_out_at: clockOut,
        notes: editing.notes || undefined,
      });
      addToast('Shift updated', 'success');
      setEditing(null);
      await load(rangeDays);
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Failed to update shift', 'error');
    } finally {
      setSavingEdit(false);
    }
  };

  const saveCashEdit = async () => {
    if (!cashEditing) return;
    try {
      setSavingEdit(true);
      const shouldSendClosingCounts = cashEditing.isClosed || cashEditing.hadClosingCounts || totalFromCounts(cashEditing.closingCounts) > 0;
      await updateShiftCashDrawer(cashEditing.shiftId, {
        opening_counts: cashEditing.openingCounts,
        closing_counts: shouldSendClosingCounts ? cashEditing.closingCounts : undefined,
        variance_note: cashEditing.varianceNote || undefined,
      });
      addToast('Cash drawer updated', 'success');
      setCashEditing(null);
      await load(rangeDays);
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Failed to update cash drawer', 'error');
    } finally {
      setSavingEdit(false);
    }
  };

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-xl border border-cockpit-red bg-cockpit-red/40 px-4 py-3 text-sm text-cockpit-out-text">{error}</div>
      )}

      {flagged.length > 0 && (
        <div className="rounded-xl border border-cockpit-yellow bg-cockpit-yellow/40 px-4 py-3 flex items-start gap-3">
          <AlertTriangle size={18} className="text-cockpit-attention-text mt-0.5 shrink-0" />
          <div className="text-sm text-cockpit-attention-text">
            <p className="font-semibold">{flagged.length} shift(s) open more than 12 hours</p>
            <p className="mt-1 text-cockpit-attention-text/80">Likely forgot to clock out. Edit the row to set the correct clock-out time.</p>
          </div>
        </div>
      )}

      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-bold text-white flex items-center gap-2">
            <Users size={18} className="text-brand-500" />
            On shift now <span className="text-neutral-500 font-normal text-sm">({liveActive.length})</span>
          </h2>
          {canEdit && (
            <button
              onClick={openClockInModal}
              className="inline-flex items-center gap-2 px-3 py-2 min-h-[40px] rounded-lg bg-brand-600 text-white text-sm font-medium hover:bg-brand-500 transition-colors"
            >
              <UserPlus size={16} />
              Clock in employee
            </button>
          )}
        </div>
        {liveActive.length === 0 ? (
          <div className="rounded-xl border border-dashed border-neutral-800 px-4 py-8 text-sm text-neutral-500 text-center">
            Nobody is currently clocked in.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {liveActive.map(a => (
              <div key={a.id} className="rounded-xl border border-cockpit-green bg-cockpit-green/20 p-4 flex flex-col gap-3">
                <div>
                  <p className="text-xs uppercase tracking-wide text-cockpit-in-text">{a.employee_role}</p>
                  <p className="text-xl font-bold text-white mt-1">{a.employee_name}</p>
                  <p className="text-sm text-neutral-300 mt-2">
                    Since {formatDateTime(a.clock_in_at)} · <span className="text-cockpit-in-text">{formatDuration(a.elapsed_seconds)}</span>
                  </p>
                </div>
                {canEdit && (
                  <button
                    onClick={() => handleClockOut(a.employee_id, a.employee_name)}
                    disabled={clockOutBusyId === a.employee_id}
                    className="inline-flex items-center justify-center gap-2 px-3 py-2 min-h-[40px] rounded-lg border border-cockpit-green bg-neutral-900/40 text-cockpit-in-text text-sm font-medium hover:bg-neutral-900 transition-colors disabled:opacity-60"
                  >
                    <LogOut size={16} />
                    {clockOutBusyId === a.employee_id ? 'Clocking out…' : 'Clock out'}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-bold text-white flex items-center gap-2">
            <Clock size={18} className="text-brand-500" />
            Hours by employee
          </h2>
          <div className="flex gap-1 bg-neutral-900 border border-neutral-800 rounded-lg p-1">
            {RANGE_OPTIONS.map(opt => (
              <button
                key={opt.key}
                onClick={() => setRangeDays(opt.days)}
                className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
                  rangeDays === opt.days ? 'bg-brand-600 text-white' : 'text-neutral-400 hover:text-white'
                }`}
              >
                {opt.key === 'today' ? 'Today' : `${opt.key}d`}
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <div className="rounded-xl border border-neutral-800 bg-neutral-900 px-4 py-8 text-center text-neutral-500">
            {t('states.loading')}
          </div>
        ) : totalsByEmployee.length === 0 ? (
          <div className="rounded-xl border border-dashed border-neutral-800 px-4 py-8 text-sm text-neutral-500 text-center">
            No shifts in this range.
          </div>
        ) : (
          <div className="rounded-xl border border-neutral-800 bg-neutral-900 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-neutral-950 text-neutral-400 text-xs uppercase tracking-wide">
                <tr>
                  <th className="text-left px-4 py-3">Employee</th>
                  <th className="text-left px-4 py-3">Role</th>
                  <th className="text-right px-4 py-3">Hours</th>
                  <th className="text-left px-4 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {totalsByEmployee.map(row => (
                  <tr key={row.employee_id} className="border-t border-neutral-800">
                    <td className="px-4 py-3 text-white font-medium">{row.name}</td>
                    <td className="px-4 py-3 text-neutral-400">{row.role}</td>
                    <td className="px-4 py-3 text-right text-white font-semibold tabular-nums">
                      {formatDuration(row.seconds)}
                    </td>
                    <td className="px-4 py-3">
                      {row.openShift && (
                        <span className="text-[11px] px-2 py-0.5 rounded-full bg-cockpit-green/60 border border-cockpit-green text-cockpit-in-text">
                          on shift
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2 className="text-lg font-bold text-white mb-3">Shift log</h2>
        {shifts.length === 0 && !loading ? (
          <div className="rounded-xl border border-dashed border-neutral-800 px-4 py-8 text-sm text-neutral-500 text-center">
            No shifts in this range.
          </div>
        ) : (
          <div className="rounded-xl border border-neutral-800 bg-neutral-900 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-neutral-950 text-neutral-400 text-xs uppercase tracking-wide">
                <tr>
                  <th className="text-left px-4 py-3">Employee</th>
                  <th className="text-left px-4 py-3">Clock in</th>
                  <th className="text-left px-4 py-3">Clock out</th>
                  <th className="text-right px-4 py-3">Duration</th>
                  <th className="text-left px-4 py-3">Cash closeout</th>
                  {canEdit && <th className="px-4 py-3" />}
                </tr>
              </thead>
              <tbody>
                {shifts.map(row => (
                  <tr key={row.id} className={`border-t border-neutral-800 ${row.flagged_long_open ? 'bg-cockpit-yellow/10' : ''}`}>
                    <td className="px-4 py-3 text-white">{row.employee_name}</td>
                    <td className="px-4 py-3 text-neutral-300 tabular-nums">{formatDateTime(row.clock_in_at)}</td>
                    <td className="px-4 py-3 text-neutral-300 tabular-nums">
                      {row.clock_out_at ? formatDateTime(row.clock_out_at) : (
                        <span className={row.flagged_long_open ? 'text-cockpit-attention-text font-medium' : 'text-cockpit-in-text'}>
                          {row.flagged_long_open ? 'Open >12h' : 'Open'}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right text-white font-semibold tabular-nums">
                      {formatDuration(row.duration_seconds)}
                    </td>
                    <td className="px-4 py-3 text-neutral-500 text-xs">
                      <div className="space-y-1">
                        {row.cash_drawer ? (
                          <>
                            <span className="block text-neutral-400">Opening float: {formatMoney(row.cash_drawer.opening_total)}</span>
                            <span className="block text-neutral-400">Cash sales: {formatMoney(row.cash_drawer.cash_sales_total)}</span>
                            <span className="block text-neutral-400">Expected drawer: {formatMoney(row.cash_drawer.expected_cash_total)}</span>
                            <span className="block text-neutral-400">Counted close: {formatMoney(row.cash_drawer.closing_total)}</span>
                            <span className={`block font-semibold ${row.cash_drawer.variance_total === 0 ? 'text-neutral-300' : (row.cash_drawer.variance_total || 0) > 0 ? 'text-cockpit-in-text' : 'text-cockpit-out-text'}`}>
                              Over / short: {row.cash_drawer.variance_total != null && row.cash_drawer.variance_total > 0 ? '+' : ''}{formatMoney(row.cash_drawer.variance_total)}
                            </span>
                            {row.cash_drawer.variance_note && (
                              <span className="block text-[11px] text-cockpit-attention-text">Manager note: {row.cash_drawer.variance_note}</span>
                            )}
                          </>
                        ) : (
                          <span className="block text-neutral-600">No closeout recorded</span>
                        )}
                      </div>
                      {row.notes && <span className="block mt-2">{row.notes}</span>}
                      {row.edited_by_name && (
                        <span className="block text-[10px] text-neutral-600 mt-0.5">edited by {row.edited_by_name}</span>
                      )}
                    </td>
                    {canEdit && (
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-3">
                          <button onClick={() => startCashEdit(row)} className="text-neutral-400 hover:text-white inline-flex items-center gap-1 text-xs">
                            <Wallet size={14} /> Closeout
                          </button>
                          <button onClick={() => startEdit(row)} className="text-neutral-400 hover:text-white inline-flex items-center gap-1 text-xs">
                            <Pencil size={14} /> Edit
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {editing && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50">
          <div className="bg-neutral-900 rounded-2xl border border-neutral-800 max-w-md w-full p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xl font-bold text-white">Edit shift</h3>
              <button onClick={cancelEdit} className="text-neutral-500 hover:text-neutral-300">
                <X size={20} />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-neutral-300 mb-2">Clock in</label>
                <input
                  type="datetime-local"
                  value={editing.clockIn}
                  onChange={e => setEditing({ ...editing, clockIn: e.target.value })}
                  className="w-full px-3 py-2 bg-neutral-950 border border-neutral-800 rounded-lg text-white focus:outline-none focus:border-brand-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-neutral-300 mb-2">Clock out (leave blank if still on shift)</label>
                <input
                  type="datetime-local"
                  value={editing.clockOut}
                  onChange={e => setEditing({ ...editing, clockOut: e.target.value })}
                  className="w-full px-3 py-2 bg-neutral-950 border border-neutral-800 rounded-lg text-white focus:outline-none focus:border-brand-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-neutral-300 mb-2">Notes</label>
                <textarea
                  value={editing.notes}
                  onChange={e => setEditing({ ...editing, notes: e.target.value })}
                  rows={2}
                  placeholder="e.g. forgot to clock out"
                  className="w-full px-3 py-2 bg-neutral-950 border border-neutral-800 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:border-brand-500"
                />
              </div>
            </div>

            <div className="flex gap-3 mt-6">
              <button
                onClick={cancelEdit}
                disabled={savingEdit}
                className="flex-1 px-4 py-2 border border-neutral-700 text-neutral-300 rounded-lg hover:bg-neutral-800 transition-colors font-medium"
              >
                {t('buttons.cancel')}
              </button>
              <button
                onClick={saveEdit}
                disabled={savingEdit}
                className="flex-1 px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-500 transition-colors font-medium disabled:opacity-60 inline-flex items-center justify-center gap-2"
              >
                <Save size={16} />
                {savingEdit ? 'Saving...' : t('buttons.save')}
              </button>
            </div>
          </div>
        </div>
      )}

      {cashEditing && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50">
          <div className="bg-neutral-900 rounded-2xl border border-neutral-800 max-w-3xl w-full p-6 max-h-[92vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-xl font-bold text-white">Cash Closeout</h3>
                <p className="text-sm text-neutral-400 mt-1">{cashEditing.employeeName}</p>
              </div>
              <button onClick={() => setCashEditing(null)} className="text-neutral-500 hover:text-neutral-300">
                <X size={20} />
              </button>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {([
                ['Opening float', cashEditing.openingCounts, (counts: CashDrawerCounts) => setCashEditing({ ...cashEditing, openingCounts: counts })],
                ['Closing drawer count', cashEditing.closingCounts, (counts: CashDrawerCounts) => setCashEditing({ ...cashEditing, closingCounts: counts })],
              ] as const).map(([title, counts, setCounts]) => (
                <div key={title} className="rounded-xl border border-neutral-800 bg-neutral-950 p-4">
                  <h4 className="text-white font-semibold mb-3">{title}</h4>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {DENOMINATIONS.map((denomination) => (
                      <label key={`${title}-${denomination}`} className="rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2">
                        <span className="block text-sm text-neutral-400">{denomination >= 20 ? 'Bill' : 'Coin'} {formatDenomination(denomination)}</span>
                        <input
                          type="number"
                          min="0"
                          step="1"
                          value={counts[String(denomination)] ?? 0}
                          onChange={(e) => setCounts({
                            ...counts,
                            [String(denomination)]: Math.max(0, Math.floor(Number(e.target.value || 0))) || 0,
                          })}
                          className="mt-2 w-full bg-neutral-950 border border-neutral-700 rounded-lg px-3 py-2 text-white"
                        />
                      </label>
                    ))}
                  </div>
                  <p className="text-sm text-neutral-400 mt-3">Total: <span className="text-white font-semibold">{formatMoney(totalFromCounts(counts))}</span></p>
                </div>
              ))}
            </div>

            <div className="rounded-xl border border-neutral-800 bg-neutral-950 p-4 mt-6 space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-neutral-400">Expected drawer</span>
                <span className="text-white">{formatMoney(cashEditing.expectedCashTotal)}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-neutral-400">Counted close</span>
                <span className="text-white">{formatMoney(totalFromCounts(cashEditing.closingCounts))}</span>
              </div>
              <div className="flex items-center justify-between text-sm border-t border-neutral-800 pt-2">
                <span className="text-neutral-300 font-medium">Over / short</span>
                {(() => {
                  const variance = Math.round((totalFromCounts(cashEditing.closingCounts) - cashEditing.expectedCashTotal) * 100) / 100;
                  return (
                    <span className={`font-bold ${variance === 0 ? 'text-white' : variance > 0 ? 'text-cockpit-in-text' : 'text-cockpit-out-text'}`}>
                      {variance > 0 ? '+' : ''}{formatMoney(variance)}
                    </span>
                  );
                })()}
              </div>
            </div>

            <div className="mt-4">
              <label className="block text-sm font-medium text-neutral-300 mb-2">Manager note</label>
              <textarea
                value={cashEditing.varianceNote}
                onChange={(e) => setCashEditing({ ...cashEditing, varianceNote: e.target.value })}
                rows={3}
                className="w-full px-3 py-2 bg-neutral-950 border border-neutral-800 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:border-brand-500"
                placeholder="Required if the counted close differs from the expected drawer total"
              />
            </div>

            <div className="flex gap-3 mt-6">
              <button
                onClick={() => setCashEditing(null)}
                disabled={savingEdit}
                className="flex-1 px-4 py-2 border border-neutral-700 text-neutral-300 rounded-lg hover:bg-neutral-800 transition-colors font-medium"
              >
                {t('buttons.cancel')}
              </button>
              <button
                onClick={saveCashEdit}
                disabled={savingEdit}
                className="flex-1 px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-500 transition-colors font-medium disabled:opacity-60 inline-flex items-center justify-center gap-2"
              >
                <Save size={16} />
                {savingEdit ? 'Saving...' : 'Save closeout'}
              </button>
            </div>
          </div>
        </div>
      )}

      {clockInOpen && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50">
          <div className="bg-neutral-900 rounded-2xl border border-neutral-800 max-w-md w-full p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xl font-bold text-white">Clock in employee</h3>
              <button onClick={() => setClockInOpen(false)} className="text-neutral-500 hover:text-neutral-300">
                <X size={20} />
              </button>
            </div>

            {clockInCandidates.length === 0 ? (
              <p className="text-sm text-neutral-400 py-4">
                Everyone active is already clocked in.
              </p>
            ) : (
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-neutral-300 mb-2">Employee</label>
                  <select
                    value={clockInEmployeeId ?? ''}
                    onChange={(e) => setClockInEmployeeId(Number(e.target.value) || null)}
                    className="w-full px-3 py-2 bg-neutral-950 border border-neutral-800 rounded-lg text-white focus:outline-none focus:border-brand-500"
                  >
                    {clockInCandidates.map(emp => (
                      <option key={emp.id} value={emp.id}>
                        {emp.name} · {emp.role}
                      </option>
                    ))}
                  </select>
                </div>
                <p className="text-xs text-neutral-500">
                  Shift will start now. You can adjust the clock-in time afterward from the shift log.
                </p>
              </div>
            )}

            <div className="flex gap-3 mt-6">
              <button
                onClick={() => setClockInOpen(false)}
                disabled={clockInBusy}
                className="flex-1 px-4 py-2 border border-neutral-700 text-neutral-300 rounded-lg hover:bg-neutral-800 transition-colors font-medium"
              >
                {t('buttons.cancel')}
              </button>
              <button
                onClick={submitClockIn}
                disabled={clockInBusy || !clockInEmployeeId || clockInCandidates.length === 0}
                className="flex-1 px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-500 transition-colors font-medium disabled:opacity-60 inline-flex items-center justify-center gap-2"
              >
                <LogIn size={16} />
                {clockInBusy ? 'Clocking in…' : 'Clock in'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
