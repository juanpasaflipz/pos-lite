import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Cell, Legend,
} from 'recharts';
import { Star, TrendingUp, HelpCircle, XCircle } from 'lucide-react';
import { MenuEngineeringReport, MenuEngineeringItem } from '../../types';

const fmt = (v: number) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(v);

const CLASSIFICATION_CONFIG = {
  star: { labelKey: 'star', icon: Star, color: '#22c55e', bgColor: 'bg-green-500/10', textColor: 'text-green-400', borderColor: 'border-green-500/30', emoji: '⭐' },
  workhorse: { labelKey: 'workhorse', icon: TrendingUp, color: '#3b82f6', bgColor: 'bg-blue-500/10', textColor: 'text-blue-400', borderColor: 'border-blue-500/30', emoji: '🐎' },
  puzzle: { labelKey: 'puzzle', icon: HelpCircle, color: '#f59e0b', bgColor: 'bg-amber-500/10', textColor: 'text-amber-400', borderColor: 'border-amber-500/30', emoji: '🧩' },
  dog: { labelKey: 'dog', icon: XCircle, color: '#ef4444', bgColor: 'bg-red-500/10', textColor: 'text-red-400', borderColor: 'border-red-500/30', emoji: '🐕' },
};

interface MenuEngineeringTabProps {
  data: MenuEngineeringReport;
}

