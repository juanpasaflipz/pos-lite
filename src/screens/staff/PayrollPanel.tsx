import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Save } from 'lucide-react';
import {
  getPayrollSettings, updatePayrollSettings,
  getPayrollRates, updateEmployeePayRate,
} from '../../api';
import { PayrollSettings, PayrollRateRow, PayType, TipPolicy } from '../../types';

const TIP_POLICIES: TipPolicy[] = ['pool_by_hours', 'pool_equal', 'taker_keeps', 'house_keeps'];
const PAY_TYPES: PayType[] = ['hourly', 'salary', 'commission', 'no_pay'];
const DOWS = [
  { value: 1, key: 'mon' }, { value: 2, key: 'tue' }, { value: 3, key: 'wed' },
  { value: 4, key: 'thu' }, { value: 5, key: 'fri' }, { value: 6, key: 'sat' },
  { value: 0, key: 'sun' },
];

const centsToInput = (cents: number) => ((cents || 0) / 100).toFixed(2);
const inputToCents = (value: string) => {
  const n = parseFloat(value);
  if (!isFinite(n) || n < 0) return 0;
  return Math.round(n * 100);
};

/**
 * Payroll panel for the Staff hub. Tenant-wide settings + per-employee rate
 * editor (PIN/role lives in the Roster tab; this tab focuses on money).
 */
