import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Clock, AlertTriangle, Users, Save, X, Pencil, Wallet } from 'lucide-react';
import BrandLogo from '../components/BrandLogo';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { getActiveShifts, getShifts, updateShift, updateShiftCashDrawer } from '../api';
import type { ActiveShift, CashDrawerCounts, ShiftRow } from '../types';
import { formatPrice } from '../utils/currency';

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
  return {
    ...zeroCounts(),
    ...(counts || {}),
  };
}

function totalFromCounts(counts: CashDrawerCounts): number {
  return Math.round(
    Object.entries(counts).reduce((sum, [denomination, count]) => sum + Number(denomination) * Number(count || 0), 0) * 100
  ) / 100;
}

function formatDenomination(value: number): string {
  return `$${value >= 1 ? value.toLocaleString('en-US') : value.toFixed(2)}`;
}

export default function ShiftsScreen() {
  const { t } = useTranslation('common');
  const { currentEmployee } = useAuth();
  const { addToast } = useToast();
  const canEdit = currentEmployee && ['manager', 'admin'].includes(currentEmployee.role);

  const [active, setActive] = useState<ActiveShift[]>([]);
  const [shifts, setShifts] = useState<ShiftRow[]>([]);
  const [rangeDays, setRangeDays] = useState(7);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [editing, setEditing] = useState<EditState | null>(null);
  const [cashEditing, setCashEditing] = useState<CashEditState | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);

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

  useEffect(() => {
    void load(rangeDays);
  }, [rangeDays]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30 * 1000);
    return () => clearInterval(id);
  }, []);

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

  const startEdit = (row: ShiftRow) => {
    setEditing({
      id: row.id,
      clockIn: toLocalInputValue(row.clock_in_at),
      clockOut: toLocalInputValue(row.clock_out_at),
      notes: row.notes || '',
    });
  };

  const cancelEdit = () => setEditing(null);

  const startCashEdit = (row: ShiftRow) => {
    setCashEditing({
      shiftId: row.id,
      employeeName: row.employee_name,
      isClosed: Boolean(row.clock_out_at),
      hadClosingCounts: Boolean(row.cash_drawer?.closing_counts),
      openingCounts: normalizeCounts(row.cash_drawer?.opening_counts),
      closingCounts: normalizeCounts(row.cash_drawer?.closing_counts),
      varianceNote: row.cash_drawer?.variance_note || '',
      expectedCashTotal: row.cash_drawer?.expected_cash_total ?? row.cash_drawer_preview?.expected_cash_total ?? 0,
    });
  };

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
    <div className="min-h-screen bg-neutral-950">
      <div className="bg-neutral-900 text-white p-6 border-b border-neutral-800">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link to="/admin" className="p-2 hover:bg-neutral-800 rounded-lg transition-colors">
              <ArrowLeft size={24} />
            </Link>
            <div>
              <h1 className="text-3xl font-black tracking-tighter">Time Clock</h1>
              <p className="text-sm text-neutral-400 mt-1">Who is on shift now and hours worked.</p>
            </div>
          </div>
          <BrandLogo className="h-10" />
        </div>
      </div>

      <div className="max-w-6xl mx-auto p-6 space-y-6">
        {error && (
          <div className="rounded-xl border border-red-900 bg-red-950/40 px-4 py-3 text-sm text-red-300">
            {error}
          </div>
        )}

        {flagged.length > 0 && (
          <div className="rounded-xl border border-amber-800 bg-amber-950/40 px-4 py-3 flex items-start gap-3">
            <AlertTriangle size={18} className="text-amber-400 mt-0.5 shrink-0" />
            <div className="text-sm text-amber-200">
              <p className="font-semibold">{flagged.length} shift(s) open more than 12 hours</p>
              <p className="mt-1 text-amber-300/80">Likely forgot to clock out. Edit the row to set the correct clock-out time.</p>
            </div>
          </div>
        )}

        <section>
          <h2 className="text-lg font-bold text-white mb-3 flex items-center gap-2">
            <Users size={18} className="text-brand-500" />
            On shift now <span className="text-neutral-500 font-normal text-sm">({liveActive.length})</span>
          </h2>
          {liveActive.length === 0 ? (
            <div className="rounded-xl border border-dashed border-neutral-800 px-4 py-8 text-sm text-neutral-500 text-center">
              Nobody is currently clocked in.
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {liveActive.map(a => (
                <div key={a.id} className="rounded-xl border border-green-800 bg-green-950/20 p-4">
                  <p className="text-xs uppercase tracking-wide text-green-400">{a.employee_role}</p>
                  <p className="text-xl font-bold text-white mt-1">{a.employee_name}</p>
                  <p className="text-sm text-neutral-300 mt-2">
                    Since {formatDateTime(a.clock_in_at)} · <span className="text-green-300">{formatDuration(a.elapsed_seconds)}</span>
                  </p>
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
                    rangeDays === opt.days
                      ? 'bg-brand-600 text-white'
                      : 'text-neutral-400 hover:text-white'
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
                          <span className="text-[11px] px-2 py-0.5 rounded-full bg-green-950/60 border border-green-800 text-green-300">
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
                  <tr key={row.id} className={`border-t border-neutral-800 ${row.flagged_long_open ? 'bg-amber-950/10' : ''}`}>
                      <td className="px-4 py-3 text-white">{row.employee_name}</td>
                      <td className="px-4 py-3 text-neutral-300 tabular-nums">{formatDateTime(row.clock_in_at)}</td>
                      <td className="px-4 py-3 text-neutral-300 tabular-nums">
                        {row.clock_out_at ? formatDateTime(row.clock_out_at) : (
                          <span className={row.flagged_long_open ? 'text-amber-400 font-medium' : 'text-green-400'}>
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
                              <span className={`block font-semibold ${row.cash_drawer.variance_total === 0 ? 'text-neutral-300' : (row.cash_drawer.variance_total || 0) > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                Over / short: {row.cash_drawer.variance_total != null && row.cash_drawer.variance_total > 0 ? '+' : ''}{formatMoney(row.cash_drawer.variance_total)}
                              </span>
                              {row.cash_drawer.variance_note && (
                                <span className="block text-[11px] text-amber-300">Manager note: {row.cash_drawer.variance_note}</span>
                              )}
                            </>
                          ) : (
                            <span className="block text-neutral-600">No closeout recorded</span>
                          )}
                        </div>
                        {row.notes && <span className="block mt-2">{row.notes}</span>}
                        {row.edited_by_name && (
                          <span className="block text-[10px] text-neutral-600 mt-0.5">
                            edited by {row.edited_by_name}
                          </span>
                        )}
                      </td>
                      {canEdit && (
                        <td className="px-4 py-3 text-right">
                          <div className="flex items-center justify-end gap-3">
                            <button
                              onClick={() => startCashEdit(row)}
                              className="text-neutral-400 hover:text-white inline-flex items-center gap-1 text-xs"
                            >
                              <Wallet size={14} />
                              Closeout
                            </button>
                            <button
                              onClick={() => startEdit(row)}
                              className="text-neutral-400 hover:text-white inline-flex items-center gap-1 text-xs"
                            >
                              <Pencil size={14} />
                              Edit
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
      </div>

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
                    <span className={`font-bold ${variance === 0 ? 'text-white' : variance > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
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
    </div>
  );
}