function ClassificationBadge({ classification }: { classification: MenuEngineeringItem['classification'] }) {
  const { t } = useTranslation('reports');
  const config = CLASSIFICATION_CONFIG[classification];
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${config.bgColor} ${config.textColor} border ${config.borderColor}`}>
      {config.emoji} {t('menuEngineering.classifications.' + config.labelKey)}
    </span>
  );
}

function CustomTooltip({ active, payload }: any) {
  const { t } = useTranslation('reports');
  if (!active || !payload || !payload.length) return null;
  const item = payload[0]?.payload as MenuEngineeringItem;
  if (!item) return null;
  const config = CLASSIFICATION_CONFIG[item.classification];
  return (
    <div className="bg-neutral-900 border border-neutral-700 rounded-lg p-3 shadow-xl">
      <p className="font-bold text-white text-sm">{item.item_name}</p>
      <p className="text-neutral-400 text-xs mb-2">{item.category_name}</p>
      <div className="space-y-1 text-xs">
        <div className="flex justify-between gap-4"><span className="text-neutral-400">{t('menuEngineering.tooltip.price')}</span><span className="text-white">{fmt(item.price)}</span></div>
        <div className="flex justify-between gap-4"><span className="text-neutral-400">{t('menuEngineering.tooltip.cost')}</span><span className="text-amber-400">{fmt(item.cogs_per_unit)}</span></div>
        <div className="flex justify-between gap-4"><span className="text-neutral-400">{t('menuEngineering.tooltip.margin')}</span><span className="text-green-400">{fmt(item.contribution_margin)}</span></div>
        <div className="flex justify-between gap-4"><span className="text-neutral-400">{t('menuEngineering.tooltip.sold')}</span><span className="text-white">{item.quantity_sold}</span></div>
        <div className="flex justify-between gap-4"><span className="text-neutral-400">{t('menuEngineering.tooltip.popularity')}</span><span className="text-white">{item.popularity_index}%</span></div>
        <div className="flex justify-between gap-4"><span className="text-neutral-400">{t('menuEngineering.tooltip.classification')}</span><span className={config.textColor}>{config.emoji} {t('menuEngineering.classifications.' + config.labelKey)}</span></div>
      </div>
    </div>
  );
}

export default function MenuEngineeringTab({ data }: MenuEngineeringTabProps) {
  const { t } = useTranslation('reports');
  const [filterClass, setFilterClass] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<'contribution_margin' | 'popularity_index' | 'total_contribution' | 'quantity_sold'>('total_contribution');

  const { items, summary, recommendations } = data;

  const filteredItems = filterClass
    ? items.filter(i => i.classification === filterClass)
    : items;

  const sortedItems = [...filteredItems].sort((a, b) => b[sortBy] - a[sortBy]);

  return (
    <div className="space-y-6">
      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {(['star', 'workhorse', 'puzzle', 'dog'] as const).map(cls => {
          const config = CLASSIFICATION_CONFIG[cls];
          const count = summary[cls === 'star' ? 'stars' : cls === 'workhorse' ? 'workhorses' : cls === 'puzzle' ? 'puzzles' : 'dogs'];
          const isActive = filterClass === cls;
          return (
            <button
              key={cls}
              onClick={() => setFilterClass(isActive ? null : cls)}
              className={`bg-neutral-900 p-4 rounded-lg border transition-all text-left ${isActive ? config.borderColor + ' ring-1 ring-' + config.color : 'border-neutral-800 hover:border-neutral-700'}`}
            >
              <div className="flex items-center gap-2 mb-1">
                <span className="text-lg">{config.emoji}</span>
                <span className={`text-sm font-medium ${config.textColor}`}>{t('menuEngineering.classifications.' + config.labelKey)}s</span>
              </div>
              <p className="text-3xl font-bold text-white">{count}</p>
              <p className="text-neutral-500 text-xs mt-1">
                {summary.total_items > 0 ? Math.round((count / summary.total_items) * 100) : 0}{t('menuEngineering.ofMenu')}
              </p>
            </button>
          );
        })}
      </div>

      {/* Summary bar */}
      <div className="bg-neutral-900 p-4 rounded-lg border border-neutral-800 flex flex-wrap gap-6 text-sm">
        <div><span className="text-neutral-400">{t('menuEngineering.summary.totalRevenue')}</span> <span className="text-white font-bold">{fmt(summary.total_revenue)}</span></div>
        <div><span className="text-neutral-400">{t('menuEngineering.summary.totalContribution')}</span> <span className="text-green-400 font-bold">{fmt(summary.total_contribution)}</span></div>
        <div><span className="text-neutral-400">{t('menuEngineering.summary.avgMargin')}</span> <span className="text-white font-bold">{fmt(summary.avg_contribution_margin)}</span></div>
        <div><span className="text-neutral-400">{t('menuEngineering.summary.itemsAnalyzed')}</span> <span className="text-white font-bold">{summary.total_items}</span></div>
      </div>

      {/* BCG Matrix Scatter Plot */}
      <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
        <h3 className="text-xl font-bold text-white mb-1">{t('menuEngineering.matrixTitle')}</h3>
        <p className="text-neutral-400 text-sm mb-4">{t('menuEngineering.matrixDesc')}</p>
        <ResponsiveContainer width="100%" height={400}>
          <ScatterChart margin={{ top: 20, right: 20, bottom: 20, left: 20 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#404040" />
            <XAxis
              type="number"
              dataKey="popularity_index"
              name="Popularidad"
              unit="%"
              stroke="#737373"
              label={{ value: t('menuEngineering.popularityLabel'), position: 'bottom', fill: '#737373', fontSize: 12 }}
            />
            <YAxis
              type="number"
              dataKey="contribution_margin"
              name="Margen"
              stroke="#737373"
              tickFormatter={(v) => `$${v}`}
              label={{ value: t('menuEngineering.marginLabel'), angle: -90, position: 'insideLeft', fill: '#737373', fontSize: 12 }}
            />
            <Tooltip content={<CustomTooltip />} />
            {/* Threshold reference lines */}
            <ReferenceLine
              x={summary.popularity_threshold}
              stroke="#525252"
              strokeDasharray="5 5"
              label={{ value: t('menuEngineering.popularityThreshold'), fill: '#525252', fontSize: 10, position: 'top' }}
            />
            <ReferenceLine
              y={summary.margin_threshold}
              stroke="#525252"
              strokeDasharray="5 5"
              label={{ value: t('menuEngineering.marginThreshold'), fill: '#525252', fontSize: 10, position: 'right' }}
            />
            {/* Quadrant labels */}
            <Scatter data={items} shape="circle">
              {items.map((item, index) => (
                <Cell
                  key={`cell-${index}`}
                  fill={CLASSIFICATION_CONFIG[item.classification].color}
                  fillOpacity={filterClass && item.classification !== filterClass ? 0.15 : 0.85}
                  r={Math.max(6, Math.min(14, item.quantity_sold / (items.reduce((max, i) => Math.max(max, i.quantity_sold), 1) / 14)))}
                />
              ))}
            </Scatter>
            <Legend
              payload={Object.entries(CLASSIFICATION_CONFIG).map(([key, config]) => ({
                value: `${config.emoji} ${t('menuEngineering.classifications.' + config.labelKey)}`,
                type: 'circle',
                color: config.color,
              }))}
            />
          </ScatterChart>
        </ResponsiveContainer>
      </div>

      {/* Recommendations */}
      {recommendations.length > 0 && (
        <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
          <h3 className="text-xl font-bold text-white mb-4">{t('menuEngineering.recommendations')}</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {recommendations.map((rec, i) => {
              const config = CLASSIFICATION_CONFIG[rec.type];
              return (
                <div key={i} className={`bg-neutral-800 p-4 rounded-lg border ${config.borderColor}`}>
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-lg">{config.emoji}</span>
                    <span className={`font-bold ${config.textColor}`}>{rec.action}</span>
                  </div>
                  <p className="text-neutral-300 text-sm mb-3">{rec.detail}</p>
                  <div className="flex flex-wrap gap-1">
                    {rec.items.map((name, j) => (
                      <span key={j} className={`text-xs px-2 py-0.5 rounded-full ${config.bgColor} ${config.textColor}`}>
                        {name}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Items Table */}
      <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-xl font-bold text-white">
            {t('menuEngineering.detailTitle')}
            {filterClass && (
              <span className={`ml-2 text-sm font-normal ${CLASSIFICATION_CONFIG[filterClass as keyof typeof CLASSIFICATION_CONFIG].textColor}`}>
                ({t('menuEngineering.filtering', { classification: t('menuEngineering.classifications.' + CLASSIFICATION_CONFIG[filterClass as keyof typeof CLASSIFICATION_CONFIG].labelKey) + 's' })})
              </span>
            )}
          </h3>
          <div className="flex items-center gap-2">
            <span className="text-neutral-400 text-xs">{t('menuEngineering.sortBy')}</span>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as any)}
              className="bg-neutral-800 text-white text-xs border border-neutral-700 rounded px-2 py-1"
            >
              <option value="total_contribution">{t('menuEngineering.sortOptions.totalContribution')}</option>
              <option value="contribution_margin">{t('menuEngineering.sortOptions.unitMargin')}</option>
              <option value="popularity_index">{t('menuEngineering.sortOptions.popularity')}</option>
              <option value="quantity_sold">{t('menuEngineering.sortOptions.unitsSold')}</option>
            </select>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-neutral-800 border-b border-neutral-700">
              <tr>
                <th className="text-left text-neutral-400 px-3 py-2 font-medium">{t('menuEngineering.columns.product')}</th>
                <th className="text-left text-neutral-400 px-3 py-2 font-medium">{t('menuEngineering.columns.category')}</th>
                <th className="text-center text-neutral-400 px-3 py-2 font-medium">{t('menuEngineering.columns.classification')}</th>
                <th className="text-right text-neutral-400 px-3 py-2 font-medium">{t('menuEngineering.columns.price')}</th>
                <th className="text-right text-neutral-400 px-3 py-2 font-medium">{t('menuEngineering.columns.cost')}</th>
                <th className="text-right text-neutral-400 px-3 py-2 font-medium">{t('menuEngineering.columns.margin')}</th>
                <th className="text-right text-neutral-400 px-3 py-2 font-medium">{t('menuEngineering.columns.marginPercent')}</th>
                <th className="text-right text-neutral-400 px-3 py-2 font-medium">{t('menuEngineering.columns.sold')}</th>
                <th className="text-right text-neutral-400 px-3 py-2 font-medium">{t('menuEngineering.columns.popularity')}</th>
                <th className="text-right text-neutral-400 px-3 py-2 font-medium">{t('menuEngineering.columns.contribution')}</th>
              </tr>
            </thead>
            <tbody>
              {sortedItems.map((item, i) => {
                const marginPercent = item.price > 0 ? Math.round(((item.price - item.cogs_per_unit) / item.price) * 100) : 0;
                return (
                  <tr key={i} className="border-b border-neutral-800 hover:bg-neutral-800/50">
                    <td className="px-3 py-2 text-white font-medium">{item.item_name}</td>
                    <td className="px-3 py-2 text-neutral-400">{item.category_name}</td>
                    <td className="px-3 py-2 text-center"><ClassificationBadge classification={item.classification} /></td>
                    <td className="px-3 py-2 text-right text-white">{fmt(item.price)}</td>
                    <td className="px-3 py-2 text-right text-amber-400">{fmt(item.cogs_per_unit)}</td>
                    <td className="px-3 py-2 text-right text-green-400">{fmt(item.contribution_margin)}</td>
                    <td className="px-3 py-2 text-right">
                      <span className={marginPercent >= 60 ? 'text-green-400' : marginPercent >= 40 ? 'text-amber-400' : 'text-red-400'}>
                        {marginPercent}%
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right text-white">{item.quantity_sold}</td>
                    <td className="px-3 py-2 text-right text-white">{item.popularity_index}%</td>
                    <td className="px-3 py-2 text-right text-green-400 font-bold">{fmt(item.total_contribution)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