export default function PayrollPanel() {
  const { t } = useTranslation(['admin', 'reports']);
  const [settings, setSettings] = useState<PayrollSettings | null>(null);
  const [rates, setRates] = useState<PayrollRateRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<number | null>(null);
  const [savedFlash, setSavedFlash] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<number, { pay_type: PayType; hourly: string; weekly: string }>>({});

  const load = async () => {
    setLoading(true);
    try {
      const [s, r] = await Promise.all([getPayrollSettings(), getPayrollRates()]);
      setSettings(s);
      setRates(r);
      const buf: typeof edits = {};
      for (const row of r) {
        buf[row.employee_id] = {
          pay_type: row.pay_type,
          hourly: centsToInput(row.hourly_rate_cents),
          weekly: centsToInput(row.weekly_salary_cents),
        };
      }
      setEdits(buf);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const flash = (msg: string) => {
    setSavedFlash(msg);
    setTimeout(() => setSavedFlash(null), 2200);
  };

  const onSaveSettings = async () => {
    if (!settings) return;
    try {
      const updated = await updatePayrollSettings(settings);
      setSettings(updated);
      flash(t('payroll.savedSettings'));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onSaveRate = async (employeeId: number) => {
    const buf = edits[employeeId];
    if (!buf) return;
    setSavingId(employeeId);
    try {
      await updateEmployeePayRate(employeeId, {
        pay_type: buf.pay_type,
        hourly_rate_cents: inputToCents(buf.hourly),
        weekly_salary_cents: inputToCents(buf.weekly),
      });
      flash(t('payroll.savedRate'));
      const fresh = await getPayrollRates();
      setRates(fresh);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingId(null);
    }
  };

  if (loading || !settings) {
    return <div className="h-24 bg-neutral-900 rounded-lg border border-neutral-800 animate-pulse" />;
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="bg-cockpit-red/30 border border-cockpit-red rounded-lg p-3 text-cockpit-red text-sm">{error}</div>
      )}
      {savedFlash && (
        <div className="bg-cockpit-green/30 border border-cockpit-green rounded-lg p-3 text-cockpit-green text-sm">{savedFlash}</div>
      )}

      <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-6 space-y-4">
        <h2 className="text-xl font-bold text-white">{t('payroll.settings.title')}</h2>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-semibold text-neutral-400 mb-1 uppercase tracking-wide">
              {t('payroll.settings.tipPolicy')}
            </label>
            <select
              value={settings.tip_policy}
              onChange={e => setSettings({ ...settings, tip_policy: e.target.value as TipPolicy })}
              className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-3 py-2 text-white"
            >
              {TIP_POLICIES.map(p => (
                <option key={p} value={p}>{t(`reports:payroll.tipPolicy.${p}`)}</option>
              ))}
            </select>
            <p className="text-xs text-neutral-500 mt-1">{t('payroll.settings.tipPolicyHint')}</p>
          </div>

          <div>
            <label className="block text-xs font-semibold text-neutral-400 mb-1 uppercase tracking-wide">
              {t('payroll.settings.periodStartDow')}
            </label>
            <select
              value={settings.period_start_dow}
              onChange={e => setSettings({ ...settings, period_start_dow: Number(e.target.value) })}
              className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-3 py-2 text-white"
            >
              {DOWS.map(d => (
                <option key={d.value} value={d.value}>{t(`payroll.dow.${d.key}`)}</option>
              ))}
            </select>
            <p className="text-xs text-neutral-500 mt-1">{t('payroll.settings.periodStartHint')}</p>
          </div>

          <div>
            <label className="block text-xs font-semibold text-neutral-400 mb-1 uppercase tracking-wide">
              {t('payroll.settings.overtimeThreshold')}
            </label>
            <input
              type="number" min={0} max={168} step={0.5}
              value={settings.overtime_threshold_hours}
              onChange={e => setSettings({ ...settings, overtime_threshold_hours: Number(e.target.value) })}
              className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-3 py-2 text-white tabular-nums"
            />
            <p className="text-xs text-neutral-500 mt-1">{t('payroll.settings.overtimeHint')}</p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-neutral-400 mb-1 uppercase tracking-wide">
                {t('payroll.settings.warnPct')}
              </label>
              <input
                type="number" min={0} max={100} step={0.5}
                value={settings.labor_warn_pct}
                onChange={e => setSettings({ ...settings, labor_warn_pct: Number(e.target.value) })}
                className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-3 py-2 text-white tabular-nums"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-neutral-400 mb-1 uppercase tracking-wide">
                {t('payroll.settings.criticalPct')}
              </label>
              <input
                type="number" min={0} max={100} step={0.5}
                value={settings.labor_critical_pct}
                onChange={e => setSettings({ ...settings, labor_critical_pct: Number(e.target.value) })}
                className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-3 py-2 text-white tabular-nums"
              />
            </div>
          </div>
        </div>

        <button
          onClick={onSaveSettings}
          className="px-4 py-2 bg-brand-600 hover:bg-brand-700 rounded-md text-white font-medium flex items-center gap-2"
        >
          <Save size={16} /> {t('payroll.settings.save')}
        </button>
      </div>

      <div className="bg-neutral-900 border border-neutral-800 rounded-lg overflow-hidden">
        <div className="p-6 border-b border-neutral-800">
          <h2 className="text-xl font-bold text-white">{t('payroll.rates.title')}</h2>
          <p className="text-sm text-neutral-400 mt-1">{t('payroll.rates.subtitle')}</p>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-neutral-900/80">
              <tr className="text-left text-xs uppercase tracking-wide text-neutral-500 border-b border-neutral-800">
                <th className="px-4 py-3 font-medium">{t('payroll.rates.employee')}</th>
                <th className="px-4 py-3 font-medium">{t('payroll.rates.payType')}</th>
                <th className="px-4 py-3 font-medium">{t('payroll.rates.hourly')}</th>
                <th className="px-4 py-3 font-medium">{t('payroll.rates.weekly')}</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {rates.map(row => {
                const buf = edits[row.employee_id];
                if (!buf) return null;
                const dirty =
                  buf.pay_type !== row.pay_type ||
                  inputToCents(buf.hourly) !== row.hourly_rate_cents ||
                  inputToCents(buf.weekly) !== row.weekly_salary_cents;
                return (
                  <tr key={row.employee_id} className="border-t border-neutral-800/60">
                    <td className="px-4 py-3">
                      <p className="text-neutral-100">{row.employee_name}</p>
                      <p className="text-xs text-neutral-500">{row.role}</p>
                    </td>
                    <td className="px-4 py-3">
                      <select
                        value={buf.pay_type}
                        onChange={e => setEdits({ ...edits, [row.employee_id]: { ...buf, pay_type: e.target.value as PayType } })}
                        className="bg-neutral-800 border border-neutral-700 rounded-md px-2 py-1.5 text-neutral-200"
                      >
                        {PAY_TYPES.map(pt => (
                          <option key={pt} value={pt}>{t(`reports:payroll.payType.${pt}`)}</option>
                        ))}
                      </select>
                    </td>
                    <td className="px-4 py-3">
                      <input
                        type="number" min={0} step={0.01}
                        value={buf.hourly}
                        disabled={buf.pay_type !== 'hourly'}
                        onChange={e => setEdits({ ...edits, [row.employee_id]: { ...buf, hourly: e.target.value } })}
                        className="w-28 bg-neutral-800 border border-neutral-700 rounded-md px-2 py-1.5 text-neutral-200 tabular-nums disabled:opacity-40"
                      />
                    </td>
                    <td className="px-4 py-3">
                      <input
                        type="number" min={0} step={0.01}
                        value={buf.weekly}
                        disabled={buf.pay_type !== 'salary'}
                        onChange={e => setEdits({ ...edits, [row.employee_id]: { ...buf, weekly: e.target.value } })}
                        className="w-32 bg-neutral-800 border border-neutral-700 rounded-md px-2 py-1.5 text-neutral-200 tabular-nums disabled:opacity-40"
                      />
                    </td>
                    <td className="px-4 py-3">
                      <button
                        disabled={!dirty || savingId === row.employee_id}
                        onClick={() => onSaveRate(row.employee_id)}
                        className="px-3 py-1.5 rounded-md bg-brand-600 hover:bg-brand-700 text-white text-sm disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        {savingId === row.employee_id ? '...' : t('payroll.rates.save')}
                      </button>
                    </td>
                  </tr>
                );
              })}
              {rates.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-neutral-500">
                    {t('payroll.rates.empty')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
