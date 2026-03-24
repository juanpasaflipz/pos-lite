import React from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import { InventoryItem, WasteLogEntry, WasteReport } from '../../types';
import { formatDateTime } from '../../utils/dateFormat';

const WASTE_REASONS = ['spoilage', 'prep_error', 'dropped', 'expired', 'other'] as const;

interface WasteTabProps {
  items: InventoryItem[];
  wasteItemId: string;
  wasteQty: string;
  wasteReason: string;
  wasteNotes: string;
  wasteLoading: boolean;
  wasteEntries: WasteLogEntry[];
  wasteReport: WasteReport | null;
  wasteReportLoading: boolean;
  onWasteItemIdChange: (value: string) => void;
  onWasteQtyChange: (value: string) => void;
  onWasteReasonChange: (value: string) => void;
  onWasteNotesChange: (value: string) => void;
  onLogWaste: () => void;
}

export default function WasteTab({
  items,
  wasteItemId,
  wasteQty,
  wasteReason,
  wasteNotes,
  wasteLoading,
  wasteEntries,
  wasteReport,
  wasteReportLoading,
  onWasteItemIdChange,
  onWasteQtyChange,
  onWasteReasonChange,
  onWasteNotesChange,
  onLogWaste,
}: WasteTabProps) {
  const { t } = useTranslation('inventory');

  return (
    <>
      {/* Log waste form */}
      <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800 mb-6">
        <h3 className="text-lg font-bold text-white mb-4">{t('waste.logWaste')}</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
          <select
            value={wasteItemId}
            onChange={(e) => onWasteItemIdChange(e.target.value)}
            className="px-4 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-white focus:outline-none focus:border-brand-600"
          >
            <option value="">{t('waste.selectItem')}</option>
            {items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} ({item.quantity} {item.unit})
              </option>
            ))}
          </select>
          <input
            type="number"
            value={wasteQty}
            onChange={(e) => onWasteQtyChange(e.target.value)}
            placeholder={t('waste.quantity')}
            className="px-4 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:border-brand-600"
            min="0.1"
            step="0.1"
          />
          <select
            value={wasteReason}
            onChange={(e) => onWasteReasonChange(e.target.value)}
            className="px-4 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-white focus:outline-none focus:border-brand-600"
          >
            {WASTE_REASONS.map((r) => (
              <option key={r} value={r}>{t(`waste.reasons.${r}`)}</option>
            ))}
          </select>
          <input
            type="text"
            value={wasteNotes}
            onChange={(e) => onWasteNotesChange(e.target.value)}
            placeholder={t('waste.notes')}
            className="px-4 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:border-brand-600"
          />
          <button
            onClick={onLogWaste}
            disabled={wasteLoading || !wasteItemId || !wasteQty}
            className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors disabled:opacity-50 font-medium"
          >
            {wasteLoading ? t('waste.submitting') : t('waste.submit')}
          </button>
        </div>
      </div>

      {/* Waste report summary */}
      {wasteReportLoading ? (
        <div className="space-y-3 mb-6">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-24 bg-neutral-800 rounded animate-pulse"></div>
          ))}
        </div>
      ) : wasteReport && wasteReport.summary.total_entries > 0 ? (
        <>
          <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800 mb-6">
            <h3 className="text-lg font-bold text-white mb-4">{t('waste.report.title')}</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
              <div className="p-4 bg-neutral-800 rounded-lg">
                <p className="text-neutral-400 text-sm">{t('waste.report.totalCost')}</p>
                <p className="text-2xl font-bold text-red-400">
                  ${wasteReport.summary.total_waste_cost.toLocaleString()}
                </p>
              </div>
              <div className="p-4 bg-neutral-800 rounded-lg">
                <p className="text-neutral-400 text-sm">{t('waste.report.totalEntries')}</p>
                <p className="text-2xl font-bold text-white">{wasteReport.summary.total_entries}</p>
              </div>
              <div className="p-4 bg-neutral-800 rounded-lg">
                <p className="text-neutral-400 text-sm">{t('waste.report.byReason')}</p>
                <div className="mt-2 space-y-1">
                  {Object.entries(wasteReport.summary.by_reason).map(([reason, data]) => (
                    <div key={reason} className="flex justify-between text-sm">
                      <span className="text-neutral-300">{t(`waste.reasons.${reason}`)}</span>
                      <span className="text-red-400">${data.cost.toLocaleString()} ({data.count})</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Top wasted items */}
            {wasteReport.by_item.length > 0 && (
              <div>
                <h4 className="text-white font-semibold mb-3">{t('waste.report.topItems')}</h4>
                <div className="space-y-2">
                  {wasteReport.by_item.slice(0, 10).map((item) => (
                    <div key={item.inventory_item_id} className="flex items-center justify-between p-3 bg-neutral-800 rounded-lg">
                      <div>
                        <p className="text-white font-medium">{item.name}</p>
                        <p className="text-neutral-500 text-xs">
                          {item.total_quantity} {item.unit} | {item.entry_count} entries | Top: {t(`waste.reasons.${item.top_reason}`)}
                        </p>
                      </div>
                      <span className="text-red-400 font-medium">${item.total_cost.toLocaleString()}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800 mb-6">
          <div className="text-center py-12">
            <Trash2 className="mx-auto text-neutral-600 mb-3" size={40} />
            <p className="text-neutral-400">{t('waste.report.noData')}</p>
          </div>
        </div>
      )}

      {/* Recent waste entries */}
      {wasteEntries.length > 0 && (
        <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
          <h3 className="text-lg font-bold text-white mb-4">{t('waste.title')}</h3>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-neutral-800 border-b border-neutral-700">
                <tr>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-neutral-300">{t('count.columns.item')}</th>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-neutral-300">{t('waste.quantity')}</th>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-neutral-300">{t('waste.reason')}</th>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-neutral-300">{t('inventory.costPrice')}</th>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-neutral-300">{t('count.columns.notes')}</th>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-neutral-300">{t('count.columns.date')}</th>
                </tr>
              </thead>
              <tbody>
                {wasteEntries.slice(0, 50).map((entry) => (
                  <tr key={entry.id} className="border-b border-neutral-800 hover:bg-neutral-800/50">
                    <td className="px-6 py-4 font-medium text-white">{entry.item_name}</td>
                    <td className="px-6 py-4 text-red-400">{entry.quantity} {entry.unit}</td>
                    <td className="px-6 py-4">
                      <span className="px-2 py-1 bg-red-900/20 text-red-400 rounded text-xs font-medium">
                        {t(`waste.reasons.${entry.reason}`)}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-red-400">${Number(entry.cost_at_time).toFixed(2)}</td>
                    <td className="px-6 py-4 text-neutral-500 text-sm">{entry.notes || '-'}</td>
                    <td className="px-6 py-4 text-neutral-500 text-sm">
                      {formatDateTime(new Date(entry.created_at))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
