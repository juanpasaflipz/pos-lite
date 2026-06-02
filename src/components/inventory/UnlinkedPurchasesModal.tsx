import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Plus, Trash2, Search, Check, Loader2, ChevronDown, ChevronUp } from 'lucide-react';
import {
  UnlinkedExpense,
  searchInventory,
  linkExpenseToInventory,
  InventorySearchResult,
  InventoryMatch,
} from '../../api';

interface Props {
  expenses: UnlinkedExpense[];
  open: boolean;
  onClose: () => void;
  onLinked: () => void;
}

interface LineRow {
  key: string;
  rawDescription: string;
  selectedItem: InventorySearchResult | null;
  quantity: string;
  unitCost: string;
  searchQuery: string;
  searchResults: InventorySearchResult[];
  searching: boolean;
  showResults: boolean;
}

function newRow(seed?: { description?: string; quantity?: number; unit_price?: number }): LineRow {
  return {
    key: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    rawDescription: seed?.description || '',
    selectedItem: null,
    quantity: seed?.quantity ? String(seed.quantity) : '1',
    unitCost: seed?.unit_price ? String(seed.unit_price) : '',
    searchQuery: seed?.description || '',
    searchResults: [],
    searching: false,
    showResults: false,
  };
}

export default function UnlinkedPurchasesModal({ expenses, open, onClose, onLinked }: Props) {
  const { t } = useTranslation('inventory');
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [rowsByExpense, setRowsByExpense] = useState<Record<number, LineRow[]>>({});
  const [savingId, setSavingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const debounceTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  // Auto-expand the first expense when modal opens
  useEffect(() => {
    if (open && expenses.length > 0 && expandedId === null) {
      const first = expenses[0];
      setExpandedId(first.id);
      ensureRows(first);
    }
  }, [open, expenses, expandedId]);

  const ensureRows = (exp: UnlinkedExpense) => {
    if (rowsByExpense[exp.id]) return;
    const seedRows = exp.parsed_items && exp.parsed_items.length > 0
      ? exp.parsed_items.map((it) => newRow(it))
      : [newRow()];
    setRowsByExpense((prev) => ({ ...prev, [exp.id]: seedRows }));
  };

  const toggleExpand = (exp: UnlinkedExpense) => {
    if (expandedId === exp.id) {
      setExpandedId(null);
    } else {
      setExpandedId(exp.id);
      ensureRows(exp);
    }
  };

  const updateRow = (expenseId: number, key: string, patch: Partial<LineRow>) => {
    setRowsByExpense((prev) => ({
      ...prev,
      [expenseId]: (prev[expenseId] || []).map((r) => (r.key === key ? { ...r, ...patch } : r)),
    }));
  };

  const addRow = (expenseId: number) => {
    setRowsByExpense((prev) => ({
      ...prev,
      [expenseId]: [...(prev[expenseId] || []), newRow()],
    }));
  };

  const removeRow = (expenseId: number, key: string) => {
    setRowsByExpense((prev) => ({
      ...prev,
      [expenseId]: (prev[expenseId] || []).filter((r) => r.key !== key),
    }));
  };

  const handleSearchChange = (expenseId: number, row: LineRow, value: string) => {
    updateRow(expenseId, row.key, { searchQuery: value, showResults: true, selectedItem: null });
    const timerKey = `${expenseId}-${row.key}`;
    if (debounceTimers.current[timerKey]) clearTimeout(debounceTimers.current[timerKey]);
    if (value.trim().length < 2) {
      updateRow(expenseId, row.key, { searchResults: [], searching: false });
      return;
    }
    updateRow(expenseId, row.key, { searching: true });
    debounceTimers.current[timerKey] = setTimeout(async () => {
      try {
        const results = await searchInventory(value.trim());
        updateRow(expenseId, row.key, { searchResults: results, searching: false });
      } catch {
        updateRow(expenseId, row.key, { searchResults: [], searching: false });
      }
    }, 250);
  };

  const selectItem = (expenseId: number, row: LineRow, item: InventorySearchResult) => {
    updateRow(expenseId, row.key, {
      selectedItem: item,
      searchQuery: item.name,
      showResults: false,
      unitCost: row.unitCost || (item.cost_price ? String(item.cost_price) : ''),
    });
  };

  const saveLinks = async (expense: UnlinkedExpense) => {
    setError(null);
    const rows = rowsByExpense[expense.id] || [];
    const matches: InventoryMatch[] = [];
    for (const r of rows) {
      if (!r.selectedItem) continue;
      const qty = parseFloat(r.quantity);
      if (!Number.isFinite(qty) || qty <= 0) continue;
      const cost = parseFloat(r.unitCost);
      matches.push({
        inventory_item_id: r.selectedItem.id,
        inventory_item_name: r.selectedItem.name,
        quantity: qty,
        cost_price: Number.isFinite(cost) && cost > 0 ? cost : undefined,
        raw_description: r.rawDescription || r.searchQuery || undefined,
      });
    }

    if (matches.length === 0) {
      setError(t('unlinked.noRowsError'));
      return;
    }

    try {
      setSavingId(expense.id);
      await linkExpenseToInventory(expense.id, matches);
      onLinked();
    } catch (err: any) {
      setError(err?.message || t('unlinked.linkFailed'));
    } finally {
      setSavingId(null);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
      <div className="w-full max-w-4xl max-h-[90vh] bg-neutral-900 border border-neutral-800 rounded-lg shadow-2xl flex flex-col">
        <div className="flex items-center justify-between p-5 border-b border-neutral-800">
          <div>
            <h3 className="text-lg font-semibold text-white">{t('unlinked.modalTitle')}</h3>
            <p className="text-xs text-neutral-400 mt-1">{t('unlinked.modalSubtitle')}</p>
          </div>
          <button onClick={onClose} className="p-2 text-neutral-400 hover:text-white hover:bg-neutral-800 rounded-lg">
            <X size={20} />
          </button>
        </div>

        {error && (
          <div className="mx-5 mt-3 p-3 bg-brand-900/30 border border-brand-800 rounded text-sm text-brand-300">
            {error}
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          {expenses.length === 0 ? (
            <div className="text-center py-12 text-neutral-400">
              <Check size={40} className="mx-auto mb-3 text-cockpit-in-text" />
              <p>{t('unlinked.allClear')}</p>
            </div>
          ) : (
            expenses.map((exp) => {
              const isExpanded = expandedId === exp.id;
              const rows = rowsByExpense[exp.id] || [];
              return (
                <div key={exp.id} className="border border-neutral-800 rounded-lg overflow-hidden bg-neutral-950">
                  <button
                    onClick={() => toggleExpand(exp)}
                    className="w-full flex items-center gap-3 p-4 hover:bg-neutral-800/50 text-left transition-colors"
                  >
                    {isExpanded ? <ChevronUp size={18} className="text-neutral-500" /> : <ChevronDown size={18} className="text-neutral-500" />}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-white">{exp.vendor || t('unlinked.noVendor')}</span>
                        <span className="px-2 py-0.5 bg-neutral-800 text-neutral-400 rounded text-xs uppercase">{exp.category}</span>
                        <span className="text-xs text-neutral-500">{new Date(exp.expense_date).toLocaleDateString()}</span>
                      </div>
                      {exp.description && (
                        <p className="text-xs text-neutral-400 mt-1 truncate">{exp.description}</p>
                      )}
                    </div>
                    <div className="text-lg font-bold text-white tabular-nums">
                      ${Number(exp.amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </div>
                  </button>

                  {isExpanded && (
                    <div className="px-4 pb-4 pt-1 border-t border-neutral-800 bg-neutral-900/30">
                      {exp.parsed_items.length > 0 && rows.length === exp.parsed_items.length && (
                        <p className="text-xs text-cockpit-in-text mb-3">{t('unlinked.parsedSeedHint')}</p>
                      )}
                      <div className="space-y-3">
                        {rows.map((row) => (
                          <div key={row.key} className="grid grid-cols-12 gap-2 items-start">
                            <div className="col-span-12 md:col-span-5 relative">
                              <div className="relative">
                                <Search className="absolute left-3 top-2.5 text-neutral-500" size={16} />
                                <input
                                  type="text"
                                  value={row.searchQuery}
                                  onChange={(e) => handleSearchChange(exp.id, row, e.target.value)}
                                  onFocus={() => updateRow(exp.id, row.key, { showResults: true })}
                                  placeholder={t('unlinked.searchPlaceholder')}
                                  className={`w-full pl-9 pr-3 py-2 bg-neutral-800 border rounded text-sm text-white focus:outline-none ${
                                    row.selectedItem ? 'border-cockpit-green focus:border-cockpit-green' : 'border-neutral-700 focus:border-brand-600'
                                  }`}
                                />
                                {row.searching && (
                                  <Loader2 className="absolute right-3 top-2.5 text-neutral-500 animate-spin" size={16} />
                                )}
                              </div>
                              {row.showResults && row.searchResults.length > 0 && !row.selectedItem && (
                                <div className="absolute z-10 left-0 right-0 mt-1 bg-neutral-800 border border-neutral-700 rounded-md shadow-lg max-h-60 overflow-y-auto">
                                  {row.searchResults.map((it) => (
                                    <button
                                      key={it.id}
                                      type="button"
                                      onClick={() => selectItem(exp.id, row, it)}
                                      className="w-full text-left px-3 py-2 hover:bg-neutral-700 text-sm text-white border-b border-neutral-700 last:border-b-0"
                                    >
                                      <div className="font-medium">{it.name}</div>
                                      <div className="text-xs text-neutral-400">
                                        {it.category && <span>{it.category} · </span>}
                                        {it.quantity} {it.unit}
                                        {it.cost_price ? ` · $${Number(it.cost_price).toFixed(2)}/${it.unit}` : ''}
                                      </div>
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>

                            <input
                              type="number"
                              min="0"
                              step="any"
                              value={row.quantity}
                              onChange={(e) => updateRow(exp.id, row.key, { quantity: e.target.value })}
                              placeholder={t('unlinked.qty')}
                              title={t('unlinked.qty')}
                              className="col-span-4 md:col-span-2 px-2 py-2 bg-neutral-800 border border-neutral-700 rounded text-sm text-white focus:outline-none focus:border-brand-600"
                            />

                            <div className="col-span-4 md:col-span-3 relative">
                              <span className="absolute left-2 top-2 text-neutral-500 text-sm">$</span>
                              <input
                                type="number"
                                min="0"
                                step="0.01"
                                value={row.unitCost}
                                onChange={(e) => updateRow(exp.id, row.key, { unitCost: e.target.value })}
                                placeholder={t('unlinked.unitCost')}
                                title={t('unlinked.unitCost')}
                                className="w-full pl-6 pr-2 py-2 bg-neutral-800 border border-neutral-700 rounded text-sm text-white focus:outline-none focus:border-brand-600"
                              />
                            </div>

                            <div className="col-span-4 md:col-span-2 flex items-center justify-end gap-1">
                              {rows.length > 1 && (
                                <button
                                  onClick={() => removeRow(exp.id, row.key)}
                                  title={t('unlinked.removeRow')}
                                  className="p-2 text-cockpit-out-text hover:bg-cockpit-red/30 rounded"
                                >
                                  <Trash2 size={14} />
                                </button>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>

                      <div className="flex items-center justify-between mt-4">
                        <button
                          onClick={() => addRow(exp.id)}
                          className="flex items-center gap-1 text-sm text-brand-400 hover:text-brand-300"
                        >
                          <Plus size={14} />
                          {t('unlinked.addRow')}
                        </button>
                        <div className="flex items-center gap-3">
                          <span className="text-xs text-neutral-500">
                            {t('unlinked.expenseTotal')}: <span className="text-neutral-300">${Number(exp.amount).toFixed(2)}</span>
                          </span>
                          <button
                            onClick={() => saveLinks(exp)}
                            disabled={savingId === exp.id || rows.every((r) => !r.selectedItem)}
                            className="px-4 py-2 bg-brand-600 text-white rounded hover:bg-brand-700 disabled:opacity-50 text-sm font-medium flex items-center gap-2"
                          >
                            {savingId === exp.id ? (
                              <><Loader2 size={14} className="animate-spin" /> {t('unlinked.linking')}</>
                            ) : (
                              <><Check size={14} /> {t('unlinked.linkAndApply')}</>
                            )}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        <div className="flex items-center justify-between p-4 border-t border-neutral-800 bg-neutral-900">
          <p className="text-xs text-neutral-500">{t('unlinked.footerHint')}</p>
          <button
            onClick={onClose}
            className="px-4 py-2 bg-neutral-800 text-neutral-300 rounded hover:bg-neutral-700 text-sm"
          >
            {t('unlinked.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
