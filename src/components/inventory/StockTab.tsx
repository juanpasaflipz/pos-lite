import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  Search,
  Plus,
  Minus,
  AlertCircle,
  Edit2,
  Check,
  X,
  Sparkles,
  DollarSign,
} from 'lucide-react';
import { InventoryItem, InventoryForecast, COGSSummary } from '../../types';

type SortField = 'name' | 'quantity' | 'status';

interface StockTabProps {
  items: InventoryItem[];
  filteredItems: InventoryItem[];
  loading: boolean;
  searchTerm: string;
  selectedCategory: string;
  sortBy: SortField;
  restockingId: number | null;
  restockAmount: string;
  editingId: number | null;
  editThreshold: string;
  actionLoading: boolean;
  cogsSummary: COGSSummary | null;
  forecasts: InventoryForecast[];
  showForecasts: boolean;
  categories: string[];
  onSearchChange: (value: string) => void;
  onCategoryChange: (value: string) => void;
  onSortChange: (value: SortField) => void;
  onRestock: () => void;
  onEditThreshold: (id: number) => void;
  onRestockingIdChange: (id: number | null) => void;
  onRestockAmountChange: (value: string) => void;
  onEditingIdChange: (id: number | null) => void;
  onEditThresholdChange: (value: string) => void;
  onShowForecastsChange: (show: boolean) => void;
}

