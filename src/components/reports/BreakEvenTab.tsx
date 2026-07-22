import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2, RefreshCw } from 'lucide-react';
import { getBreakEvenPrefill, type BreakEvenPrefill } from '../../api';
import { formatMoney as fmt } from '../../utils/currency';
import { usePlan } from '../../context/PlanContext';
import UpgradePrompt from '../UpgradePrompt';

/**
 * Punto de equilibrio — the tenant's own break-even calculator.
 *
 * Every default is prefilled from the tenant's live data (avg ticket and
 * pace from their orders, fixed costs from recurring expenses, labor from
 * shifts × hourly rate, variable % from their food-cost target) and every
 * number is editable. Pro-only: the endpoint 403s for free tenants and the
 * tab renders the upgrade prompt instead.
 */

interface FixedRow {
  id: number;
  label: string;
  amount: number;
}

const BreakEvenTab: React.FC = () => {
  const { t } = useTranslation('reports');
  const { plan } = usePlan();

  const [prefill, setPrefill] = useState<BreakEvenPrefill | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Editable model
  const [avgTicket, setAvgTicket] = useState(0);
  const [variablePct, setVariablePct] = useState(30);
  const [openDays, setOpenDays] = useState(26);
  const [rows, setRows] = useState<FixedRow[]>([]);
  let nextId = useMemo(() => rows.reduce((m, r) => Math.max(m, r.id), 0) + 1, [rows]);

  useEffect(() => {
    if (plan !== 'pro') { setLoading(false); return; }
    getBreakEvenPrefill()
      .then((p) => {
        setPrefill(p);
        setAvgTicket(p.avg_ticket || 0);
        setVariablePct(p.variable_pct_default || 30);
        setOpenDays(p.open_days_30d > 0 ? p.open_days_30d : 26);
        const seeded: FixedRow[] = [];
        let id = 1;
        if (p.labor_monthly > 0) seeded.push({ id: id++, label: t('breakeven.rows.labor'), amount: p.labor_monthly });
        // Individual recurring expenses, largest first, capped at 8 rows;
        // the tail folds into one "other" row so the list stays scannable.
        const head = p.recurring.slice(0, 8);
        const tail = p.recurring.slice(8);
        head.forEach((r) => seeded.push({ id: id++, label: r.label, amount: r.monthly }));
        const tailSum = tail.reduce((s, r) => s + r.monthly, 0);
        if (tailSum > 0) seeded.push({ id: id++, label: t('breakeven.rows.otherRecurring'), amount: Math.round(tailSum * 100) / 100 });
        if (seeded.length === 0) seeded.push({ id: id++, label: t('breakeven.rows.rent'), amount: 0 });
        setRows(seeded);
      })
      .catch((e: any) => {
        if (!e?.planUpgradeRequired) setError(e.message || 'Error');
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan]);

  const model = useMemo(() => {
    const fixed = rows.reduce((s, r) => s + (r.amount || 0), 0);
    const cmPct = Math.max(0, 1 - variablePct / 100);
    const cmPerOrder = avgTicket * cmPct;
    const beRevenue = cmPct > 0 ? fixed / cmPct : Infinity;
    const beOrdersMonth = avgTicket > 0 && cmPct > 0 ? beRevenue / avgTicket : Infinity;
    const beOrdersDay = openDays > 0 && isFinite(beOrdersMonth) ? beOrdersMonth / openDays : Infinity;
    const currentPerDay = prefill?.orders_per_open_day || 0;
    const gapPerDay = isFinite(beOrdersDay) ? beOrdersDay - currentPerDay : Infinity;
    return { fixed, cmPct, cmPerOrder, beRevenue, beOrdersMonth, beOrdersDay, currentPerDay, gapPerDay };
  }, [rows, variablePct, avgTicket, openDays, prefill]);

  if (plan !== 'pro') {
    return <UpgradePrompt variant="inline" feature={t('breakeven.title')} />;
  }
  if (loading) return <div className="text-neutral-400 p-6">{t('breakeven.loading')}</div>;
  if (error) return <div className="text-cockpit-out-text p-6">{error}</div>;

  const setRow = (id: number, patch: Partial<FixedRow>) =>
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const addRow = () => setRows((rs) => [...rs, { id: nextId, label: '', amount: 0 }]);
  const delRow = (id: number) => setRows((rs) => rs.filter((r) => r.id !== id));

  const aboveBE = isFinite(model.gapPerDay) && model.gapPerDay <= 0;

  return (
    <div className="space-y-6">
      {/* Headline */}
      <div className={`p-6 rounded-lg border ${aboveBE ? 'bg-cockpit-green/10 border-cockpit-green/40' : 'bg-neutral-900 border-neutral-800'}`}>
        <p className="text-neutral-400 text-sm">{t('breakeven.headline.title')}</p>
        <p className="text-4xl font-bold text-white mt-2">
          {isFinite(model.beOrdersDay) ? Math.ceil(model.beOrdersDay) : '∞'}
          <span className="text-lg font-medium text-neutral-400 ml-2">{t('breakeven.headline.ordersPerDay')}</span>
        </p>
        <p className={`mt-2 text-sm font-medium ${aboveBE ? 'text-cockpit-in-text' : 'text-cockpit-attention-text'}`}>
          {!isFinite(model.gapPerDay)
            ? t('breakeven.headline.fillData')
            : aboveBE
              ? t('breakeven.headline.above', { count: Math.floor(-model.gapPerDay), current: model.currentPerDay })
              : t('breakeven.headline.below', { count: Math.ceil(model.gapPerDay), current: model.currentPerDay })}
        </p>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
          <p className="text-neutral-400 text-sm">{t('breakeven.kpi.fixedMonthly')}</p>
          <p className="text-3xl font-bold text-cockpit-attention-text mt-2">{fmt(model.fixed)}</p>
        </div>
        <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
          <p className="text-neutral-400 text-sm">{t('breakeven.kpi.cmPerOrder')}</p>
          <p className="text-3xl font-bold text-cockpit-in-text mt-2">{fmt(model.cmPerOrder)}</p>
          <p className="text-xs text-neutral-500 mt-1">{Math.round(model.cmPct * 100)}% {t('breakeven.kpi.ofTicket')}</p>
        </div>
        <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
          <p className="text-neutral-400 text-sm">{t('breakeven.kpi.beRevenue')}</p>
          <p className="text-3xl font-bold text-white mt-2">{isFinite(model.beRevenue) ? fmt(model.beRevenue) : '—'}</p>
          <p className="text-xs text-neutral-500 mt-1">{t('breakeven.kpi.perMonth')}</p>
        </div>
        <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
          <p className="text-neutral-400 text-sm">{t('breakeven.kpi.beOrders')}</p>
          <p className="text-3xl font-bold text-white mt-2">{isFinite(model.beOrdersMonth) ? Math.ceil(model.beOrdersMonth) : '—'}</p>
          <p className="text-xs text-neutral-500 mt-1">{t('breakeven.kpi.perMonth')}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Inputs */}
        <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800 space-y-5">
          <h3 className="text-lg font-bold text-white">{t('breakeven.inputs.title')}</h3>

          <div className="grid grid-cols-3 gap-4">
            <label className="block">
              <span className="text-sm text-neutral-400">{t('breakeven.inputs.avgTicket')}</span>
              <input type="number" min="0" value={avgTicket} onChange={(e) => setAvgTicket(parseFloat(e.target.value) || 0)} className={inputCls} />
              {prefill && prefill.avg_ticket > 0 && (
                <span className="text-xs text-neutral-500">{t('breakeven.inputs.fromOrders', { value: fmt(prefill.avg_ticket) })}</span>
              )}
            </label>
            <label className="block">
              <span className="text-sm text-neutral-400">{t('breakeven.inputs.variablePct')}</span>
              <input type="number" min="0" max="95" value={variablePct} onChange={(e) => setVariablePct(parseFloat(e.target.value) || 0)} className={inputCls} />
              <span className="text-xs text-neutral-500">{t('breakeven.inputs.variableHint')}</span>
            </label>
            <label className="block">
              <span className="text-sm text-neutral-400">{t('breakeven.inputs.openDays')}</span>
              <input type="number" min="1" max="31" value={openDays} onChange={(e) => setOpenDays(parseFloat(e.target.value) || 1)} className={inputCls} />
              {prefill && prefill.open_days_30d > 0 && (
                <span className="text-xs text-neutral-500">{t('breakeven.inputs.fromDays', { count: prefill.open_days_30d })}</span>
              )}
            </label>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-semibold text-neutral-300">{t('breakeven.inputs.fixedCosts')}</span>
              <button onClick={addRow} className="text-xs text-brand-400 hover:text-brand-300 flex items-center gap-1">
                <Plus size={13} /> {t('breakeven.inputs.addRow')}
              </button>
            </div>
            <div className="space-y-2">
              {rows.map((r) => (
                <div key={r.id} className="flex gap-2 items-center">
                  <input
                    value={r.label}
                    placeholder={t('breakeven.inputs.rowPlaceholder')}
                    onChange={(e) => setRow(r.id, { label: e.target.value })}
                    className="flex-1 px-3 py-2 bg-neutral-950 border border-neutral-800 rounded text-white text-sm focus:outline-none focus:border-brand-600"
                  />
                  <input
                    type="number" min="0" value={r.amount}
                    onChange={(e) => setRow(r.id, { amount: parseFloat(e.target.value) || 0 })}
                    className="w-32 px-3 py-2 bg-neutral-950 border border-neutral-800 rounded text-white text-sm text-right focus:outline-none focus:border-brand-600"
                  />
                  <button onClick={() => delRow(r.id)} className="text-neutral-600 hover:text-cockpit-out-text p-1" aria-label={t('breakeven.inputs.removeRow')}>
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
            <div className="flex justify-between mt-3 pt-3 border-t border-neutral-800 text-sm">
              <span className="text-neutral-400">{t('breakeven.inputs.fixedTotal')}</span>
              <span className="font-bold text-white">{fmt(model.fixed)}</span>
            </div>
            {prefill && prefill.expenses_30d.length > 0 && (
              <p className="text-xs text-neutral-500 mt-3 flex items-start gap-1.5">
                <RefreshCw size={12} className="mt-0.5 shrink-0" />
                <span>{t('breakeven.inputs.expensesRef', { value: fmt(prefill.expenses_30d.reduce((s, e) => s + e.total, 0)) })}</span>
              </p>
            )}
          </div>
        </div>

        {/* Chart */}
        <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
          <h3 className="text-lg font-bold text-white mb-1">{t('breakeven.chart.title')}</h3>
          <p className="text-xs text-neutral-500 mb-4">{t('breakeven.chart.subtitle')}</p>
          <BEChart
            avgTicket={avgTicket}
            variablePct={variablePct}
            fixed={model.fixed}
            beOrdersDay={model.beOrdersDay}
            currentPerDay={model.currentPerDay}
            openDays={openDays}
          />
        </div>
      </div>
    </div>
  );
};

const inputCls = 'mt-1 w-full px-3 py-2 bg-neutral-950 border border-neutral-800 rounded text-white text-sm focus:outline-none focus:border-brand-600';

/** Revenue vs total-cost lines over orders/day, break-even + "today" markers. */
const BEChart: React.FC<{
  avgTicket: number; variablePct: number; fixed: number;
  beOrdersDay: number; currentPerDay: number; openDays: number;
}> = ({ avgTicket, variablePct, fixed, beOrdersDay, currentPerDay, openDays }) => {
  const { t } = useTranslation('reports');
  const W = 460, H = 260;
  const pad = { l: 48, r: 14, t: 14, b: 34 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;

  const maxX = Math.max(10, Math.ceil(Math.max(beOrdersDay * 2, currentPerDay * 1.3) / 5) * 5);
  const fixedPerDay = openDays > 0 ? fixed / openDays : 0;
  const maxY = Math.max(avgTicket * maxX, fixedPerDay + avgTicket * (variablePct / 100) * maxX, 1) * 1.08;
  const x = (o: number) => pad.l + (o / maxX) * iw;
  const y = (v: number) => pad.t + ih - (v / maxY) * ih;

  const rev = (o: number) => avgTicket * o;
  const cost = (o: number) => fixedPerDay + avgTicket * (variablePct / 100) * o;

  const gridY = [0.25, 0.5, 0.75, 1].map((f) => maxY * f);
  const beVisible = isFinite(beOrdersDay) && beOrdersDay <= maxX;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={t('breakeven.chart.title')}>
      {gridY.map((g, i) => (
        <g key={i}>
          <line x1={pad.l} y1={y(g)} x2={W - pad.r} y2={y(g)} className="stroke-neutral-800" strokeWidth="1" />
          <text x={pad.l - 6} y={y(g) + 3} textAnchor="end" fontSize="9" className="fill-neutral-500">
            {g >= 1000 ? `${(g / 1000).toFixed(1)}k` : Math.round(g)}
          </text>
        </g>
      ))}
      <line x1={pad.l} y1={y(0)} x2={W - pad.r} y2={y(0)} className="stroke-neutral-700" strokeWidth="1" />
      {[0, 0.25, 0.5, 0.75, 1].map((f, i) => (
        <text key={i} x={x(maxX * f)} y={H - 16} textAnchor="middle" fontSize="9" className="fill-neutral-500">
          {Math.round(maxX * f)}
        </text>
      ))}
      <text x={W - pad.r} y={H - 4} textAnchor="end" fontSize="9" className="fill-neutral-500">
        {t('breakeven.chart.xAxis')}
      </text>

      {/* cost then revenue */}
      <path d={`M${x(0)},${y(cost(0))} L${x(maxX)},${y(cost(maxX))}`} className="stroke-cockpit-attention-text" strokeWidth="2" fill="none" />
      <path d={`M${x(0)},${y(rev(0))} L${x(maxX)},${y(rev(maxX))}`} className="stroke-brand-500" strokeWidth="2" fill="none" />
      <text x={x(maxX) - 4} y={y(rev(maxX)) - 6} textAnchor="end" fontSize="10" className="fill-neutral-300">{t('breakeven.chart.revenue')}</text>
      <text x={x(maxX) - 4} y={y(cost(maxX)) + 14} textAnchor="end" fontSize="10" className="fill-neutral-300">{t('breakeven.chart.cost')}</text>

      {/* current pace marker */}
      {currentPerDay > 0 && currentPerDay <= maxX && (
        <g>
          <line x1={x(currentPerDay)} y1={pad.t} x2={x(currentPerDay)} y2={pad.t + ih} className="stroke-neutral-600" strokeWidth="1" strokeDasharray="2 3" />
          <text x={x(currentPerDay)} y={pad.t + ih - 4} textAnchor="middle" fontSize="9" className="fill-neutral-400">{t('breakeven.chart.today')}</text>
        </g>
      )}

      {/* break-even marker */}
      {beVisible && (
        <g>
          <line x1={x(beOrdersDay)} y1={pad.t} x2={x(beOrdersDay)} y2={pad.t + ih} className="stroke-neutral-500" strokeWidth="1" strokeDasharray="3 3" />
          <circle cx={x(beOrdersDay)} cy={y(rev(beOrdersDay))} r="5" className="fill-neutral-900 stroke-white" strokeWidth="2" />
          <text x={x(beOrdersDay)} y={pad.t + 10} textAnchor="middle" fontSize="10" fontWeight="600" className="fill-white">
            {t('breakeven.chart.beLabel', { count: Math.ceil(beOrdersDay) })}
          </text>
        </g>
      )}
    </svg>
  );
};

export default BreakEvenTab;
