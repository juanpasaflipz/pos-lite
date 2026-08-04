import React, { useMemo, useState } from 'react';
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
  Trash2,
  ChevronDown,
  ChevronRight,
  Clock,
  Moon,
} from 'lucide-react';
import { InventoryItem, InventoryForecast, COGSSummary, InventoryKind } from '../../types';
import { PulseBucket } from './InventoryPulseGrid';

type SortField = 'name' | 'quantity' | 'status';
type InventoryItemForm = {
  name: string;
  category: string;
  unit: string;
  quantity: string;
  low_stock_threshold: string;
  cost_price: string;
  sku: string;
  barcode: string;
  expiry_date: string;
  lot_number: string;
  kind: InventoryKind;
  low_threshold_portions: string;
};

interface StockTabProps {
  items: InventoryItem[];
  filteredItems: InventoryItem[];
  loading: boolean;
  searchTerm: string;
  sortBy: SortField;
  restockingId: number | null;
  restockAmount: string;
  editingId: number | null;
  editThreshold: string;
  editingQuantityId: number | null;
  editQuantity: string;
  itemFormOpen: boolean;
  itemFormMode: 'create' | 'edit';
  itemForm: InventoryItemForm;
  actionLoading: boolean;
  cogsSummary: COGSSummary | null;
  forecasts: InventoryForecast[];
  showForecasts: boolean;
  addedTodayIds: Set<number>;
  staleIds: Set<number>;
  dormantIds: Set<number>;
  activeBucket: PulseBucket | null;
  isTwoStage: boolean;
  onToggleSoldOut: (item: InventoryItem) => void;
  onSearchChange: (value: string) => void;
  onSortChange: (value: SortField) => void;
  onRestock: () => void;
  onEditThreshold: (id: number) => void;
  onEditQuantity: (id: number) => void;
  onRestockingIdChange: (id: number | null) => void;
  onRestockAmountChange: (value: string) => void;
  onEditingIdChange: (id: number | null) => void;
  onEditThresholdChange: (value: string) => void;
  onEditingQuantityIdChange: (id: number | null) => void;
  onEditQuantityChange: (value: string) => void;
  onItemFormChange: (value: InventoryItemForm) => void;
  onCreateItem: () => void;
  onEditItem: (item: InventoryItem) => void;
  onSaveItem: () => void;
  onDeleteItem: (item: InventoryItem) => void;
  onCloseItemForm: () => void;
  onShowForecastsChange: (show: boolean) => void;
}

function classifyItem(
  item: InventoryItem,
  addedTodayIds: Set<number>,
  staleIds: Set<number>,
  dormantIds: Set<number>
): PulseBucket {
  if (item.quantity === 0) return 'low'; // out-of-stock surfaces in the "needs restock" bucket
  if (item.quantity <= item.low_stock_threshold) return 'low';
  if (staleIds.has(item.id)) return 'stale';
  if (addedTodayIds.has(item.id)) return 'added_today';
  if (dormantIds.has(item.id)) return 'dormant';
  return 'healthy';
}

function bucketSeverity(b: PulseBucket): number {
  switch (b) {
    case 'low': return 0;
    case 'stale': return 1;
    case 'dormant': return 2;
    case 'added_today': return 3;
    case 'healthy': return 4;
  }
}

