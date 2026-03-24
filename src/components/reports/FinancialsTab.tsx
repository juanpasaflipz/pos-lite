import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle } from 'lucide-react';
import { FinancialProjection } from '../../types';
import { formatPrice } from '../../utils/currency';
import { updateFinancialTargets, updateFinancialActual } from '../../api';

interface FinancialsTabProps {
  financialData: FinancialProjection | null;
  financialMonth: string;
  canEditFinancials: boolean;
  loading: boolean;
  onMonthChange: (month: string) => void;
  onRefresh: () => void;
  onError: (msg: string) => void;
}

export default function FinancialsTab({
  financialData,
  financialMonth,
  canEditFinancials,
  loading,
  onMonthChange,
  onRefresh,
  onError,
}: FinancialsTabProps) {
  const { t } = useTranslation('reports');
  const [editingTargets, setEditingTargets] = useState(false);
  const [targetDraft, setTargetDraft] = useState<Record<string, number>>({});
  const [actualDraft, setActualDraft] = useState<Record<string, string>>({});
  const [savingTargets, setSavingTargets] = useState(false);
  const [savingActual, setSavingActual] = useState<string | null>(null);

  const handleEditTargets = () => {
    if (!financialData) return;
    const draft: Record<string, number> = {};
    for (const row of financialData.rows) {
      draft[row.category] = row.target_percent;
    }
    setTargetDraft(draft);
    setEditingTargets(true);
  };

  const handleSaveTargets = async () => {
    setSavingTargets(true);
    try {
      const targets = Object.entries(targetDraft).map(([category, target_percent]) => ({
        category,
        target_percent,
      }));
      await updateFinancialTargets(targets);
      setEditingTargets(false);
      onRefresh();
    } catch (err) {
      onError(err instanceof Error ? err.message : t('errors.saveTargets'));
    } finally {
      setSavingTargets(false);
    }
  };

  const handleSaveActual = async (category: string) => {
    const val = parseFloat(actualDraft[category]);
    if (isNaN(val)) return;
    setSavingActual(category);
    try {
      await updateFinancialActual({ period: financialMonth, category, amount: val });
      setActualDraft(prev => { const n = { ...prev }; delete n[category]; return n; });
      onRefresh();
    } catch (err) {
      onError(err instanceof Error ? err.message : t('errors.saveActual'));
    } finally {
      setSavingActual(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-4">
        <input
          type="month"
          value={financialMonth}
          onChange={(e) => onMonthChange(e.target.value)}
          className="bg-neutral-800 text-white border border-neutral-700 rounded-lg px-4 py-2 min-h-[44px]"
        />
        {canEditFinancials && !editingTargets && (
          <button
            onClick={handleEditTargets}
            className="px-4 py-2 bg-neutral-800 text-neutral-300 border border-neutral-700 rounded-lg hover:bg-neutral-700 transition-colors min-h-[44px]"
          >
            {t('sales.financials.editTargets')}
          </button>
        )}
        {editingTargets && (
          <div className="flex gap-2">
            <button
              onClick={handleSaveTargets}
              disabled={savingTargets}
              className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors min-h-[44px] disabled:opacity-50"
            >
              {savingTargets ? t('sales.financials.saving') : t('sales.financials.saveTargets')}
            </button>
            <button
              onClick={() => setEditingTargets(false)}
              className="px-4 py-2 bg-neutral-800 text-neutral-300 border border-neutral-700 rounded-lg hover:bg-neutral-700 transition-colors min-h-[44px]"
            >
              {t('common:buttons.cancel')}
            </button>
          </div>
        )}
      </div>

      {/* Summary Cards */}
      {financialData && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
            <p className="text-neutral-400 text-sm">{t('sales.financials.revenueSubtotal')}</p>
            <p className="text-3xl font-bold text-brand-500 mt-2">{formatPrice(financialData.revenue)}</p>
          </div>
          <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
            <p className="text-neutral-400 text-sm">{t('sales.financials.netProfitActual')}</p>
            <p className={`text-3xl font-bold mt-2 ${financialData.net_profit >= 0 ? 'text-green-400' : 'text-brand-400'}`}>
              {formatPrice(financialData.net_profit)}
            </p>
          </div>
          <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
            <p className="text-neutral-400 text-sm">{t('sales.financials.netProfitTarget')}</p>
            <p className="text-3xl font-bold text-white mt-2">{formatPrice(financialData.target_net_profit)}</p>
          </div>
        </div>
      )}

      {/* Financial Table */}
      {financialData && (
        <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
          <h3 className="text-xl font-bold text-white mb-4">{t('sales.financials.planVsActuals')} {financialData.month}</h3>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-neutral-800 border-b border-neutral-700">
                <tr>
                  <th className="px-4 py-3 text-left text-sm font-semibold text-neutral-300">{t('sales.financials.columns.category')}</th>
                  <th className="px-4 py-3 text-right text-sm font-semibold text-neutral-300">{t('sales.financials.columns.targetPercent')}</th>
                  <th className="px-4 py-3 text-right text-sm font-semibold text-neutral-300">{t('sales.financials.columns.targetDollar')}</th>
                  <th className="px-4 py-3 text-right text-sm font-semibold text-neutral-300">{t('sales.financials.columns.actualDollar')}</th>
                  <th className="px-4 py-3 text-right text-sm font-semibold text-neutral-300">{t('sales.financials.columns.diffDollar')}</th>
                  <th className="px-4 py-3 text-right text-sm font-semibold text-neutral-300">{t('sales.financials.columns.diffPercent')}</th>
                </tr>
              </thead>
              <tbody>
                {financialData.rows.map((row) => {
                  const isOver = row.diff_amount > 0;
                  const diffColor = row.diff_amount === 0 ? 'text-neutral-400' : isOver ? 'text-brand-400' : 'text-green-400';
                  return (
                    <tr key={row.category} className="border-b border-neutral-800 hover:bg-neutral-800/50">
                      <td className="px-4 py-3 font-medium text-white">
                        {row.label}
                        {row.auto_calculated && (
                          <span className="ml-2 px-1.5 py-0.5 text-xs bg-blue-900/50 text-blue-300 rounded">{t('sales.financials.auto')}</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right text-neutral-300">
                        {editingTargets ? (
                          <input
                            type="number"
                            step="0.5"
                            min="0"
                            max="100"
                            value={targetDraft[row.category] ?? row.target_percent}
                            onChange={(e) => setTargetDraft(prev => ({ ...prev, [row.category]: parseFloat(e.target.value) || 0 }))}
                            className="w-20 bg-neutral-700 text-white border border-neutral-600 rounded px-2 py-1 text-right text-sm"
                          />
                        ) : (
                          `${row.target_percent}%`
                        )}
                      </td>
                      <td className="px-4 py-3 text-right text-neutral-300">{formatPrice(row.target_amount)}</td>
                      <td className="px-4 py-3 text-right">
                        {canEditFinancials ? (
                          <div className="flex items-center justify-end gap-2">
                            <input
                              type="number"
                              step="0.01"
                              min="0"
                              value={actualDraft[row.category] ?? row.actual_amount}
                              onChange={(e) => setActualDraft(prev => ({ ...prev, [row.category]: e.target.value }))}
                              className="w-28 bg-neutral-700 text-white border border-neutral-600 rounded px-2 py-1 text-right text-sm"
                            />
                            {actualDraft[row.category] !== undefined && (
                              <button
                                onClick={() => handleSaveActual(row.category)}
                                disabled={savingActual === row.category}
                                className="px-2 py-1 text-xs bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50"
                              >
                                {savingActual === row.category ? '...' : t('common:buttons.save')}
                              </button>
                            )}
                          </div>
                        ) : (
                          <span className="text-neutral-300">{formatPrice(row.actual_amount)}</span>
                        )}
                      </td>
                      <td className={`px-4 py-3 text-right font-medium ${diffColor}`}>
                        {row.diff_amount > 0 ? '+' : ''}{formatPrice(row.diff_amount)}
                      </td>
                      <td className={`px-4 py-3 text-right font-medium ${diffColor}`}>
                        {row.diff_percent > 0 ? '+' : ''}{row.diff_percent.toFixed(2)}%
                      </td>
                    </tr>
                  );
                })}
                {/* Net Profit Summary Row */}
                <tr className="bg-neutral-800 border-t-2 border-neutral-600">
                  <td className="px-4 py-4 font-bold text-white text-lg">{t('sales.financials.netProfit')}</td>
                  <td className="px-4 py-4 text-right font-bold text-white">
                    {(100 - financialData.rows.reduce((s, r) => s + r.target_percent, 0)).toFixed(1)}%
                  </td>
                  <td className="px-4 py-4 text-right font-bold text-white">{formatPrice(financialData.target_net_profit)}</td>
                  <td className="px-4 py-4 text-right font-bold text-white">{formatPrice(financialData.net_profit)}</td>
                  <td className={`px-4 py-4 text-right font-bold ${financialData.net_profit - financialData.target_net_profit >= 0 ? 'text-green-400' : 'text-brand-400'}`}>
                    {financialData.net_profit - financialData.target_net_profit > 0 ? '+' : ''}
                    {formatPrice(Math.round((financialData.net_profit - financialData.target_net_profit) * 100) / 100)}
                  </td>
                  <td className="px-4 py-4"></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!financialData && !loading && (
        <div className="bg-neutral-900 rounded-lg border border-neutral-800 p-12 text-center">
          <AlertCircle className="mx-auto text-neutral-600 mb-3" size={40} />
          <p className="text-neutral-400">{t('sales.financials.noFinancialData')}</p>
        </div>
      )}
    </div>
  );
}