export default function StockTab({
  filteredItems,
  loading,
  searchTerm,
  selectedCategory,
  sortBy,
  restockingId,
  restockAmount,
  editingId,
  editThreshold,
  actionLoading,
  cogsSummary,
  forecasts,
  showForecasts,
  categories,
  onSearchChange,
  onCategoryChange,
  onSortChange,
  onRestock,
  onEditThreshold,
  onRestockingIdChange,
  onRestockAmountChange,
  onEditingIdChange,
  onEditThresholdChange,
  onShowForecastsChange,
}: StockTabProps) {
  const { t } = useTranslation('inventory');

  const getStatusBadge = (quantity: number, threshold: number) => {
    if (quantity === 0) return <span className="px-3 py-1 bg-brand-600/20 text-brand-400 rounded-full text-xs font-medium border border-brand-800">{t('inventory.status.outOfStock')}</span>;
    if (quantity <= threshold) return <span className="px-3 py-1 bg-amber-600/20 text-amber-400 rounded-full text-xs font-medium border border-amber-800">{t('inventory.status.lowStock')}</span>;
    return <span className="px-3 py-1 bg-green-600/20 text-green-400 rounded-full text-xs font-medium border border-green-800">{t('inventory.status.inStock')}</span>;
  };

  const getExpiryBadge = (expiryDate?: string) => {
    if (!expiryDate) return null;
    const now = new Date();
    const exp = new Date(expiryDate);
    const daysUntil = Math.ceil((exp.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    if (daysUntil < 0) {
      return <span className="px-2 py-0.5 bg-red-900/30 text-red-400 rounded text-xs font-medium">{t('inventory.expired')}</span>;
    }
    if (daysUntil <= 7) {
      return <span className="px-2 py-0.5 bg-amber-900/30 text-amber-400 rounded text-xs font-medium">{t('inventory.expiresSoon')}</span>;
    }
    return null;
  };

  return (
    <>
      {/* COGS Widget */}
      {cogsSummary && cogsSummary.revenue > 0 && (
        <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800 mb-6">
          <div className="flex items-center gap-2 mb-4">
            <DollarSign className="text-brand-500" size={20} />
            <h3 className="font-semibold text-white">{t('cogs.title')}</h3>
            <span className="text-xs text-neutral-500 ml-auto">30 days</span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="p-3 bg-neutral-800 rounded-lg">
              <p className="text-neutral-400 text-xs">{t('cogs.revenue')}</p>
              <p className="text-lg font-bold text-white">${cogsSummary.revenue.toLocaleString()}</p>
            </div>
            <div className="p-3 bg-neutral-800 rounded-lg">
              <p className="text-neutral-400 text-xs">{t('cogs.foodCostPercent')}</p>
              <p className={`text-lg font-bold ${cogsSummary.food_cost_percent > 35 ? 'text-red-400' : cogsSummary.food_cost_percent > 30 ? 'text-amber-400' : 'text-green-400'}`}>
                {cogsSummary.food_cost_percent.toFixed(1)}%
              </p>
            </div>
            <div className="p-3 bg-neutral-800 rounded-lg">
              <p className="text-neutral-400 text-xs">{t('cogs.wasteCost')}</p>
              <p className="text-lg font-bold text-red-400">${cogsSummary.waste_cost.toLocaleString()}</p>
            </div>
            <div className="p-3 bg-neutral-800 rounded-lg">
              <p className="text-neutral-400 text-xs">{t('cogs.grossMargin')}</p>
              <p className="text-lg font-bold text-green-400">{cogsSummary.gross_margin_percent.toFixed(1)}%</p>
            </div>
          </div>
        </div>
      )}

      <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800 mb-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          <div className="relative">
            <Search className="absolute left-3 top-3 text-neutral-500" size={20} />
            <input
              type="text"
              placeholder={t('inventory.search')}
              value={searchTerm}
              onChange={(e) => onSearchChange(e.target.value)}
              className="w-full pl-10 pr-4 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:border-brand-600"
            />
          </div>

          <select
            value={selectedCategory}
            onChange={(e) => onCategoryChange(e.target.value)}
            className="px-4 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-white focus:outline-none focus:border-brand-600"
          >
            {categories.map((cat) => (
              <option key={cat} value={cat}>
                {cat === 'all' ? t('inventory.allCategories') : cat}
              </option>
            ))}
          </select>

          <select
            value={sortBy}
            onChange={(e) => onSortChange(e.target.value as SortField)}
            className="px-4 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-white focus:outline-none focus:border-brand-600"
          >
            <option value="name">{t('inventory.sortByName')}</option>
            <option value="quantity">{t('inventory.sortByQuantity')}</option>
            <option value="status">{t('inventory.sortByStatus')}</option>
          </select>
        </div>

        {loading ? (
          <div className="space-y-3">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="h-20 bg-neutral-800 rounded animate-pulse"></div>
            ))}
          </div>
        ) : filteredItems.length === 0 ? (
          <div className="text-center py-12">
            <AlertCircle className="mx-auto text-neutral-600 mb-3" size={40} />
            <p className="text-neutral-400">{t('inventory.noItemsFound')}</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-neutral-800 border-b border-neutral-700">
                <tr>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-neutral-300">{t('inventory.columns.itemName')}</th>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-neutral-300">{t('inventory.columns.currentStock')}</th>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-neutral-300">{t('inventory.columns.threshold')}</th>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-neutral-300">{t('inventory.columns.status')}</th>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-neutral-300">{t('inventory.columns.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {filteredItems.map((item) => (
                  <tr key={item.id} className="border-b border-neutral-800 hover:bg-neutral-800/50">
                    <td className="px-6 py-4">
                      <div>
                        <span className="font-medium text-white">{item.name}</span>
                        <div className="flex items-center gap-2 mt-1 flex-wrap">
                          {item.sku && (
                            <span className="text-xs text-neutral-500">{t('inventory.sku')}: {item.sku}</span>
                          )}
                          {item.barcode && (
                            <span className="text-xs text-neutral-500">{t('inventory.barcode')}: {item.barcode}</span>
                          )}
                          {item.cost_price != null && item.cost_price > 0 && (
                            <span className="text-xs text-neutral-500">${Number(item.cost_price).toFixed(2)}</span>
                          )}
                          {getExpiryBadge(item.expiry_date)}
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <span className="text-neutral-300">
                        {item.quantity} {item.unit}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      {editingId === item.id ? (
                        <div className="flex gap-2 items-center">
                          <input
                            type="number"
                            value={editThreshold}
                            onChange={(e) => onEditThresholdChange(e.target.value)}
                            className="w-20 px-2 py-1 bg-neutral-800 border border-neutral-700 rounded-lg text-white focus:outline-none focus:border-brand-600"
                            placeholder={item.low_stock_threshold.toString()}
                          />
                          <button
                            onClick={() => onEditThreshold(item.id)}
                            disabled={actionLoading}
                            className="p-1 text-green-400 hover:bg-green-900/30 rounded-lg transition-colors disabled:opacity-50"
                          >
                            <Check size={18} />
                          </button>
                          <button
                            onClick={() => {
                              onEditingIdChange(null);
                              onEditThresholdChange('');
                            }}
                            className="p-1 text-neutral-400 hover:bg-neutral-700 rounded-lg transition-colors"
                          >
                            <X size={18} />
                          </button>
                        </div>
                      ) : (
                        <div className="flex gap-2 items-center">
                          <span className="text-neutral-300">{item.low_stock_threshold}</span>
                          <button
                            onClick={() => {
                              onEditingIdChange(item.id);
                              onEditThresholdChange(item.low_stock_threshold.toString());
                            }}
                            className="p-1 text-neutral-500 hover:bg-neutral-700 rounded-lg transition-colors"
                          >
                            <Edit2 size={16} />
                          </button>
                        </div>
                      )}
                    </td>
                    <td className="px-6 py-4">
                      {getStatusBadge(item.quantity, item.low_stock_threshold)}
                    </td>
                    <td className="px-6 py-4">
                      {restockingId === item.id ? (
                        <div className="flex gap-2 items-center">
                          <button
                            onClick={() => onRestockAmountChange(Math.max(0, parseFloat(restockAmount) - 1).toString())}
                            className="p-1 bg-neutral-700 hover:bg-neutral-600 rounded-lg transition-colors text-white"
                          >
                            <Minus size={18} />
                          </button>
                          <input
                            type="number"
                            value={restockAmount}
                            onChange={(e) => onRestockAmountChange(e.target.value)}
                            className="w-16 px-2 py-1 bg-neutral-800 border border-neutral-700 rounded-lg text-white text-center focus:outline-none focus:border-brand-600"
                            placeholder="0"
                          />
                          <button
                            onClick={() => onRestockAmountChange(((parseFloat(restockAmount) || 0) + 1).toString())}
                            className="p-1 bg-neutral-700 hover:bg-neutral-600 rounded-lg transition-colors text-white"
                          >
                            <Plus size={18} />
                          </button>
                          <button
                            onClick={() => onRestock()}
                            disabled={actionLoading || !restockAmount}
                            className="px-3 py-1 bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors disabled:opacity-50"
                          >
                            <Check size={18} />
                          </button>
                          <button
                            onClick={() => {
                              onRestockingIdChange(null);
                              onRestockAmountChange('');
                            }}
                            className="px-3 py-1 bg-neutral-700 text-neutral-300 rounded-lg hover:bg-neutral-600 transition-colors"
                          >
                            <X size={18} />
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => {
                            onRestockingIdChange(item.id);
                            onRestockAmountChange('');
                          }}
                          className="px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors text-sm font-medium min-h-[44px] flex items-center justify-center"
                        >
                          {t('inventory.restock')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* AI Forecast Section */}
      {forecasts.filter(f => f.risk_level === 'critical' || f.risk_level === 'high').length > 0 && (
        <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800 mb-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Sparkles className="text-brand-500" size={20} />
              <h3 className="font-semibold text-white">{t('inventory.aiPredictions')}</h3>
            </div>
            <button
              onClick={() => onShowForecastsChange(!showForecasts)}
              className="text-sm text-neutral-400 hover:text-white transition-colors"
            >
              {showForecasts ? t('inventory.hide') : t('inventory.showAll')}
            </button>
          </div>
          <div className="space-y-2">
            {forecasts
              .filter(f => showForecasts || f.risk_level === 'critical' || f.risk_level === 'high')
              .slice(0, showForecasts ? undefined : 5)
              .map((f) => (
                <div key={f.inventory_item_id} className="flex items-center justify-between p-3 bg-neutral-800 rounded-lg">
                  <div>
                    <p className="text-white font-medium">{f.name}</p>
                    <p className="text-neutral-500 text-xs">
                      {f.avg_daily_usage > 0
                        ? t('inventory.daysLeft', { days: f.days_until_stockout, usage: f.avg_daily_usage, unit: f.unit })
                        : t('inventory.insufficientData')}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className={`px-2 py-1 rounded text-xs font-medium ${
                      f.risk_level === 'critical' ? 'bg-brand-900/30 text-brand-400' :
                      f.risk_level === 'high' ? 'bg-orange-900/30 text-orange-400' :
                      f.risk_level === 'medium' ? 'bg-amber-900/30 text-amber-400' :
                      'bg-green-900/30 text-green-400'
                    }`}>
                      {f.risk_level.toUpperCase()}
                    </span>
                    {f.suggested_reorder_qty && (
                      <span className="text-xs text-neutral-500">
                        {t('inventory.reorder', { qty: f.suggested_reorder_qty, unit: f.unit })}
                      </span>
                    )}
                  </div>
                </div>
              ))}
          </div>
        </div>
      )}

      {!loading && filteredItems.length > 0 && (
        <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
          <h3 className="font-semibold text-white mb-4">{t('inventory.summary.title')}</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="p-4 bg-neutral-800 rounded-lg">
              <p className="text-neutral-400 text-sm">{t('inventory.summary.totalItems')}</p>
              <p className="text-2xl font-bold text-white">{filteredItems.length}</p>
            </div>
            <div className="p-4 bg-neutral-800 rounded-lg">
              <p className="text-neutral-400 text-sm">{t('inventory.summary.lowStock')}</p>
              <p className="text-2xl font-bold text-amber-400">
                {filteredItems.filter((i) => i.quantity <= i.low_stock_threshold && i.quantity > 0).length}
              </p>
            </div>
            <div className="p-4 bg-neutral-800 rounded-lg">
              <p className="text-neutral-400 text-sm">{t('inventory.summary.outOfStock')}</p>
              <p className="text-2xl font-bold text-brand-500">
                {filteredItems.filter((i) => i.quantity === 0).length}
              </p>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