export default function StockTab({
  filteredItems,
  loading,
  searchTerm,
  sortBy,
  restockingId,
  restockAmount,
  editingId,
  editThreshold,
  editingQuantityId,
  editQuantity,
  itemFormOpen,
  itemFormMode,
  itemForm,
  actionLoading,
  cogsSummary,
  forecasts,
  showForecasts,
  addedTodayIds,
  staleIds,
  dormantIds,
  activeBucket,
  isTwoStage,
  onToggleSoldOut,
  onSearchChange,
  onSortChange,
  onRestock,
  onEditThreshold,
  onEditQuantity,
  onRestockingIdChange,
  onRestockAmountChange,
  onEditingIdChange,
  onEditThresholdChange,
  onEditingQuantityIdChange,
  onEditQuantityChange,
  onItemFormChange,
  onCreateItem,
  onEditItem,
  onSaveItem,
  onDeleteItem,
  onCloseItemForm,
  onShowForecastsChange,
}: StockTabProps) {
  const { t } = useTranslation('inventory');
  const [collapsedCats, setCollapsedCats] = useState<Set<string>>(new Set());
  // Raw vs. componentes. Kept local rather than hoisted to InventoryScreen —
  // it composes with the bucket filter right below and nothing else needs it.
  const [kindFilter, setKindFilter] = useState<InventoryKind | 'all'>('all');

  const updateFormField = (field: keyof InventoryItemForm, value: string) => {
    onItemFormChange({ ...itemForm, [field]: value });
  };

  // Apply layer + bucket filters on top of search-filtered items
  const bucketFilteredItems = useMemo(() => {
    let list = filteredItems;
    if (isTwoStage && kindFilter !== 'all') {
      // Rows predating migration 0103 have no kind and are raw by definition.
      list = list.filter((it) => (it.kind || 'raw') === kindFilter);
    }
    if (!activeBucket) return list;
    return list.filter(
      (it) => classifyItem(it, addedTodayIds, staleIds, dormantIds) === activeBucket
    );
  }, [filteredItems, activeBucket, addedTodayIds, staleIds, dormantIds, isTwoStage, kindFilter]);

  // Group items by category, then sort categories by severity (most urgent first)
  const categoryGroups = useMemo(() => {
    const groups = new Map<string, InventoryItem[]>();
    for (const item of bucketFilteredItems) {
      const cat = item.category || t('pulse.uncategorized');
      const list = groups.get(cat) || [];
      list.push(item);
      groups.set(cat, list);
    }
    // Sort items inside each group by current sort field
    for (const list of Array.from(groups.values())) {
      list.sort((a, b) => {
        if (sortBy === 'quantity') return a.quantity - b.quantity;
        if (sortBy === 'status') {
          const aSev = bucketSeverity(classifyItem(a, addedTodayIds, staleIds, dormantIds));
          const bSev = bucketSeverity(classifyItem(b, addedTodayIds, staleIds, dormantIds));
          return aSev - bSev;
        }
        return a.name.localeCompare(b.name);
      });
    }
    // Compute a "urgency score" per category: lower = more urgent (more low/stale items)
    const sorted = Array.from(groups.entries()).map(([cat, list]) => {
      const urgent = list.reduce((acc, it) => {
        const b = classifyItem(it, addedTodayIds, staleIds, dormantIds);
        if (b === 'low') return acc + 3;
        if (b === 'stale') return acc + 2;
        if (b === 'dormant') return acc + 1;
        return acc;
      }, 0);
      return { category: cat, items: list, urgency: urgent };
    });
    sorted.sort((a, b) => {
      if (b.urgency !== a.urgency) return b.urgency - a.urgency;
      return a.category.localeCompare(b.category);
    });
    return sorted;
  }, [bucketFilteredItems, sortBy, addedTodayIds, staleIds, dormantIds, t]);

  const allCollapsed = collapsedCats.size === categoryGroups.length && categoryGroups.length > 0;

  const toggleCategory = (cat: string) => {
    setCollapsedCats((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  const toggleAll = () => {
    if (allCollapsed) {
      setCollapsedCats(new Set());
    } else {
      setCollapsedCats(new Set(categoryGroups.map((g) => g.category)));
    }
  };

  const getStatusBadge = (item: InventoryItem) => {
    const bucket = classifyItem(item, addedTodayIds, staleIds, dormantIds);
    if (item.quantity === 0) {
      return <span className="px-2 py-0.5 bg-brand-600/20 text-brand-400 rounded text-xs font-medium border border-brand-800">{t('inventory.status.outOfStock')}</span>;
    }
    if (bucket === 'low') {
      return <span className="px-2 py-0.5 bg-cockpit-yellow/20 text-cockpit-attention-text rounded text-xs font-medium border border-cockpit-yellow">{t('inventory.status.lowStock')}</span>;
    }
    if (bucket === 'stale') {
      return <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-cockpit-red/20 text-cockpit-out-text rounded text-xs font-medium border border-cockpit-red/40"><Clock size={11} />{t('pulse.staleBadge')}</span>;
    }
    if (bucket === 'added_today') {
      return <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-cockpit-green/20 text-cockpit-in-text rounded text-xs font-medium border border-cockpit-green"><Sparkles size={11} />{t('pulse.addedTodayBadge')}</span>;
    }
    if (bucket === 'dormant') {
      return <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-brand-900/30 text-brand-300 rounded text-xs font-medium border border-brand-700"><Moon size={11} />{t('pulse.dormantBadge')}</span>;
    }
    return <span className="px-2 py-0.5 bg-cockpit-green/20 text-cockpit-in-text rounded text-xs font-medium border border-cockpit-green">{t('inventory.status.inStock')}</span>;
  };

  const getExpiryBadge = (expiryDate?: string) => {
    if (!expiryDate) return null;
    const now = new Date();
    const exp = new Date(expiryDate);
    const daysUntil = Math.ceil((exp.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    if (daysUntil < 0) {
      return <span className="px-2 py-0.5 bg-cockpit-red/30 text-cockpit-out-text rounded text-xs font-medium">{t('inventory.expired')}</span>;
    }
    if (daysUntil <= 7) {
      return <span className="px-2 py-0.5 bg-cockpit-yellow/30 text-cockpit-attention-text rounded text-xs font-medium">{t('inventory.expiresSoon')}</span>;
    }
    return null;
  };

  const renderItemRow = (item: InventoryItem) => (
    <div key={item.id} className="grid grid-cols-12 gap-4 px-4 py-3 border-t border-neutral-800 items-center hover:bg-neutral-800/30">
      <div className="col-span-12 md:col-span-4">
        <div className="font-medium text-white">{item.name}</div>
        <div className="flex items-center gap-2 mt-1 flex-wrap">
          {item.sku && <span className="text-xs text-neutral-500">{t('inventory.sku')}: {item.sku}</span>}
          {item.barcode && <span className="text-xs text-neutral-500">{t('inventory.barcode')}: {item.barcode}</span>}
          {item.cost_price != null && item.cost_price > 0 && (
            <span className="text-xs text-neutral-500">${Number(item.cost_price).toFixed(2)}</span>
          )}
          {getExpiryBadge(item.expiry_date)}
        </div>
      </div>

      <div className="col-span-4 md:col-span-2">
        {editingQuantityId === item.id ? (
          <div className="flex gap-1 items-center">
            <input
              type="number"
              value={editQuantity}
              onChange={(e) => onEditQuantityChange(e.target.value)}
              onFocus={(e) => e.target.select()}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && editQuantity !== '') onEditQuantity(item.id);
                if (e.key === 'Escape') {
                  onEditingQuantityIdChange(null);
                  onEditQuantityChange('');
                }
              }}
              className="w-20 px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-white focus:outline-none focus:border-brand-600"
              placeholder={item.quantity.toString()}
              autoFocus
            />
            <button
              onClick={() => onEditQuantity(item.id)}
              disabled={actionLoading || editQuantity === ''}
              className="p-1 text-cockpit-in-text hover:bg-cockpit-green/30 rounded disabled:opacity-50"
            >
              <Check size={16} />
            </button>
            <button
              onClick={() => { onEditingQuantityIdChange(null); onEditQuantityChange(''); }}
              className="p-1 text-neutral-400 hover:bg-neutral-700 rounded"
            >
              <X size={16} />
            </button>
          </div>
        ) : (
          <button
            onClick={() => { onEditingQuantityIdChange(item.id); onEditQuantityChange(item.quantity.toString()); }}
            className="flex items-center gap-1 text-neutral-300 hover:text-white"
            title={t('inventory.editQuantity')}
          >
            <span className="font-semibold">{item.quantity}</span>
            {item.unit && !/^\s*\d+(\.\d+)?\s*$/.test(item.unit) && (
              <span className="text-neutral-500 text-sm">{item.unit}</span>
            )}
            <Edit2 size={12} className="opacity-50" />
          </button>
        )}
      </div>

      <div className="col-span-4 md:col-span-2 text-sm">
        {editingId === item.id ? (
          <div className="flex gap-1 items-center">
            <input
              type="number"
              value={editThreshold}
              onChange={(e) => onEditThresholdChange(e.target.value)}
              className="w-16 px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-white focus:outline-none focus:border-brand-600"
              placeholder={item.low_stock_threshold.toString()}
            />
            <button
              onClick={() => onEditThreshold(item.id)}
              disabled={actionLoading}
              className="p-1 text-cockpit-in-text hover:bg-cockpit-green/30 rounded disabled:opacity-50"
            >
              <Check size={16} />
            </button>
            <button
              onClick={() => { onEditingIdChange(null); onEditThresholdChange(''); }}
              className="p-1 text-neutral-400 hover:bg-neutral-700 rounded"
            >
              <X size={16} />
            </button>
          </div>
        ) : (
          <button
            onClick={() => { onEditingIdChange(item.id); onEditThresholdChange(item.low_stock_threshold.toString()); }}
            className="flex items-center gap-1 text-neutral-400 hover:text-white text-xs"
          >
            <span>{t('inventory.columns.threshold')}: {item.low_stock_threshold}</span>
            <Edit2 size={11} className="opacity-50" />
          </button>
        )}
      </div>

      <div className="col-span-4 md:col-span-2">{getStatusBadge(item)}</div>

      <div className="col-span-12 md:col-span-2 flex items-center gap-1 justify-start md:justify-end">
        {restockingId === item.id ? (
          <div className="flex gap-1 items-center">
            <button
              onClick={() => onRestockAmountChange(Math.max(0, parseFloat(restockAmount) - 1).toString())}
              className="p-1 bg-neutral-700 hover:bg-neutral-600 rounded text-white"
            >
              <Minus size={14} />
            </button>
            <input
              type="number"
              value={restockAmount}
              onChange={(e) => onRestockAmountChange(e.target.value)}
              className="w-14 px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-white text-center text-sm focus:outline-none focus:border-brand-600"
              placeholder="0"
            />
            <button
              onClick={() => onRestockAmountChange(((parseFloat(restockAmount) || 0) + 1).toString())}
              className="p-1 bg-neutral-700 hover:bg-neutral-600 rounded text-white"
            >
              <Plus size={14} />
            </button>
            <button
              onClick={() => onRestock()}
              disabled={actionLoading || !restockAmount}
              className="px-2 py-1 bg-brand-600 text-white rounded hover:bg-brand-700 disabled:opacity-50"
            >
              <Check size={14} />
            </button>
            <button
              onClick={() => { onRestockingIdChange(null); onRestockAmountChange(''); }}
              className="px-2 py-1 bg-neutral-700 text-neutral-300 rounded hover:bg-neutral-600"
            >
              <X size={14} />
            </button>
          </div>
        ) : (
          <>
            <button
              onClick={() => { onRestockingIdChange(item.id); onRestockAmountChange(''); }}
              className="px-3 py-1.5 bg-brand-600 text-white rounded hover:bg-brand-700 text-xs font-medium min-h-[36px]"
            >
              {t('inventory.restock')}
            </button>
            <button
              onClick={() => onEditItem(item)}
              title={t('inventory.editItem')}
              className="p-2 text-neutral-300 bg-neutral-800 hover:bg-neutral-700 rounded"
            >
              <Edit2 size={14} />
            </button>
            {/* Manual 86 — the plancha died and every dish using this component
                has to come off the menu at once, whatever the shelf count says.
                Always beats the derived count until it's cleared. */}
            {isTwoStage && (item.kind || 'raw') === 'component' && (
              <button
                onClick={() => onToggleSoldOut(item)}
                title={t(item.sold_out_manual ? 'inventory.un86' : 'inventory.mark86')}
                className={`p-2 rounded text-xs font-bold min-w-[36px] ${
                  item.sold_out_manual
                    ? 'bg-red-600 text-white hover:bg-red-500'
                    : 'text-neutral-300 bg-neutral-800 hover:bg-neutral-700'
                }`}
              >
                86
              </button>
            )}
            <button
              onClick={() => onDeleteItem(item)}
              disabled={actionLoading}
              title={t('inventory.deleteItem')}
              className="p-2 text-cockpit-out-text bg-neutral-800 hover:bg-cockpit-red/30 rounded disabled:opacity-50"
            >
              <Trash2 size={14} />
            </button>
          </>
        )}
      </div>
    </div>
  );

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
              <p className={`text-lg font-bold ${cogsSummary.food_cost_percent > 35 ? 'text-cockpit-out-text' : cogsSummary.food_cost_percent > 30 ? 'text-cockpit-attention-text' : 'text-cockpit-in-text'}`}>
                {cogsSummary.food_cost_percent.toFixed(1)}%
              </p>
            </div>
            <div className="p-3 bg-neutral-800 rounded-lg">
              <p className="text-neutral-400 text-xs">{t('cogs.wasteCost')}</p>
              <p className="text-lg font-bold text-cockpit-out-text">${cogsSummary.waste_cost.toLocaleString()}</p>
            </div>
            <div className="p-3 bg-neutral-800 rounded-lg">
              <p className="text-neutral-400 text-xs">{t('cogs.grossMargin')}</p>
              <p className="text-lg font-bold text-cockpit-in-text">{cogsSummary.gross_margin_percent.toFixed(1)}%</p>
            </div>
          </div>
        </div>
      )}

      <div className="bg-neutral-900 p-4 md:p-6 rounded-lg border border-neutral-800 mb-6">
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-3 text-neutral-500" size={18} />
            <input
              type="text"
              placeholder={t('inventory.search')}
              value={searchTerm}
              onChange={(e) => onSearchChange(e.target.value)}
              className="w-full pl-10 pr-4 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:border-brand-600"
            />
          </div>

          <select
            value={sortBy}
            onChange={(e) => onSortChange(e.target.value as SortField)}
            className="px-3 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-white text-sm focus:outline-none focus:border-brand-600"
          >
            <option value="name">{t('inventory.sortByName')}</option>
            <option value="quantity">{t('inventory.sortByQuantity')}</option>
            <option value="status">{t('inventory.sortByStatus')}</option>
          </select>

          {isTwoStage && (
            <div className="flex gap-1">
              {(['all', 'raw', 'component'] as const).map((k) => (
                <button
                  key={k}
                  onClick={() => setKindFilter(k)}
                  className={`px-3 min-h-[40px] rounded-lg border text-sm transition-colors ${
                    kindFilter === k
                      ? 'bg-brand-600 border-brand-500 text-white'
                      : 'bg-neutral-800 border-neutral-700 text-neutral-300 hover:bg-neutral-700'
                  }`}
                >
                  {k === 'all' ? t('inventory.kinds.all') : t(`inventory.kinds.${k}`)}
                </button>
              ))}
            </div>
          )}

          {categoryGroups.length > 1 && (
            <button
              onClick={toggleAll}
              className="px-3 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-neutral-300 hover:bg-neutral-700 text-sm"
            >
              {allCollapsed ? t('pulse.expandAll') : t('pulse.collapseAll')}
            </button>
          )}

          <button
            onClick={onCreateItem}
            className="px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-700 text-sm font-medium min-h-[40px] flex items-center gap-2 ml-auto"
          >
            <Plus size={16} />
            {t('inventory.addItem')}
          </button>
        </div>

        {loading ? (
          <div className="space-y-3">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="h-20 bg-neutral-800 rounded animate-pulse"></div>
            ))}
          </div>
        ) : categoryGroups.length === 0 ? (
          <div className="text-center py-12">
            <AlertCircle className="mx-auto text-neutral-600 mb-3" size={40} />
            <p className="text-neutral-400">{t('inventory.noItemsFound')}</p>
          </div>
        ) : (
          <div className="space-y-3">
            {categoryGroups.map((group) => {
              const isCollapsed = collapsedCats.has(group.category);
              const lowCount = group.items.filter((it) => classifyItem(it, addedTodayIds, staleIds, dormantIds) === 'low').length;
              const staleCount = group.items.filter((it) => classifyItem(it, addedTodayIds, staleIds, dormantIds) === 'stale').length;
              return (
                <div key={group.category} className="border border-neutral-800 rounded-lg overflow-hidden bg-neutral-950">
                  <button
                    onClick={() => toggleCategory(group.category)}
                    className="w-full flex items-center gap-3 px-4 py-3 bg-neutral-900 hover:bg-neutral-800 transition-colors text-left"
                  >
                    {isCollapsed ? <ChevronRight size={18} className="text-neutral-500" /> : <ChevronDown size={18} className="text-neutral-500" />}
                    <span className="font-semibold text-white">{group.category}</span>
                    <span className="text-xs text-neutral-500">{group.items.length}</span>
                    <div className="ml-auto flex items-center gap-2">
                      {lowCount > 0 && (
                        <span className="px-2 py-0.5 bg-cockpit-yellow/20 text-cockpit-attention-text rounded text-xs font-medium border border-cockpit-yellow/50">
                          {lowCount} {t('pulse.lowChip')}
                        </span>
                      )}
                      {staleCount > 0 && (
                        <span className="px-2 py-0.5 bg-cockpit-red/20 text-cockpit-out-text rounded text-xs font-medium border border-cockpit-red/50">
                          {staleCount} {t('pulse.staleChip')}
                        </span>
                      )}
                    </div>
                  </button>
                  {!isCollapsed && (
                    <div>{group.items.map(renderItemRow)}</div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {itemFormOpen && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <div className="w-full max-w-3xl bg-neutral-900 border border-neutral-800 rounded-lg shadow-2xl">
            <div className="flex items-center justify-between p-5 border-b border-neutral-800">
              <h3 className="text-lg font-semibold text-white">
                {itemFormMode === 'edit' ? t('inventory.editItem') : t('inventory.addItem')}
              </h3>
              <button
                onClick={onCloseItemForm}
                className="p-2 text-neutral-400 hover:text-white hover:bg-neutral-800 rounded-lg transition-colors"
              >
                <X size={20} />
              </button>
            </div>

            <div className="p-5 grid grid-cols-1 md:grid-cols-2 gap-4">
              <label className="block md:col-span-2">
                <span className="block text-sm text-neutral-400 mb-1">{t('inventory.form.name')}</span>
                <input type="text" value={itemForm.name} onChange={(e) => updateFormField('name', e.target.value)} className="w-full px-3 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-white focus:outline-none focus:border-brand-600" autoFocus />
              </label>
              {isTwoStage && (
                <div className="block md:col-span-2">
                  <span className="block text-sm text-neutral-400 mb-1">{t('inventory.form.kind')}</span>
                  <div className="flex gap-2">
                    {(['raw', 'component'] as InventoryKind[]).map((k) => (
                      <button
                        key={k}
                        type="button"
                        onClick={() => updateFormField('kind', k)}
                        className={`flex-1 min-h-[44px] px-3 rounded-lg border text-sm transition-colors ${
                          itemForm.kind === k
                            ? 'bg-brand-600 border-brand-500 text-white'
                            : 'bg-neutral-800 border-neutral-700 text-neutral-300 hover:border-neutral-600'
                        }`}
                      >
                        {t(`inventory.kinds.${k}`)}
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-neutral-500 mt-1">
                    {t(itemForm.kind === 'component' ? 'inventory.form.kindComponentHint' : 'inventory.form.kindRawHint')}
                  </p>
                </div>
              )}
              {isTwoStage && itemForm.kind === 'component' && (
                <label className="block md:col-span-2">
                  <span className="block text-sm text-neutral-400 mb-1">{t('inventory.form.lowThresholdPortions')}</span>
                  <input type="number" min="0" step="any" value={itemForm.low_threshold_portions} onChange={(e) => updateFormField('low_threshold_portions', e.target.value)} className="w-full px-3 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-white focus:outline-none focus:border-brand-600" />
                </label>
              )}
              <label className="block">
                <span className="block text-sm text-neutral-400 mb-1">{t('inventory.form.category')}</span>
                <input type="text" value={itemForm.category} onChange={(e) => updateFormField('category', e.target.value)} className="w-full px-3 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-white focus:outline-none focus:border-brand-600" />
              </label>
              <label className="block">
                <span className="block text-sm text-neutral-400 mb-1">{t('inventory.form.unit')}</span>
                <input type="text" value={itemForm.unit} onChange={(e) => updateFormField('unit', e.target.value)} className="w-full px-3 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-white focus:outline-none focus:border-brand-600" />
              </label>
              <label className="block">
                <span className="block text-sm text-neutral-400 mb-1">{t('inventory.form.quantity')}</span>
                <input type="number" min="0" step="any" value={itemForm.quantity} onChange={(e) => updateFormField('quantity', e.target.value)} className="w-full px-3 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-white focus:outline-none focus:border-brand-600" />
              </label>
              <label className="block">
                <span className="block text-sm text-neutral-400 mb-1">{t('inventory.form.threshold')}</span>
                <input type="number" min="0" step="any" value={itemForm.low_stock_threshold} onChange={(e) => updateFormField('low_stock_threshold', e.target.value)} className="w-full px-3 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-white focus:outline-none focus:border-brand-600" />
              </label>
              <label className="block">
                <span className="block text-sm text-neutral-400 mb-1">{t('inventory.form.costPrice')}</span>
                <input type="number" min="0" step="0.01" value={itemForm.cost_price} onChange={(e) => updateFormField('cost_price', e.target.value)} className="w-full px-3 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-white focus:outline-none focus:border-brand-600" />
              </label>
              <label className="block">
                <span className="block text-sm text-neutral-400 mb-1">{t('inventory.form.sku')}</span>
                <input type="text" value={itemForm.sku} onChange={(e) => updateFormField('sku', e.target.value)} className="w-full px-3 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-white focus:outline-none focus:border-brand-600" />
              </label>
              <label className="block">
                <span className="block text-sm text-neutral-400 mb-1">{t('inventory.form.barcode')}</span>
                <input type="text" value={itemForm.barcode} onChange={(e) => updateFormField('barcode', e.target.value)} className="w-full px-3 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-white focus:outline-none focus:border-brand-600" />
              </label>
              <label className="block">
                <span className="block text-sm text-neutral-400 mb-1">{t('inventory.form.expiryDate')}</span>
                <input type="date" value={itemForm.expiry_date} onChange={(e) => updateFormField('expiry_date', e.target.value)} className="w-full px-3 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-white focus:outline-none focus:border-brand-600" />
              </label>
              <label className="block">
                <span className="block text-sm text-neutral-400 mb-1">{t('inventory.form.lotNumber')}</span>
                <input type="text" value={itemForm.lot_number} onChange={(e) => updateFormField('lot_number', e.target.value)} className="w-full px-3 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-white focus:outline-none focus:border-brand-600" />
              </label>
            </div>

            <div className="flex justify-end gap-3 p-5 border-t border-neutral-800">
              <button onClick={onCloseItemForm} className="px-4 py-2 bg-neutral-800 text-neutral-300 rounded-lg hover:bg-neutral-700 transition-colors">
                {t('inventory.cancel')}
              </button>
              <button onClick={onSaveItem} disabled={actionLoading || !itemForm.name.trim()} className="px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors disabled:opacity-50">
                {actionLoading ? t('inventory.saving') : t('inventory.saveItem')}
              </button>
            </div>
          </div>
        </div>
      )}

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
                      f.risk_level === 'high' ? 'bg-cockpit-yellow/30 text-cockpit-attention-text' :
                      f.risk_level === 'medium' ? 'bg-cockpit-yellow/30 text-cockpit-attention-text' :
                      'bg-cockpit-green/30 text-cockpit-in-text'
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
    </>
  );
}
