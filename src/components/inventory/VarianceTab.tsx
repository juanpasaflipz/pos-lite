import React from 'react';
import { useTranslation } from 'react-i18next';
import { BarChart3 } from 'lucide-react';
import { VarianceReport } from '../../types';

interface VarianceTabProps {
  varianceData: VarianceReport[];
  varianceLoading: boolean;
  onRefresh: () => void;
}

export default function VarianceTab({
  varianceData,
  varianceLoading,
  onRefresh,
}: VarianceTabProps) {
  const { t } = useTranslation('inventory');

  return (
    <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-bold text-white">{t('variance.title')}</h3>
        <button
          onClick={onRefresh}
          className="text-sm text-neutral-400 hover:text-white transition-colors"
        >
          {t('common:buttons.refresh')}
        </button>
      </div>
      {varianceLoading ? (
        <div className="space-y-3">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-16 bg-neutral-800 rounded animate-pulse"></div>
          ))}
        </div>
      ) : varianceData.length === 0 ? (
        <div className="text-center py-12">
          <BarChart3 className="mx-auto text-neutral-600 mb-3" size={40} />
          <p className="text-neutral-400">{t('variance.noData')}</p>
          <p className="text-neutral-500 text-sm mt-1">{t('variance.recordCountsHint')}</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-neutral-800 border-b border-neutral-700">
              <tr>
                <th className="px-6 py-3 text-left text-sm font-semibold text-neutral-300">{t('count.columns.item')}</th>
                <th className="px-6 py-3 text-left text-sm font-semibold text-neutral-300">{t('variance.countSessions')}</th>
                <th className="px-6 py-3 text-left text-sm font-semibold text-neutral-300">{t('variance.avgVariance')}</th>
                <th className="px-6 py-3 text-left text-sm font-semibold text-neutral-300">{t('variance.avgVariancePercent')}</th>
                <th className="px-6 py-3 text-left text-sm font-semibold text-neutral-300">{t('variance.totalVariance')}</th>
                <th className="px-6 py-3 text-left text-sm font-semibold text-neutral-300">{t('variance.risk')}</th>
              </tr>
            </thead>
            <tbody>
              {varianceData.map((row) => {
                const avgVar = Number(row.avg_variance) || 0;
                const avgVarPct = Number(row.avg_variance_percent) || 0;
                const totalVar = Number(row.total_variance) || 0;
                const avgPct = Math.abs(avgVarPct);
                const risk = avgPct > 15 ? 'high' : avgPct > 5 ? 'medium' : 'low';
                return (
                  <tr key={row.inventory_item_id} className="border-b border-neutral-800 hover:bg-neutral-800/50">
                    <td className="px-6 py-4 font-medium text-white">{row.name}</td>
                    <td className="px-6 py-4 text-neutral-300">{row.count_sessions}</td>
                    <td className="px-6 py-4">
                      <span className={avgVar < 0 ? 'text-brand-400' : avgVar > 0 ? 'text-amber-400' : 'text-green-400'}>
                        {avgVar > 0 ? '+' : ''}{avgVar.toFixed(1)}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <span className={avgPct > 10 ? 'text-brand-400' : 'text-neutral-300'}>
                        {avgVarPct > 0 ? '+' : ''}{avgVarPct.toFixed(1)}%
                      </span>
                    </td>
                    <td className="px-6 py-4 text-neutral-300">
                      {totalVar.toFixed(1)}
                    </td>
                    <td className="px-6 py-4">
                      <span className={`px-2 py-1 rounded text-xs font-bold uppercase ${
                        risk === 'high' ? 'bg-brand-900/30 text-brand-400' :
                        risk === 'medium' ? 'bg-amber-900/30 text-amber-400' :
                        'bg-green-900/30 text-green-400'
                      }`}>
                        {risk}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
