import React from 'react';
import { useTranslation } from 'react-i18next';
import { ClipboardList } from 'lucide-react';
import { InventoryItem, InventoryCount } from '../../types';
import { formatDate } from '../../utils/dateFormat';

interface CountTabProps {
  items: InventoryItem[];
  countItemId: string;
  countedQty: string;
  countNotes: string;
  countHistory: InventoryCount[];
  countLoading: boolean;
  actionLoading: boolean;
  onCountItemIdChange: (value: string) => void;
  onCountedQtyChange: (value: string) => void;
  onCountNotesChange: (value: string) => void;
  onRecordCount: () => void;
}

export default function CountTab({
  items,
  countItemId,
  countedQty,
  countNotes,
  countHistory,
  countLoading,
  actionLoading,
  onCountItemIdChange,
  onCountedQtyChange,
  onCountNotesChange,
  onRecordCount,
}: CountTabProps) {
  const { t } = useTranslation('inventory');

  return (
    <>
      {/* Record a Count */}
      <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800 mb-6">
        <h3 className="text-lg font-bold text-white mb-4">{t('count.title')}</h3>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <select
            value={countItemId}
            onChange={(e) => onCountItemIdChange(e.target.value)}
            className="px-4 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-white focus:outline-none focus:border-brand-600"
          >
            <option value="">{t('count.selectItem')}</option>
            {items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} ({t('count.inSystem', { qty: item.quantity, unit: item.unit })})
              </option>
            ))}
          </select>
          <input
            type="number"
            value={countedQty}
            onChange={(e) => onCountedQtyChange(e.target.value)}
            placeholder={t('count.countedQuantity')}
            className="px-4 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:border-brand-600"
          />
          <input
            type="text"
            value={countNotes}
            onChange={(e) => onCountNotesChange(e.target.value)}
            placeholder={t('count.notes')}
            className="px-4 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:border-brand-600"
          />
          <button
            onClick={onRecordCount}
            disabled={actionLoading || !countItemId || !countedQty}
            className="px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors disabled:opacity-50 font-medium"
          >
            {t('count.recordCount')}
          </button>
        </div>
      </div>

      {/* Count History */}
      <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
        <h3 className="text-lg font-bold text-white mb-4">{t('count.history')}</h3>
        {countLoading ? (
          <div className="space-y-3">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="h-16 bg-neutral-800 rounded animate-pulse"></div>
            ))}
          </div>
        ) : countHistory.length === 0 ? (
          <div className="text-center py-12">
            <ClipboardList className="mx-auto text-neutral-600 mb-3" size={40} />
            <p className="text-neutral-400">{t('count.noCountsYet')}</p>
            <p className="text-neutral-500 text-sm mt-1">{t('count.useFormAbove')}</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-neutral-800 border-b border-neutral-700">
                <tr>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-neutral-300">{t('count.columns.item')}</th>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-neutral-300">{t('count.columns.counted')}</th>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-neutral-300">{t('count.columns.system')}</th>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-neutral-300">{t('count.columns.variance')}</th>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-neutral-300">{t('count.columns.variancePercent')}</th>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-neutral-300">{t('count.columns.notes')}</th>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-neutral-300">{t('count.columns.date')}</th>
                </tr>
              </thead>
              <tbody>
                {countHistory.map((count) => {
                  const isHigh = Math.abs(count.variance_percent) > 10;
                  return (
                    <tr key={count.id} className="border-b border-neutral-800 hover:bg-neutral-800/50">
                      <td className="px-6 py-4 font-medium text-white">{count.item_name}</td>
                      <td className="px-6 py-4 text-neutral-300">{count.counted_quantity}</td>
                      <td className="px-6 py-4 text-neutral-300">{count.system_quantity}</td>
                      <td className="px-6 py-4">
                        <span className={count.variance !== 0 ? (count.variance < 0 ? 'text-brand-400' : 'text-amber-400') : 'text-green-400'}>
                          {count.variance > 0 ? '+' : ''}{count.variance}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <span className={`px-2 py-1 rounded text-xs font-medium ${
                          isHigh ? 'bg-brand-900/30 text-brand-400' : 'bg-neutral-800 text-neutral-400'
                        }`}>
                          {count.variance_percent > 0 ? '+' : ''}{count.variance_percent.toFixed(1)}%
                        </span>
                      </td>
                      <td className="px-6 py-4 text-neutral-500 text-sm">{count.notes || '-'}</td>
                      <td className="px-6 py-4 text-neutral-500 text-sm">
                        {formatDate(new Date(count.created_at))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
