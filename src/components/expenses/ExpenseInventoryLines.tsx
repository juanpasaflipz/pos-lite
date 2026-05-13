import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Package, Plus, Search, Sparkles, Trash2, X } from 'lucide-react';
import {
  createInventoryItem,
  getInventory,
  searchInventory,
  suggestInventoryAttrs,
  type InventoryMatch,
  type InventorySearchResult,
} from '../../api';

interface Props {
  value: InventoryMatch[];
  onChange: (matches: InventoryMatch[]) => void;
  totalAmount?: number;
}

interface LineRow {
  selectedItem: InventorySearchResult | null;
  quantity: string;
  totalCost: string;
  searchQuery: string;
  searchResults: InventorySearchResult[];
  showDropdown: boolean;
  searching: boolean;
}

const blankRow = (): LineRow => ({
  selectedItem: null,
  quantity: '',
  totalCost: '',
  searchQuery: '',
  searchResults: [],
  showDropdown: false,
  searching: false,
});

const INVENTORY_UNITS = ['kg', 'g', 'L', 'ml', 'pcs', 'box', 'case'] as const;

function matchesFromRows(rows: LineRow[]): InventoryMatch[] {
  return rows
    .filter(r => r.selectedItem && Number(r.quantity) > 0)
    .map(r => {
      const qty = Number(r.quantity);
      const total = Number(r.totalCost);
      const unitCost = total > 0 && qty > 0 ? total / qty : undefined;
      return {
        inventory_item_id: r.selectedItem!.id,
        inventory_item_name: r.selectedItem!.name,
        quantity: qty,
        cost_price: unitCost,
        raw_description: r.selectedItem!.name,
      };
    });
}

