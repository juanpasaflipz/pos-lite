import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Calendar, ChevronLeft, ChevronRight, Plus, Save, Trash2, X } from 'lucide-react';
import {
  createScheduledShift,
  deleteScheduledShift,
  getEmployees,
  getPayrollForecast,
  getScheduledShifts,
  updateScheduledShift,
} from '../../api';
import type { PayrollForecast } from '../../api';
import { useToast } from '../../context/ToastContext';
import type { Employee, ScheduledShiftRow } from '../../types';

import { formatCents as moneyMXN } from '../../utils/currency';

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfWeek(d: Date): Date {
  const date = new Date(d);
  date.setHours(0, 0, 0, 0);
  const dow = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - dow);
  return date;
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * DAY_MS);
}

function fmtDayLabel(d: Date, locale: string): string {
  return d.toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short' });
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fmtDuration(seconds: number | null | undefined): string {
  if (seconds == null) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m.toString().padStart(2, '0')}m`;
}

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(value: string): string {
  return new Date(value).toISOString();
}

function defaultDayTime(date: Date, hour: number, minute = 0): string {
  const d = new Date(date);
  d.setHours(hour, minute, 0, 0);
  return toLocalInput(d.toISOString());
}

interface EditState {
  id: number | null;
  employee_id: number;
  starts_at: string;
  ends_at: string;
  notes: string;
}

/**
 * Weekly schedule grid for the Staff hub.
 * Owner draws each week (no recurring template yet). Click a cell to add or
 * edit a scheduled shift; the shift log auto-links actual clock-ins to these
 * scheduled rows.
 */
export default function SchedulePanel() {
  const { i18n } = useTranslation();
  const { addToast } = useToast();
  const locale = i18n.language || 'en';

  const [weekStart, setWeekStart] = useState<Date>(() => startOfWeek(new Date()));
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [shifts, setShifts] = useState<ScheduledShiftRow[]>([]);
  const [forecast, setForecast] = useState<PayrollForecast | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<EditState | null>(null);
  const [saving, setSaving] = useState(false);

  const weekEnd = useMemo(() => addDays(weekStart, 7), [weekStart]);
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);

  const load = async () => {
    try {
      setLoading(true);
      const [emp, sched, fc] = await Promise.all([
        getEmployees(),
        getScheduledShifts({ from: weekStart.toISOString(), to: weekEnd.toISOString() }),
        getPayrollForecast({ from: weekStart.toISOString(), to: weekEnd.toISOString() })
          .catch(() => null),
      ]);
      setEmployees(emp.filter(e => e.active));
      setShifts(sched);
      setForecast(fc);
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Failed to load schedule', 'error');
    } finally {
      setLoading(false);
    }
  };

  const forecastByEmployee = useMemo(() => {
    const map = new Map<number, number>();
    if (forecast) {
      for (const e of forecast.employees) map.set(e.employee_id, e.cost_cents);
    }
    return map;
  }, [forecast]);

  useEffect(() => { void load(); }, [weekStart.getTime()]);

  const shiftsByCell = useMemo(() => {
    const map = new Map<string, ScheduledShiftRow[]>();
    for (const s of shifts) {
      const d = new Date(s.starts_at);
      d.setHours(0, 0, 0, 0);
      const key = `${s.employee_id}:${d.toISOString()}`;
      const arr = map.get(key) || [];
      arr.push(s);
      map.set(key, arr);
    }
    return map;
  }, [shifts]);

  const totalsByEmployee = useMemo(() => {
    const map = new Map<number, { scheduled: number; worked: number; hasWorked: boolean }>();
    for (const s of shifts) {
      const cur = map.get(s.employee_id) || { scheduled: 0, worked: 0, hasWorked: false };
      cur.scheduled += s.scheduled_seconds || 0;
      if (s.actual_duration_seconds != null) {
        cur.worked += s.actual_duration_seconds;
        cur.hasWorked = true;
      } else if (s.shift_id) {
        cur.hasWorked = true;
      }
      map.set(s.employee_id, cur);
    }
    return map;
  }, [shifts]);

  const openAdd = (employeeId: number, day: Date) => {
    setEditing({
      id: null,
      employee_id: employeeId,
      starts_at: defaultDayTime(day, 9),
      ends_at: defaultDayTime(day, 17),
      notes: '',
    });
  };

  const openEdit = (row: ScheduledShiftRow) => {
    setEditing({
      id: row.id,
      employee_id: row.employee_id,
      starts_at: toLocalInput(row.starts_at),
      ends_at: toLocalInput(row.ends_at),
      notes: row.notes || '',
    });
  };

  const save = async () => {
    if (!editing) return;
    if (new Date(editing.ends_at) <= new Date(editing.starts_at)) {
      addToast('End time must be after start time', 'error');
      return;
    }
    try {
      setSaving(true);
      if (editing.id) {
        await updateScheduledShift(editing.id, {
          starts_at: fromLocalInput(editing.starts_at),
          ends_at: fromLocalInput(editing.ends_at),
          notes: editing.notes,
        });
      } else {
        await createScheduledShift({
          employee_id: editing.employee_id,
          starts_at: fromLocalInput(editing.starts_at),
          ends_at: fromLocalInput(editing.ends_at),
          notes: editing.notes || undefined,
        });
      }
      addToast('Schedule saved', 'success');
      setEditing(null);
      await load();
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Failed to save schedule', 'error');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!editing?.id) return;
    if (!confirm('Delete this scheduled shift?')) return;
    try {
      setSaving(true);
      await deleteScheduledShift(editing.id);
      addToast('Scheduled shift removed', 'success');
      setEditing(null);
      await load();
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Failed to delete', 'error');
    } finally {
      setSaving(false);
    }
  };

  const weekLabel = `${weekStart.toLocaleDateString(locale, { day: 'numeric', month: 'short' })} – ${addDays(weekStart, 6).toLocaleDateString(locale, { day: 'numeric', month: 'short' })}`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setWeekStart(addDays(weekStart, -7))}
            className="p-2 min-h-[40px] min-w-[40px] rounded-lg border border-neutral-800 bg-neutral-900 text-neutral-300 hover:bg-neutral-800"
            aria-label="Previous week"
          >
            <ChevronLeft size={18} />
          </button>
          <div className="flex items-center gap-2 text-white">
            <Calendar size={18} className="text-brand-500" />
            <span className="font-semibold">{weekLabel}</span>
          </div>
          <button
            onClick={() => setWeekStart(addDays(weekStart, 7))}
            className="p-2 min-h-[40px] min-w-[40px] rounded-lg border border-neutral-800 bg-neutral-900 text-neutral-300 hover:bg-neutral-800"
            aria-label="Next week"
          >
            <ChevronRight size={18} />
          </button>
          <button
            onClick={() => setWeekStart(startOfWeek(new Date()))}
            className="px-3 py-2 min-h-[40px] rounded-lg border border-neutral-800 bg-neutral-900 text-neutral-300 hover:bg-neutral-800 text-sm font-medium"
          >
            This week
          </button>
        </div>
      </div>

      {loading ? (
        <div className="rounded-xl border border-neutral-800 bg-neutral-900 px-4 py-12 text-center text-neutral-500">
          Loading schedule…
        </div>
      ) : employees.length === 0 ? (
        <div className="rounded-xl border border-dashed border-neutral-800 px-4 py-8 text-sm text-neutral-500 text-center">
          No active employees. Add staff in the Plantilla tab first.
        </div>
      ) : (
        <div className="rounded-xl border border-neutral-800 bg-neutral-900 overflow-x-auto">
          <table className="w-full text-sm min-w-[900px]">
            <thead className="bg-neutral-950 text-neutral-400 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left px-4 py-3 sticky left-0 bg-neutral-950 z-10 min-w-[200px]">Employee</th>
                {days.map(d => (
                  <th key={d.toISOString()} className="text-left px-3 py-3 font-medium">
                    {fmtDayLabel(d, locale)}
                  </th>
                ))}
                <th className="text-right px-4 py-3 min-w-[100px]">Total</th>
                <th className="text-right px-4 py-3 min-w-[110px]">Forecast cost</th>
              </tr>
            </thead>
            <tbody>
              {employees.map(emp => {
                const totals = totalsByEmployee.get(emp.id) || { scheduled: 0, worked: 0, hasWorked: false };
                return (
                  <tr key={emp.id} className="border-t border-neutral-800 align-top">
                    <td className="px-4 py-3 sticky left-0 bg-neutral-900 z-10">
                      <div className="text-white font-medium">{emp.name}</div>
                      <div className="text-neutral-500 text-xs">{emp.role}</div>
                    </td>
                    {days.map(day => {
                      const d = new Date(day);
                      d.setHours(0, 0, 0, 0);
                      const key = `${emp.id}:${d.toISOString()}`;
                      const cellShifts = shiftsByCell.get(key) || [];
                      return (
                        <td key={day.toISOString()} className="px-2 py-2 border-l border-neutral-800/60">
                          <div className="flex flex-col gap-1.5">
                            {cellShifts.map(s => {
                              const worked = s.actual_duration_seconds;
                              const openShift = s.shift_id != null && worked == null;
                              return (
                                <button
                                  key={s.id}
                                  onClick={() => openEdit(s)}
                                  className="text-left px-2 py-1.5 rounded-md border border-cockpit-blue/60 bg-cockpit-blue/20 hover:bg-cockpit-blue/30 transition-colors"
                                >
                                  <div className="text-cockpit-system-text text-xs font-semibold tabular-nums">
                                    {fmtTime(s.starts_at)} – {fmtTime(s.ends_at)}
                                  </div>
                                  {worked != null ? (
                                    <div className="text-[11px] tabular-nums">
                                      <span className="text-cockpit-in-text font-semibold">{fmtDuration(worked)} worked</span>
                                      <span className="text-neutral-500"> · plan {fmtDuration(s.scheduled_seconds)}</span>
                                    </div>
                                  ) : openShift ? (
                                    <div className="text-[11px] tabular-nums">
                                      <span className="text-cockpit-in-text font-semibold">on shift</span>
                                      <span className="text-neutral-500"> · plan {fmtDuration(s.scheduled_seconds)}</span>
                                    </div>
                                  ) : (
                                    <div className="text-neutral-400 text-[11px] tabular-nums">
                                      {fmtDuration(s.scheduled_seconds)}
                                    </div>
                                  )}
                                </button>
                              );
                            })}
                            <button
                              onClick={() => openAdd(emp.id, day)}
                              className="flex items-center justify-center gap-1 px-2 py-1 rounded-md border border-dashed border-neutral-700 text-neutral-500 hover:text-neutral-300 hover:border-neutral-500 text-xs min-h-[32px]"
                            >
                              <Plus size={12} /> Add
                            </button>
                          </div>
                        </td>
                      );
                    })}
                    <td className="px-4 py-3 text-right text-white font-semibold tabular-nums">
                      <div>{fmtDuration(totals.scheduled)}</div>
                      {totals.hasWorked && (
                        <div className="text-[11px] font-normal text-cockpit-in-text">
                          {fmtDuration(totals.worked)} worked
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right text-neutral-200 tabular-nums">
                      {forecastByEmployee.has(emp.id) ? moneyMXN(forecastByEmployee.get(emp.id) || 0) : '—'}
                    </td>
                  </tr>
                );
              })}
              {forecast && forecast.totals.cost_cents > 0 && (
                <tr className="border-t-2 border-neutral-700 bg-neutral-950">
                  <td className="px-4 py-3 sticky left-0 bg-neutral-950 z-10 text-neutral-400 uppercase text-xs tracking-wide font-semibold">
                    Week forecast
                  </td>
                  <td colSpan={7} />
                  <td className="px-4 py-3 text-right text-white font-bold tabular-nums">
                    {fmtDuration(Math.round(forecast.totals.hours_scheduled * 3600))}
                  </td>
                  <td className="px-4 py-3 text-right text-white font-bold tabular-nums">
                    {moneyMXN(forecast.totals.cost_cents)}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50">
          <div className="bg-neutral-900 rounded-2xl border border-neutral-800 max-w-md w-full p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xl font-bold text-white">
                {editing.id ? 'Edit scheduled shift' : 'Add scheduled shift'}
              </h3>
              <button onClick={() => setEditing(null)} className="text-neutral-500 hover:text-neutral-300">
                <X size={20} />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-neutral-300 mb-2">Employee</label>
                <div className="px-3 py-2 bg-neutral-950 border border-neutral-800 rounded-lg text-white">
                  {employees.find(e => e.id === editing.employee_id)?.name || 'Unknown'}
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-neutral-300 mb-2">Starts</label>
                <input
                  type="datetime-local"
                  value={editing.starts_at}
                  onChange={e => setEditing({ ...editing, starts_at: e.target.value })}
                  className="w-full px-3 py-2 bg-neutral-950 border border-neutral-800 rounded-lg text-white focus:outline-none focus:border-brand-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-neutral-300 mb-2">Ends</label>
                <input
                  type="datetime-local"
                  value={editing.ends_at}
                  onChange={e => setEditing({ ...editing, ends_at: e.target.value })}
                  className="w-full px-3 py-2 bg-neutral-950 border border-neutral-800 rounded-lg text-white focus:outline-none focus:border-brand-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-neutral-300 mb-2">Notes</label>
                <input
                  type="text"
                  value={editing.notes}
                  onChange={e => setEditing({ ...editing, notes: e.target.value })}
                  placeholder="optional"
                  className="w-full px-3 py-2 bg-neutral-950 border border-neutral-800 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:border-brand-500"
                />
              </div>
            </div>

            <div className="flex gap-3 mt-6">
              {editing.id && (
                <button
                  onClick={remove}
                  disabled={saving}
                  className="px-4 py-2 border border-cockpit-red/60 text-cockpit-out-text rounded-lg hover:bg-cockpit-red/20 transition-colors inline-flex items-center gap-2"
                >
                  <Trash2 size={16} />
                </button>
              )}
              <button
                onClick={() => setEditing(null)}
                disabled={saving}
                className="flex-1 px-4 py-2 border border-neutral-700 text-neutral-300 rounded-lg hover:bg-neutral-800 transition-colors font-medium"
              >
                Cancel
              </button>
              <button
                onClick={save}
                disabled={saving}
                className="flex-1 px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-500 transition-colors font-medium disabled:opacity-60 inline-flex items-center justify-center gap-2"
              >
                <Save size={16} />
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
