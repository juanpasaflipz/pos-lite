import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Lock, AlertTriangle, ChevronLeft, ChevronRight } from 'lucide-react';
import {
  getPayrollLive,
  getPayrollPeriod,
  listPayrollPeriods,
  closePayrollPeriod,
  exportPayrollPeriodCsv,
} from '../../api';
import { PayrollSnapshot, PayrollPeriodsList, PayrollClosedPeriod } from '../../types';

const money = (cents: number) =>
  new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format((cents || 0) / 100);

const hoursFmt = (h: number) => `${(h || 0).toFixed(2)}h`;

function shiftWeeks(dateStr: string, weeks: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + weeks * 7);
  return dt.toISOString().slice(0, 10);
}

function downloadBlob(blob: Blob, filename: string) {
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.URL.revokeObjectURL(url);
}

/**
 * Full payroll tab. Defaults to the current open week (live snapshot, no period_id).
 * Manager can step back to prior weeks. Closed weeks render the frozen snapshot.
 * "Close period" is only available for completed weeks (period_end <= today).
 */
export default function PayrollTab() {
  const { t } = useTranslation('reports');
  const [periodsList, setPeriodsList] = useState<PayrollPeriodsList | null>(null);
  // currentWindow = the window the user is viewing. null means "live current week".
  const [window, setWindow] = useState<{ start: string; end: string } | null>(null);
  const [snapshot, setSnapshot] = useState<PayrollSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);

  const refreshList = async () => {
    const list = await listPayrollPeriods();
    setPeriodsList(list);
    return list;
  };

  useEffect(() => {
    refreshList().catch(err => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const data = window
          ? await getPayrollPeriod(window.start, window.end)
          : await getPayrollLive();
        if (!cancelled) setSnapshot(data);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [window]);

  const isLiveCurrent = window === null;
  const today = new Date().toISOString().slice(0, 10);
  const viewedEnd = snapshot?.period_end || periodsList?.current.period_end;
  const isCompletedWeek = !!viewedEnd && viewedEnd <= today;
  const isFrozen = !!snapshot?.frozen;

  // Find the matching closed period (if any) for export.
  const matchingClosed: PayrollClosedPeriod | undefined = useMemo(() => {
    if (!snapshot || !periodsList) return undefined;
    return periodsList.closed.find(
      p => p.period_start === snapshot.period_start && p.period_end === snapshot.period_end,
    );
  }, [snapshot, periodsList]);

  const onPrev = () => {
    const start = snapshot?.period_start || periodsList?.current.period_start;
    if (!start) return;
    setWindow({ start: shiftWeeks(start, -1), end: start });
  };
  const onNext = () => {
    if (!snapshot) return;
    const nextStart = snapshot.period_end;
    const nextEnd = shiftWeeks(nextStart, 1);
    // If next week is the live current week, clear window to use /live.
    if (periodsList && nextStart === periodsList.current.period_start) {
      setWindow(null);
    } else if (nextStart > today) {
      // refuse to navigate past today
      return;
    } else {
      setWindow({ start: nextStart, end: nextEnd });
    }
  };

  const onJumpToCurrent = () => setWindow(null);

  const onClosePeriod = async () => {
    if (!snapshot) return;
    if (!confirm(t('payroll.confirmClose', { start: snapshot.period_start, end: snapshot.period_end }))) return;
    setClosing(true);
    try {
      await closePayrollPeriod(snapshot.period_start, snapshot.period_end);
      await refreshList();
      const fresh = await getPayrollPeriod(snapshot.period_start, snapshot.period_end);
      setSnapshot(fresh);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setClosing(false);
    }
  };

  const onExport = async () => {
    if (!matchingClosed) return;
    const blob = await exportPayrollPeriodCsv(matchingClosed.id);
    downloadBlob(blob, `payroll_${matchingClosed.period_start}_${matchingClosed.period_end}.csv`);
  };

  if (loading || !snapshot) {
    return (
      <div className="space-y-4">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="h-32 bg-neutral-900 rounded-lg border border-neutral-800 animate-pulse" />
        ))}
      </div>
    );
  }

  const totals = snapshot.totals;
  const laborPct = totals.labor_pct_of_sales;
  const warn = snapshot.labor_warn_pct ?? 25;
  const critical = snapshot.labor_critical_pct ?? 30;
  const laborTone =
    laborPct == null ? 'text-neutral-300' :
    laborPct >= critical ? 'text-red-400' :
    laborPct >= warn ? 'text-amber-400' : 'text-emerald-400';

  return (
    <div className="space-y-6">
      {error && (
        <div className="bg-red-900/30 border border-red-800 rounded-lg p-3 text-red-300 text-sm">{error}</div>
      )}

      {/* Period nav + actions */}
      <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-4 flex flex-wrap items-center gap-3">
        <button
          onClick={onPrev}
          className="p-2 rounded-md bg-neutral-800 hover:bg-neutral-700 text-neutral-200"
          aria-label={t('payroll.nav.prev')}
        >
          <ChevronLeft size={18} />
        </button>
        <div>
          <div className="text-xs text-neutral-500 uppercase tracking-wide">
            {isLiveCurrent ? t('payroll.nav.thisWeek') : t('payroll.nav.week')}
          </div>
          <div className="text-white font-semibold">
            {snapshot.period_start} → {snapshot.period_end}
          </div>
        </div>
        <button
          onClick={onNext}
          disabled={isLiveCurrent}
          className="p-2 rounded-md bg-neutral-800 hover:bg-neutral-700 text-neutral-200 disabled:opacity-30 disabled:cursor-not-allowed"
          aria-label={t('payroll.nav.next')}
        >
          <ChevronRight size={18} />
        </button>
        {!isLiveCurrent && (
          <button
            onClick={onJumpToCurrent}
            className="px-3 py-1.5 rounded-md bg-neutral-800 hover:bg-neutral-700 text-sm text-neutral-200"
          >
            {t('payroll.nav.jumpCurrent')}
          </button>
        )}

        <div className="ml-auto flex items-center gap-2">
          {isFrozen && (
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-blue-900/30 border border-blue-800/50 text-blue-300 text-xs">
              <Lock size={12} /> {t('payroll.frozen')}
            </span>
          )}
          {!isFrozen && isCompletedWeek && (
            <button
              onClick={onClosePeriod}
              disabled={closing}
              className="px-3 py-2 rounded-md bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium flex items-center gap-2 disabled:opacity-50"
            >
              <Lock size={16} /> {closing ? '...' : t('payroll.closeBtn')}
            </button>
          )}
          {matchingClosed && (
            <button
              onClick={onExport}
              className="px-3 py-2 rounded-md bg-neutral-800 hover:bg-neutral-700 text-white text-sm font-medium flex items-center gap-2"
            >
              <Download size={16} /> {t('payroll.exportCsv')}
            </button>
          )}
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <div className="bg-neutral-900 p-4 rounded-lg border border-neutral-800">
          <p className="text-xs text-neutral-400 uppercase tracking-wide">{t('payroll.kpi.basePay')}</p>
          <p className="text-2xl font-bold text-white mt-1">{money(totals.base_pay_cents)}</p>
        </div>
        <div className="bg-neutral-900 p-4 rounded-lg border border-neutral-800">
          <p className="text-xs text-neutral-400 uppercase tracking-wide">{t('payroll.kpi.tipPool')}</p>
          <p className="text-2xl font-bold text-white mt-1">{money(snapshot.tip_pool_cents)}</p>
          <p className="text-xs text-neutral-500 mt-1">{t(`payroll.tipPolicy.${snapshot.tip_policy}`)}</p>
        </div>
        <div className="bg-neutral-900 p-4 rounded-lg border border-neutral-800">
          <p className="text-xs text-neutral-400 uppercase tracking-wide">{t('payroll.kpi.hours')}</p>
          <p className="text-2xl font-bold text-white mt-1">{hoursFmt(totals.hours_worked)}</p>
          {totals.hours_overtime > 0 && (
            <p className="text-xs text-amber-400 mt-1">
              {t('payroll.kpi.otHours', { hours: hoursFmt(totals.hours_overtime) })}
            </p>
          )}
        </div>
        <div className="bg-neutral-900 p-4 rounded-lg border border-neutral-800">
          <p className="text-xs text-neutral-400 uppercase tracking-wide">{t('payroll.kpi.sales')}</p>
          <p className="text-2xl font-bold text-white mt-1">{money(snapshot.sales_cents)}</p>
        </div>
        <div className="bg-neutral-900 p-4 rounded-lg border border-neutral-800">
          <p className="text-xs text-neutral-400 uppercase tracking-wide">{t('payroll.kpi.laborPct')}</p>
          <p className={`text-2xl font-bold mt-1 ${laborTone}`}>
            {laborPct != null ? `${laborPct.toFixed(1)}%` : '—'}
          </p>
          <p className="text-xs text-neutral-500 mt-1">{t('payroll.kpi.targetThresholds', { warn, critical })}</p>
        </div>
      </div>

      {/* Per-employee table */}
      <div className="bg-neutral-900 border border-neutral-800 rounded-lg overflow-hidden">
        <div className="p-4 border-b border-neutral-800">
          <h3 className="text-lg font-bold text-white">{t('payroll.tableTitle')}</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-neutral-900/80">
              <tr className="text-left text-xs uppercase tracking-wide text-neutral-500 border-b border-neutral-800">
                <th className="px-4 py-3 font-medium">{t('payroll.table.employee')}</th>
                <th className="px-4 py-3 font-medium">{t('payroll.table.payType')}</th>
                <th className="px-4 py-3 font-medium text-right">{t('payroll.table.rate')}</th>
                <th className="px-4 py-3 font-medium text-right">{t('payroll.table.hours')}</th>
                <th className="px-4 py-3 font-medium text-right">{t('payroll.table.ot')}</th>
                <th className="px-4 py-3 font-medium text-right">{t('payroll.table.basePay')}</th>
                <th className="px-4 py-3 font-medium text-right">{t('payroll.table.tipShare')}</th>
                <th className="px-4 py-3 font-medium text-right">{t('payroll.table.total')}</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.employees.map(e => (
                <tr key={e.employee_id} className="border-t border-neutral-800/60 hover:bg-neutral-800/30">
                  <td className="px-4 py-3 text-neutral-100">
                    <div className="flex items-center gap-2">
                      <span>{e.employee_name}</span>
                      {e.has_open_shift && (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-emerald-900/40 text-emerald-300">
                          {t('payroll.table.onClock')}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-neutral-500">{e.employee_role}</p>
                  </td>
                  <td className="px-4 py-3 text-neutral-300">{t(`payroll.payType.${e.pay_type}`)}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-neutral-300">
                    {e.pay_type === 'hourly' && `${money(e.hourly_rate_cents)}/h`}
                    {e.pay_type === 'salary' && `${money(e.weekly_salary_cents)}/wk`}
                    {(e.pay_type === 'commission' || e.pay_type === 'no_pay') && '—'}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-neutral-200">{hoursFmt(e.hours_worked)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {e.hours_overtime > 0 ? (
                      <span className="inline-flex items-center gap-1 text-amber-400">
                        <AlertTriangle size={12} /> {hoursFmt(e.hours_overtime)}
                      </span>
                    ) : (
                      <span className="text-neutral-600">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-neutral-200">{money(e.base_pay_cents)}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-neutral-200">{money(e.tip_share_cents)}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-white font-semibold">{money(e.total_cents)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-neutral-900/80 border-t-2 border-neutral-700">
              <tr>
                <td className="px-4 py-3 font-bold text-white" colSpan={3}>{t('payroll.table.totals')}</td>
                <td className="px-4 py-3 text-right tabular-nums text-white font-bold">{hoursFmt(totals.hours_worked)}</td>
                <td className="px-4 py-3 text-right tabular-nums text-amber-400 font-bold">
                  {totals.hours_overtime > 0 ? hoursFmt(totals.hours_overtime) : '—'}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-white font-bold">{money(totals.base_pay_cents)}</td>
                <td className="px-4 py-3 text-right tabular-nums text-white font-bold">{money(totals.tip_share_cents)}</td>
                <td className="px-4 py-3 text-right tabular-nums text-white font-bold">{money(totals.total_cents)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {totals.hours_overtime > 0 && (
        <div className="bg-amber-900/20 border border-amber-800/60 rounded-lg p-4 flex items-start gap-3">
          <AlertTriangle size={20} className="text-amber-400 flex-shrink-0 mt-0.5" />
          <div className="text-sm text-amber-200">
            <p className="font-semibold">{t('payroll.otAdvisory.title')}</p>
            <p className="mt-1">
              {t('payroll.otAdvisory.body', { threshold: snapshot.overtime_threshold_hours ?? 48 })}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