const ExpenseInventoryLines: React.FC<Props> = ({ value, onChange, totalAmount }) => {
  const { t } = useTranslation('admin');
  const [rows, setRows] = useState<LineRow[]>(() => {
    if (value.length === 0) return [blankRow()];
    return value.map(m => ({
      selectedItem: {
        id: m.inventory_item_id,
        name: m.inventory_item_name,
        quantity: 0,
        unit: '',
        cost_price: m.cost_price ?? 0,
        category: '',
      },
      quantity: String(m.quantity),
      totalCost: m.cost_price ? (m.cost_price * m.quantity).toFixed(2) : '',
      searchQuery: '',
      searchResults: [],
      showDropdown: false,
      searching: false,
    }));
  });
  const [allInventory, setAllInventory] = useState<InventorySearchResult[]>([]);
  const [createOpen, setCreateOpen] = useState<number | null>(null);
  const [createForm, setCreateForm] = useState({
    name: '',
    unit: 'kg',
    category: '',
    shelf_life_days: '' as string,
    storage_type: '' as '' | 'refrigerated' | 'frozen' | 'dry' | 'ambient',
  });
  const [creating, setCreating] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestion, setSuggestion] = useState<{ shelf_life_days: number; storage_type: string; source: string } | null>(null);
  const suggestTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchTimers = useRef<(ReturnType<typeof setTimeout> | null)[]>([]);

  useEffect(() => {
    getInventory()
      .then(inv => {
        setAllInventory(inv.map(i => ({
          id: i.id,
          name: i.name,
          quantity: i.quantity,
          unit: i.unit || '',
          cost_price: i.cost_price || 0,
          category: i.category || '',
          pack_size: i.pack_size ?? null,
        })));
      })
      .catch(() => {});
  }, []);

  // Emit matches to parent on any row change
  useEffect(() => {
    onChange(matchesFromRows(rows));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  const updateRow = useCallback((idx: number, patch: Partial<LineRow>) => {
    setRows(prev => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }, []);

  const handleSearch = useCallback((idx: number, query: string) => {
    updateRow(idx, { searchQuery: query, showDropdown: true });

    if (searchTimers.current[idx]) clearTimeout(searchTimers.current[idx]!);

    if (query.trim().length === 0) {
      updateRow(idx, { searchResults: allInventory.slice(0, 10), searching: false });
      return;
    }

    updateRow(idx, { searching: true });
    searchTimers.current[idx] = setTimeout(async () => {
      try {
        const results = await searchInventory(query);
        updateRow(idx, { searchResults: results, searching: false });
      } catch {
        updateRow(idx, { searchResults: [], searching: false });
      }
    }, 300);
  }, [allInventory, updateRow]);

  const handleSelect = (idx: number, item: InventorySearchResult | null) => {
    updateRow(idx, {
      selectedItem: item,
      showDropdown: false,
      searchQuery: '',
    });
  };

  const addRow = () => setRows(prev => [...prev, blankRow()]);
  const removeRow = (idx: number) => {
    setRows(prev => {
      const next = prev.filter((_, i) => i !== idx);
      return next.length > 0 ? next : [blankRow()];
    });
  };

  const openCreate = (idx: number) => {
    setCreateForm({ name: '', unit: 'kg', category: '', shelf_life_days: '', storage_type: '' });
    setSuggestion(null);
    setCreateOpen(idx);
  };

  // Debounced AI suggestion when user types a name. Pre-fills shelf life +
  // storage_type but never overwrites a value the user already edited.
  useEffect(() => {
    if (createOpen == null) return;
    const name = createForm.name.trim();
    if (!name || name.length < 3) {
      setSuggestion(null);
      return;
    }
    if (suggestTimer.current) clearTimeout(suggestTimer.current);
    suggestTimer.current = setTimeout(async () => {
      try {
        setSuggesting(true);
        const result = await suggestInventoryAttrs(name, createForm.category || undefined);
        setSuggestion({
          shelf_life_days: result.shelf_life_days,
          storage_type: result.storage_type,
          source: result.source,
        });
        setCreateForm(prev => ({
          ...prev,
          shelf_life_days: prev.shelf_life_days || String(result.shelf_life_days),
          storage_type: prev.storage_type || result.storage_type,
          category: prev.category || (result.category && result.category !== 'other' ? result.category : ''),
        }));
      } catch {
        setSuggestion(null);
      } finally {
        setSuggesting(false);
      }
    }, 600);
    return () => {
      if (suggestTimer.current) clearTimeout(suggestTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createForm.name, createOpen]);

  const submitCreate = async () => {
    const name = createForm.name.trim();
    if (!name || createOpen == null) return;
    try {
      setCreating(true);
      const created = await createInventoryItem({
        name,
        unit: createForm.unit,
        category: createForm.category.trim() || undefined,
        shelf_life_days: createForm.shelf_life_days ? Number(createForm.shelf_life_days) : undefined,
        storage_type: createForm.storage_type || undefined,
      });
      const asResult: InventorySearchResult = {
        id: created.id,
        name: created.name,
        quantity: created.quantity || 0,
        unit: created.unit || '',
        cost_price: created.cost_price || 0,
        category: created.category || '',
        pack_size: created.pack_size ?? null,
      };
      setAllInventory(prev => [...prev, asResult].sort((a, b) => a.name.localeCompare(b.name)));
      handleSelect(createOpen, asResult);
      setCreateOpen(null);
    } catch (err) {
      console.error('Failed to create inventory item:', err);
    } finally {
      setCreating(false);
    }
  };

  const linesTotal = rows.reduce((sum, r) => sum + (Number(r.totalCost) || 0), 0);
  const totalMismatch = totalAmount != null && totalAmount > 0 && linesTotal > 0
    && Math.abs(linesTotal - totalAmount) > 0.5;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="block text-sm font-medium text-neutral-400">
          {t('expenses.matchToInventory')}
        </label>
        {linesTotal > 0 && (
          <span className={`text-xs ${totalMismatch ? 'text-amber-400' : 'text-neutral-500'}`}>
            ${linesTotal.toFixed(2)}
            {totalAmount != null && totalAmount > 0 && ` / $${totalAmount.toFixed(2)}`}
          </span>
        )}
      </div>

      <div className="space-y-2">
        {rows.map((row, idx) => (
          <LineRowEditor
            key={idx}
            row={row}
            allInventory={allInventory}
            onSearch={(q) => handleSearch(idx, q)}
            onSelect={(item) => handleSelect(idx, item)}
            onQuantityChange={(v) => updateRow(idx, { quantity: v })}
            onTotalChange={(v) => updateRow(idx, { totalCost: v })}
            onToggleDropdown={(show) => updateRow(idx, { showDropdown: show })}
            onRemove={() => removeRow(idx)}
            onCreateNew={() => openCreate(idx)}
            canRemove={rows.length > 1}
          />
        ))}
      </div>

      <button
        type="button"
        onClick={addRow}
        className="w-full flex items-center justify-center gap-1.5 py-2 text-sm text-brand-400 hover:text-brand-300 transition-colors"
      >
        <Plus size={14} />
        {t('recipe.addIngredient', { defaultValue: 'Add item' })}
      </button>

      {createOpen != null && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4"
          onClick={() => setCreateOpen(null)}
        >
          <div
            className="bg-neutral-900 rounded-xl border border-neutral-800 w-full max-w-md p-4 space-y-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-white">
                {t('recipe.newIngredient', { defaultValue: 'New ingredient' })}
              </h3>
              <button
                type="button"
                onClick={() => setCreateOpen(null)}
                className="p-1 text-neutral-400 hover:text-white"
              >
                <X size={16} />
              </button>
            </div>
            <input
              type="text"
              autoFocus
              placeholder={t('recipe.ingredientName', { defaultValue: 'Name (e.g. Queso Cheddar)' })}
              value={createForm.name}
              onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })}
              className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-white placeholder-neutral-500 focus:border-brand-500 focus:outline-none min-h-[40px]"
            />
            <div className="grid grid-cols-2 gap-2">
              <select
                value={createForm.unit}
                onChange={(e) => setCreateForm({ ...createForm, unit: e.target.value })}
                className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-white focus:border-brand-500 focus:outline-none min-h-[40px]"
              >
                {INVENTORY_UNITS.map(u => <option key={u} value={u}>{u}</option>)}
              </select>
              <input
                type="text"
                placeholder={t('expenses.category')}
                value={createForm.category}
                onChange={(e) => setCreateForm({ ...createForm, category: e.target.value })}
                className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-white placeholder-neutral-500 focus:border-brand-500 focus:outline-none min-h-[40px]"
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[10px] uppercase tracking-wider text-neutral-500 mb-0.5">
                  {t('inventory:shelfLifeDays', { defaultValue: 'Shelf life (days)' })}
                </label>
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  step={1}
                  placeholder={suggesting ? '…' : '30'}
                  value={createForm.shelf_life_days}
                  onChange={(e) => setCreateForm({ ...createForm, shelf_life_days: e.target.value })}
                  className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-white placeholder-neutral-500 focus:border-brand-500 focus:outline-none min-h-[40px]"
                />
              </div>
              <div>
                <label className="block text-[10px] uppercase tracking-wider text-neutral-500 mb-0.5">
                  {t('inventory:storage', { defaultValue: 'Storage' })}
                </label>
                <select
                  value={createForm.storage_type}
                  onChange={(e) => setCreateForm({ ...createForm, storage_type: e.target.value as typeof createForm.storage_type })}
                  className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-white focus:border-brand-500 focus:outline-none min-h-[40px]"
                >
                  <option value="">—</option>
                  <option value="refrigerated">{t('inventory:storageRefrigerated', { defaultValue: 'Refrigerated' })}</option>
                  <option value="frozen">{t('inventory:storageFrozen', { defaultValue: 'Frozen' })}</option>
                  <option value="dry">{t('inventory:storageDry', { defaultValue: 'Dry pantry' })}</option>
                  <option value="ambient">{t('inventory:storageAmbient', { defaultValue: 'Ambient' })}</option>
                </select>
              </div>
            </div>

            {(suggesting || suggestion) && (
              <div className="flex items-center gap-1.5 text-xs text-brand-400/80">
                <Sparkles size={12} className={suggesting ? 'animate-pulse' : ''} />
                {suggesting
                  ? t('inventory:aiThinking', { defaultValue: 'Looking up typical shelf life…' })
                  : suggestion?.source === 'ai'
                    ? t('inventory:aiSuggested', {
                        defaultValue: 'AI suggested {{days}} days, {{storage}}',
                        days: suggestion.shelf_life_days,
                        storage: suggestion.storage_type,
                      })
                    : t('inventory:fallbackSuggested', {
                        defaultValue: 'Defaulted to {{days}} days, {{storage}}',
                        days: suggestion?.shelf_life_days,
                        storage: suggestion?.storage_type,
                      })}
              </div>
            )}

            <div className="flex gap-2 pt-1">
              <button
                type="button"
                onClick={() => setCreateOpen(null)}
                className="flex-1 py-2 bg-neutral-800 text-white font-semibold rounded-lg hover:bg-neutral-700 transition-colors"
              >
                {t('common:buttons.cancel')}
              </button>
              <button
                type="button"
                onClick={submitCreate}
                disabled={creating || !createForm.name.trim()}
                className="flex-1 py-2 bg-brand-600 text-white font-semibold rounded-lg hover:bg-brand-700 transition-colors disabled:opacity-50"
              >
                {creating ? t('common:states.loading') : t('common:buttons.save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

interface RowProps {
  row: LineRow;
  allInventory: InventorySearchResult[];
  onSearch: (q: string) => void;
  onSelect: (item: InventorySearchResult | null) => void;
  onQuantityChange: (v: string) => void;
  onTotalChange: (v: string) => void;
  onToggleDropdown: (show: boolean) => void;
  onRemove: () => void;
  onCreateNew: () => void;
  canRemove: boolean;
}

const LineRowEditor: React.FC<RowProps> = ({
  row,
  allInventory,
  onSearch,
  onSelect,
  onQuantityChange,
  onTotalChange,
  onToggleDropdown,
  onRemove,
  onCreateNew,
  canRemove,
}) => {
  const { t } = useTranslation('admin');
  const dropdownRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handle = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        onToggleDropdown(false);
      }
    };
    if (row.showDropdown) {
      document.addEventListener('mousedown', handle);
      return () => document.removeEventListener('mousedown', handle);
    }
  }, [row.showDropdown, onToggleDropdown]);

  const displayResults = row.searchResults.length > 0
    ? row.searchResults
    : row.searchQuery.trim().length === 0
      ? allInventory.slice(0, 10)
      : [];

  const qtyNum = Number(row.quantity) || 0;
  const totalNum = Number(row.totalCost) || 0;
  const unitCost = qtyNum > 0 && totalNum > 0 ? totalNum / qtyNum : null;

  return (
    <div className="bg-neutral-800/50 rounded-lg p-2.5 space-y-2 border border-neutral-800">
      <div className="relative" ref={dropdownRef}>
        {row.selectedItem ? (
          <div className="flex items-center justify-between gap-2 px-3 py-2 bg-brand-600/20 border border-brand-600/40 rounded-lg text-sm min-h-[40px]">
            <button
              type="button"
              onClick={() => {
                onSelect(null);
                onToggleDropdown(true);
                setTimeout(() => inputRef.current?.focus(), 50);
              }}
              className="flex items-center gap-2 truncate flex-1 text-left"
            >
              <Package size={14} className="text-brand-400 shrink-0" />
              <span className="text-brand-300 truncate">{row.selectedItem.name}</span>
              {row.selectedItem.unit && (
                <span className="text-xs text-brand-400/70 shrink-0">· {row.selectedItem.unit}</span>
              )}
            </button>
            {canRemove && (
              <button
                type="button"
                onClick={onRemove}
                className="p-1 text-brand-400 hover:text-red-400 transition-colors shrink-0"
                aria-label="Remove"
              >
                <Trash2 size={14} />
              </button>
            )}
          </div>
        ) : (
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500" />
            <input
              ref={inputRef}
              type="text"
              placeholder={t('expenses.searchInventory')}
              value={row.searchQuery}
              onChange={(e) => onSearch(e.target.value)}
              onFocus={() => {
                onToggleDropdown(true);
                if (row.searchQuery.trim().length === 0) onSearch('');
              }}
              className="w-full pl-9 pr-8 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-sm text-white placeholder-neutral-500 focus:border-brand-500 focus:outline-none min-h-[40px]"
            />
            <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-500" />
          </div>
        )}

        {row.showDropdown && !row.selectedItem && (
          <div className="absolute z-20 mt-1 w-full bg-neutral-800 border border-neutral-700 rounded-lg shadow-xl max-h-56 overflow-y-auto">
            {row.searching && (
              <div className="px-3 py-2 text-sm text-neutral-500">{t('expenses.searching')}</div>
            )}

            {!row.searching && displayResults.length === 0 && row.searchQuery.trim().length > 0 && (
              <div className="px-3 py-2 text-sm text-neutral-500">{t('expenses.noMatchesFound')}</div>
            )}

            {displayResults.map(inv => (
              <button
                key={inv.id}
                type="button"
                onClick={() => onSelect(inv)}
                className="w-full text-left px-3 py-2 hover:bg-neutral-700 transition-colors min-h-[40px]"
              >
                <div className="text-sm text-white">{inv.name}</div>
                <div className="text-xs text-neutral-500">
                  {inv.quantity} {inv.unit} {t('expenses.inStock')}
                  {inv.category ? ` · ${inv.category}` : ''}
                </div>
              </button>
            ))}

            <button
              type="button"
              onClick={onCreateNew}
              className="w-full text-left px-3 py-2 text-sm text-brand-400 hover:bg-neutral-700 transition-colors min-h-[40px] flex items-center gap-1.5 border-t border-neutral-700"
            >
              <Plus size={14} />
              {t('recipe.newIngredient', { defaultValue: 'Create new ingredient' })}
              {row.searchQuery.trim() && (
                <span className="text-neutral-400">— "{row.searchQuery.trim()}"</span>
              )}
            </button>
          </div>
        )}
      </div>

      {row.selectedItem && (
        <div className="flex items-center gap-2">
          <div className="flex-1">
            <label className="block text-[10px] uppercase tracking-wider text-neutral-500 mb-0.5">
              {t('expenses.qty')} ({row.selectedItem.unit || 'units'})
            </label>
            <input
              type="number"
              inputMode="decimal"
              min={0}
              step="any"
              placeholder="0"
              value={row.quantity}
              onChange={(e) => onQuantityChange(e.target.value)}
              className="w-full px-2 py-1.5 bg-neutral-800 border border-neutral-700 rounded-md text-sm text-white text-center focus:border-brand-500 focus:outline-none min-h-[36px]"
            />
          </div>
          <div className="flex-1">
            <label className="block text-[10px] uppercase tracking-wider text-neutral-500 mb-0.5">
              {t('expenses.total')} $
            </label>
            <input
              type="number"
              inputMode="decimal"
              min={0}
              step="0.01"
              placeholder="0.00"
              value={row.totalCost}
              onChange={(e) => onTotalChange(e.target.value)}
              className="w-full px-2 py-1.5 bg-neutral-800 border border-neutral-700 rounded-md text-sm text-white text-center focus:border-brand-500 focus:outline-none min-h-[36px]"
            />
          </div>
          <div className="flex-1">
            <label className="block text-[10px] uppercase tracking-wider text-neutral-500 mb-0.5">
              {t('expenses.unitCost', { defaultValue: 'per' })} {row.selectedItem.unit || ''}
            </label>
            <div className="px-2 py-1.5 bg-neutral-900 border border-neutral-800 rounded-md text-sm text-neutral-400 text-center min-h-[36px] flex items-center justify-center">
              {unitCost != null ? `$${unitCost.toFixed(2)}` : '—'}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ExpenseInventoryLines;
