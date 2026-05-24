import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Users, AlertTriangle, ChevronDown, ChevronUp } from 'lucide-react';
import { Link } from 'react-router-dom';
import { getPayrollLive } from '../../api';
import { PayrollSnapshot } from '../../types';

const money = (cents: number) =>
  new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format((cents || 0) / 100);

const hoursFmt = (h: number) => `${(h || 0).toFixed(1)}h`;

/**
 * Always-visible labor cost strip at the top of Reports → Overview.
 * Hits /api/payroll/live (gated by manage_payroll on the server, so this is
 * a no-op for non-managers — we render a placeholder instead of erroring).
 */
export default function LaborStrip() {
  const { t } = useTranslation('reports');
  const [data, setData] = useState<PayrollSnapshot | null>(null);
  const [denied, setDenied] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const snap = await getPayrollLive();
        if (!cancelled) setData(snap);
      } catch (err) {
        const status = (err as { status?: number })?.status;
        if (status === 403) {
          if (!cancelled) setDenied(true);
        }
      }
    };
    load();
    const interval = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  if (denied) return null;
  if (!data) {
    return (
      <div className="bg-neutral-900 rounded-lg border border-neutral-800 p-4 h-20 animate-pulse" />
    );
  }

  const laborPct = data.totals.labor_pct_of_sales;
  const warn = data.labor_warn_pct ?? 25;
  const critical = data.labor_critical_pct ?? 30;
  let tone: 'good' | 'warn' | 'critical' = 'good';
  if (laborPct != null) {
    if (laborPct >= critical) tone = 'critical';
    else if (laborPct >= warn) tone = 'warn';
  }
  const toneClasses = {
    good: { ring: 'border-emerald-700/50', bg: 'bg-emerald-900/20', text: 'text-emerald-400' },
    warn: { ring: 'border-amber-700/50', bg: 'bg-amber-900/20', text: 'text-amber-400' },
    critical: { ring: 'border-red-700/50', bg: 'bg-red-900/20', text: 'text-red-400' },
  }[tone];

  const onClockCount = data.employees.filter(e => e.has_open_shift).length;
  const overtimeEmployees = data.employees.filter(e => e.hours_overtime > 0);

  return (
    <div className={`bg-neutral-900 rounded-lg border ${toneClasses.ring} overflow-hidden`}>
      <div className={`p-4 ${toneClasses.bg}`}>
        <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
          <div>
            <p className="text-xs uppercase tracking-wide text-neutral-400 font-semibold">
              {t('payroll.laborStrip.weekLabor')}
            </p>
            <p className="text-2xl font-bold text-white mt-1">
              {money(data.totals.base_pay_cents)}
              {laborPct != null && (
                <span className={`ml-2 text-lg font-semibold ${toneClasses.text}`}>
                  {laborPct.toFixed(1)}%
                </span>
              )}
            </p>
            <p className="text-xs text-neutral-500 mt-1">
              {t('payroll.laborStrip.ofSales', { sales: money(data.sales_cents) })}
            </p>
          </div>

          <div>
            <p className="text-xs uppercase tracking-wide text-neutral-400 font-semibold">
              {t('payroll.laborStrip.hours')}
            </p>
            <p className="text-2xl font-bold text-white mt-1">{hoursFmt(data.totals.hours_worked)}</p>
            <p className="text-xs text-neutral-500 mt-1">
              {t('payroll.laborStrip.period', {
                start: data.period_start,
                end: data.period_end,
              })}
            </p>
          </div>

          <div>
            <p className="text-xs uppercase tracking-wide text-neutral-400 font-semibold">
              {t('payroll.laborStrip.tipPool')}
            </p>
            <p className="text-2xl font-bold text-white mt-1">{money(data.tip_pool_cents)}</p>
            <p className="text-xs text-neutral-500 mt-1">{t(`payroll.tipPolicy.${data.tip_policy}`)}</p>
          </div>

          <button
            onClick={() => setExpanded(v => !v)}
            className="ml-auto flex items-center gap-2 px-3 py-2 rounded-md bg-neutral-800 hover:bg-neutral-700 text-sm text-neutral-200"
          >
            <Users size={16} />
            <span>{t('payroll.laborStrip.onClock', { count: onClockCount })}</span>
            {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
        </div>

        {overtimeEmployees.length > 0 && (
          <div className="mt-3 flex items-start gap-2 text-sm text-amber-300">
            <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />
            <span>
              {t('payroll.laborStrip.overtimeAlert', {
                names: overtimeEmployees.map(e => `${e.employee_name} (${hoursFmt(e.hours_worked)})`).join(', '),
                threshold: data.overtime_threshold_hours,
              })}
            </span>
          </div>
        )}
      </div>

      {expanded && (
        <div className="border-t border-neutral-800 p-4">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-neutral-500">
                <th className="pb-2 font-medium">{t('payroll.table.employee')}</th>
                <th className="pb-2 font-medium text-right">{t('payroll.table.hours')}</th>
                <th className="pb-2 font-medium text-right">{t('payroll.table.basePay')}</th>
                <th className="pb-2 font-medium text-right">{t('payroll.table.tipShare')}</th>
                <th className="pb-2 font-medium text-right">{t('payroll.table.total')}</th>
              </tr>
            </thead>
            <tbody>
              {data.employees.map(e => (
                <tr key={e.employee_id} className="border-t border-neutral-800/60">
                  <td className="py-2 text-neutral-200">
                    {e.employee_name}
                    {e.has_open_shift && (
                      <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-emerald-900/40 text-emerald-300">
                        {t('payroll.table.onClock')}
                      </span>
                    )}
                    {e.hours_overtime > 0 && (
                      <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-amber-900/40 text-amber-300">
                        OT
                      </span>
                    )}
                  </td>
                  <td className="py-2 text-right text-neutral-200 tabular-nums">{hoursFmt(e.hours_worked)}</td>
                  <td className="py-2 text-right text-neutral-200 tabular-nums">{money(e.base_pay_cents)}</td>
                  <td className="py-2 text-right text-neutral-200 tabular-nums">{money(e.tip_share_cents)}</td>
                  <td className="py-2 text-right text-white font-semibold tabular-nums">{money(e.total_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-3 text-right">
            <Link to="/reports?tab=payroll" className="text-sm text-brand-400 hover:text-brand-300">
              {t('payroll.laborStrip.fullPayroll')} →
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
