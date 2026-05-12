import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  Calculator,
  ChefHat,
  MinusCircle,
  Package,
  Plus,
  Search,
  Settings2,
  Sprout,
  Trash2,
  X,
} from 'lucide-react';
import { createInventoryItem, deleteInventoryItem, getInventory, getItemRecipe, getRecipeSummary, updateItemRecipe } from '../api';
import type { InventoryItem, RecipeIngredient, RecipeSummaryItem } from '../types';
import BrandLogo from '../components/BrandLogo';
import BackToSetupButton from '../components/BackToSetupButton';
import { useToast } from '../context/ToastContext';
import { formatPrice } from '../utils/currency';

interface EditableIngredient {
  inventory_item_id: number | '';
  quantity_used: string;
}

const EMPTY_ROW: EditableIngredient = {
  inventory_item_id: '',
  quantity_used: '',
};

export default function RecipeManagementScreen() {
  const { t } = useTranslation('inventory');
  const { addToast } = useToast();
  const [summaryItems, setSummaryItems] = useState<RecipeSummaryItem[]>([]);
  const [inventoryItems, setInventoryItems] = useState<InventoryItem[]>([]);
  const [selectedItemId, setSelectedItemId] = useState<number | null>(null);
  const [recipeRows, setRecipeRows] = useState<EditableIngredient[]>([]);
  const [loading, setLoading] = useState(true);
  const [recipeLoading, setRecipeLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [error, setError] = useState<string | null>(null);

  const [newIngredientOpen, setNewIngredientOpen] = useState(false);
  const [newIngredientTargetRow, setNewIngredientTargetRow] = useState<number | null>(null);
  const INVENTORY_UNITS = ['kg', 'g', 'L', 'ml', 'pcs', 'box', 'case'] as const;
  const [newIngredientForm, setNewIngredientForm] = useState<{
    name: string;
    unit: string;
    cost_price: string;
    category: string;
    pack_size: string;
  }>({
    name: '', unit: '', cost_price: '', category: '', pack_size: '',
  });
  const [creatingIngredient, setCreatingIngredient] = useState(false);
  const [deletingIngredientId, setDeletingIngredientId] = useState<number | null>(null);
  const [manageIngredientsOpen, setManageIngredientsOpen] = useState(false);
  const [ingredientSearch, setIngredientSearch] = useState('');

  useEffect(() => {
    void loadInitialData();
  }, []);

  useEffect(() => {
    if (!selectedItemId) return;
    void loadRecipe(selectedItemId);
  }, [selectedItemId]);

  const loadInitialData = async () => {
    try {
      setLoading(true);
      setError(null);
      const [summary, inventory] = await Promise.all([getRecipeSummary(), getInventory()]);
      setSummaryItems(summary);
      setInventoryItems(inventory);
      setSelectedItemId(current => current ?? summary[0]?.id ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('recipe.failedLoad'));
    } finally {
      setLoading(false);
    }
  };

  const loadRecipe = async (menuItemId: number) => {
    try {
      setRecipeLoading(true);
      setError(null);
      const recipe = await getItemRecipe(menuItemId);
      setRecipeRows(recipe.length > 0
        ? recipe.map(mapRecipeIngredientToRow)
        : [{ ...EMPTY_ROW }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('recipe.failedLoad'));
      setRecipeRows([{ ...EMPTY_ROW }]);
    } finally {
      setRecipeLoading(false);
    }
  };

  const selectedItem = useMemo(
    () => summaryItems.find(item => item.id === selectedItemId) ?? null,
    [selectedItemId, summaryItems]
  );

  const categories = useMemo(
    () => ['all', ...Array.from(new Set(summaryItems.map(item => item.category_name)))],
    [summaryItems]
  );

  const filteredItems = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    return summaryItems.filter(item => {
      const matchesSearch = !term
        || item.name.toLowerCase().includes(term)
        || item.category_name.toLowerCase().includes(term);
      const matchesCategory = categoryFilter === 'all' || item.category_name === categoryFilter;
      return matchesSearch && matchesCategory;
    });
  }, [categoryFilter, searchTerm, summaryItems]);

  const ingredientLookup = useMemo(
    () => new Map(inventoryItems.map(item => [item.id, item])),
    [inventoryItems]
  );

  const sortedInventory = useMemo(
    () => [...inventoryItems].sort((a, b) => a.name.localeCompare(b.name)),
    [inventoryItems]
  );

  const filteredInventory = useMemo(() => {
    const term = ingredientSearch.trim().toLowerCase();
    if (!term) return sortedInventory;
    return sortedInventory.filter(item => (
      item.name.toLowerCase().includes(term)
      || (item.category || '').toLowerCase().includes(term)
    ));
  }, [ingredientSearch, sortedInventory]);

  const hydratedRecipe = useMemo(() => {
    return recipeRows
      .filter(row => row.inventory_item_id !== '' && row.quantity_used.trim() !== '')
      .map(row => {
        const inventoryItem = ingredientLookup.get(Number(row.inventory_item_id));
        const quantity = Number(row.quantity_used) || 0;
        return {
          inventoryItem,
          quantity,
          lineCost: (inventoryItem?.cost_price || 0) * quantity,
        };
      });
  }, [ingredientLookup, recipeRows]);

  const totalRecipeCost = hydratedRecipe.reduce((sum, row) => sum + row.lineCost, 0);
  const selectedMargin = selectedItem && selectedItem.price > 0
    ? ((selectedItem.price - totalRecipeCost) / selectedItem.price) * 100
    : null;

  const stats = useMemo(() => {
    const totalItems = summaryItems.length;
    const withRecipe = summaryItems.filter(item => item.ingredient_count > 0).length;
    const missingRecipe = totalItems - withRecipe;
    const margins = summaryItems
      .filter(item => item.price > 0 && item.cost_per_unit > 0)
      .map(item => ((item.price - item.cost_per_unit) / item.price) * 100);

    return {
      totalItems,
      withRecipe,
      missingRecipe,
      avgFoodMargin: margins.length > 0
        ? margins.reduce((sum, margin) => sum + margin, 0) / margins.length
        : null,
    };
  }, [summaryItems]);

  const updateRow = (index: number, patch: Partial<EditableIngredient>) => {
    setRecipeRows(current => current.map((row, rowIndex) => (
      rowIndex === index ? { ...row, ...patch } : row
    )));
  };

  const addIngredientRow = () => {
    setRecipeRows(current => [...current, { ...EMPTY_ROW }]);
  };

  const removeIngredientRow = (index: number) => {
    setRecipeRows(current => {
      const next = current.filter((_, rowIndex) => rowIndex !== index);
      return next.length > 0 ? next : [{ ...EMPTY_ROW }];
    });
  };

  const openNewIngredient = (rowIndex: number | null = null) => {
    setNewIngredientTargetRow(rowIndex);
    setNewIngredientForm({ name: '', unit: '', cost_price: '', category: '', pack_size: '' });
    setNewIngredientOpen(true);
  };

  const closeNewIngredient = () => {
    setNewIngredientOpen(false);
    setNewIngredientTargetRow(null);
  };

  const handleDeleteIngredient = async (inventoryItemId: number) => {
    const ingredient = ingredientLookup.get(inventoryItemId);
    if (!ingredient) return;
    if (!confirm(t('recipe.confirmDeleteIngredient', { name: ingredient.name }))) return;
    try {
      setDeletingIngredientId(inventoryItemId);
      setError(null);
      await deleteInventoryItem(inventoryItemId);
      setInventoryItems(current => current.filter(item => item.id !== inventoryItemId));
      setRecipeRows(current => {
        const next = current.map(row => (
          row.inventory_item_id === inventoryItemId ? { ...EMPTY_ROW } : row
        ));
        return next.length > 0 ? next : [{ ...EMPTY_ROW }];
      });
      addToast(t('recipe.ingredientDeleted'), 'success');
    } catch (err) {
      const message = err instanceof Error ? err.message : t('recipe.failedDeleteIngredient');
      setError(message);
      addToast(message, 'error');
    } finally {
      setDeletingIngredientId(null);
    }
  };

  const handleCreateIngredient = async () => {
    const name = newIngredientForm.name.trim();
    const unit = newIngredientForm.unit.trim();
    if (!name || !unit) return;
    try {
      setCreatingIngredient(true);
      setError(null);
      const created = await createInventoryItem({
        name,
        unit,
        cost_price: newIngredientForm.cost_price ? Number(newIngredientForm.cost_price) : undefined,
        category: newIngredientForm.category.trim() || undefined,
        pack_size: newIngredientForm.pack_size ? Number(newIngredientForm.pack_size) : null,
      });
      setInventoryItems(current => [...current, created].sort((a, b) => a.name.localeCompare(b.name)));
      if (newIngredientTargetRow !== null) {
        updateRow(newIngredientTargetRow, { inventory_item_id: created.id });
      }
      addToast(t('recipe.ingredientCreated'), 'success');
      closeNewIngredient();
    } catch (err) {
      const message = err instanceof Error ? err.message : t('recipe.failedCreateIngredient');
      setError(message);
      addToast(message, 'error');
    } finally {
      setCreatingIngredient(false);
    }
  };

  const handleSave = async () => {
    if (!selectedItemId) return;

    const ingredients = recipeRows
      .map(row => ({
        inventory_item_id: Number(row.inventory_item_id),
        quantity_used: Number(row.quantity_used),
      }))
      .filter(row => Number.isFinite(row.inventory_item_id) && row.inventory_item_id > 0 && Number.isFinite(row.quantity_used) && row.quantity_used > 0);

    try {
      setSaving(true);
      setError(null);
      const updatedRecipe = await updateItemRecipe(selectedItemId, ingredients);
      setRecipeRows(updatedRecipe.length > 0
        ? updatedRecipe.map(mapRecipeIngredientToRow)
        : [{ ...EMPTY_ROW }]);
      setSummaryItems(current => current.map(item => (
        item.id === selectedItemId
          ? {
              ...item,
              ingredient_count: updatedRecipe.length,
              cost_per_unit: updatedRecipe.reduce((sum, ingredient) => (
                sum + (ingredient.quantity_used * (ingredient.cost_price || 0))
              ), 0),
            }
          : item
      )));
      addToast(t('recipe.recipeSavedFor', { name: selectedItem?.name || '' }), 'success');
    } catch (err) {
      const message = err instanceof Error ? err.message : t('recipe.failedSave');
      setError(message);
      addToast(message, 'error');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-neutral-950">
        <div className="text-2xl text-brand-600 font-bold animate-pulse">{t('common:states.loading')}</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-neutral-950">
      <div className="bg-neutral-900 text-white p-6 border-b border-neutral-800">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <Link to="/admin" className="p-2 hover:bg-neutral-800 rounded-lg transition-colors">
              <ArrowLeft size={24} />
            </Link>
            <div>
              <h1 className="text-3xl font-black tracking-tighter">{t('recipe.title')}</h1>
              <p className="text-sm text-neutral-400 mt-1">Track ingredients, cost, and margin for every sellable item.</p>
            </div>
          </div>
          <BrandLogo className="h-10" />
        </div>
      </div>

      <div className="max-w-7xl mx-auto p-6 space-y-6">
        {error && (
          <div className="rounded-xl border border-red-900 bg-red-950/40 px-4 py-3 text-sm text-red-300">
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <StatCard icon={<ChefHat size={18} />} label={t('recipe.totalItems')} value={String(stats.totalItems)} />
          <StatCard icon={<Package size={18} />} label={t('recipe.withRecipe')} value={String(stats.withRecipe)} />
          <StatCard icon={<MinusCircle size={18} />} label={t('recipe.missingRecipe')} value={String(stats.missingRecipe)} />
          <StatCard
            icon={<Calculator size={18} />}
            label={t('recipe.avgFoodMargin')}
            value={stats.avgFoodMargin === null ? t('recipe.notSet') : `${stats.avgFoodMargin.toFixed(1)}%`}
          />
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-[360px_minmax(0,1fr)] gap-6">
          <section className="bg-neutral-900 border border-neutral-800 rounded-2xl p-5">
            <div className="space-y-4">
              <div className="relative">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500" />
                <input
                  value={searchTerm}
                  onChange={e => setSearchTerm(e.target.value)}
                  placeholder={t('recipe.searchMenuItems')}
                  className="w-full pl-10 pr-3 py-3 rounded-xl bg-neutral-950 border border-neutral-800 text-white placeholder:text-neutral-500 focus:outline-none focus:border-brand-500"
                />
              </div>

              <select
                value={categoryFilter}
                onChange={e => setCategoryFilter(e.target.value)}
                className="w-full px-3 py-3 rounded-xl bg-neutral-950 border border-neutral-800 text-white focus:outline-none focus:border-brand-500"
              >
                <option value="all">{t('recipe.allCategories')}</option>
                {categories.filter(category => category !== 'all').map(category => (
                  <option key={category} value={category}>{category}</option>
                ))}
              </select>
            </div>

            <div className="mt-5 space-y-2 max-h-[65vh] overflow-y-auto pr-1">
              {filteredItems.length === 0 && (
                <div className="rounded-xl border border-dashed border-neutral-800 px-4 py-8 text-sm text-neutral-500 text-center">
                  {t('recipe.noMatchFilters')}
                </div>
              )}

              {filteredItems.map(item => {
                const isSelected = item.id === selectedItemId;
                const missingRecipe = item.ingredient_count === 0;
                return (
                  <button
                    key={item.id}
                    onClick={() => setSelectedItemId(item.id)}
                    className={`w-full text-left rounded-xl border p-4 transition-colors ${
                      isSelected
                        ? 'border-brand-500 bg-brand-500/10'
                        : 'border-neutral-800 bg-neutral-950 hover:border-neutral-700'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-semibold text-white">{item.name}</p>
                        <p className="text-sm text-neutral-400">{item.category_name}</p>
                      </div>
                      <span className={`text-[11px] px-2 py-1 rounded-full border ${
                        missingRecipe
                          ? 'border-amber-700 bg-amber-950/50 text-amber-300'
                          : 'border-green-800 bg-green-950/40 text-green-300'
                      }`}>
                        {missingRecipe ? t('recipe.missingRecipe') : t('recipe.hasRecipe')}
                      </span>
                    </div>

                    <div className="mt-3 flex items-center justify-between text-sm">
                      <span className="text-neutral-400">{formatPrice(item.price)}</span>
                      <span className="text-neutral-500">
                        {t('recipe.ingredientCount', { count: item.ingredient_count })}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="bg-neutral-900 border border-neutral-800 rounded-2xl p-5">
            {!selectedItem ? (
              <div className="h-full min-h-[420px] flex items-center justify-center text-neutral-500 text-center">
                {t('common:states.noResults')}
              </div>
            ) : (
              <div className="space-y-6">
                <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
                  <div>
                    <h2 className="text-2xl font-bold text-white">{t('recipe.recipeFor', { name: selectedItem.name })}</h2>
                    <p className="text-neutral-400 mt-1">{selectedItem.category_name}</p>
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                    <MiniStat label={t('recipe.price')} value={formatPrice(selectedItem.price)} />
                    <MiniStat label={t('recipe.totalRecipeCost')} value={formatPrice(totalRecipeCost)} />
                    <MiniStat
                      label={t('recipe.margin')}
                      value={selectedMargin === null ? t('recipe.notSet') : `${selectedMargin.toFixed(1)}%`}
                    />
                  </div>
                </div>

                <div className="space-y-3">
                  {recipeLoading ? (
                    <div className="rounded-xl border border-neutral-800 bg-neutral-950 px-4 py-10 text-center text-neutral-500">
                      {t('common:states.loading')}
                    </div>
                  ) : (
                    recipeRows.map((row, index) => {
                      const ingredient = row.inventory_item_id === '' ? null : ingredientLookup.get(Number(row.inventory_item_id)) ?? null;
                      const quantity = Number(row.quantity_used) || 0;
                      const lineCost = (ingredient?.cost_price || 0) * quantity;

                      return (
                        <div key={`${selectedItem.id}-${index}`} className="grid grid-cols-1 lg:grid-cols-[minmax(0,1.6fr)_140px_120px_120px_56px] gap-3 items-center rounded-xl border border-neutral-800 bg-neutral-950 p-4">
                          <div>
                            <label className="block text-xs font-medium text-neutral-500 mb-2">{t('recipe.ingredient')}</label>
                            <div className="flex gap-2">
                              <select
                                value={row.inventory_item_id}
                                onChange={e => updateRow(index, {
                                  inventory_item_id: e.target.value === '' ? '' : Number(e.target.value),
                                })}
                                className="flex-1 min-w-0 px-3 py-3 rounded-lg bg-neutral-900 border border-neutral-800 text-white focus:outline-none focus:border-brand-500"
                              >
                                <option value="">{t('recipe.selectIngredient')}</option>
                                {inventoryItems.map(item => (
                                  <option key={item.id} value={item.id}>{item.name}</option>
                                ))}
                              </select>
                              <button
                                type="button"
                                onClick={() => openNewIngredient(index)}
                                className="shrink-0 px-3 rounded-lg border border-neutral-700 bg-neutral-900 text-neutral-300 hover:text-white hover:border-brand-500 transition-colors inline-flex items-center gap-1 text-sm"
                                title={t('recipe.newIngredient')}
                              >
                                <Sprout size={16} />
                                <span className="hidden sm:inline">{t('recipe.newIngredient')}</span>
                              </button>
                              {ingredient && (
                                <button
                                  type="button"
                                  onClick={() => handleDeleteIngredient(ingredient.id)}
                                  disabled={deletingIngredientId === ingredient.id}
                                  className="shrink-0 px-3 rounded-lg border border-neutral-700 bg-neutral-900 text-neutral-400 hover:text-red-300 hover:border-red-800 disabled:opacity-50 transition-colors inline-flex items-center"
                                  title={t('recipe.deleteIngredient')}
                                >
                                  <Trash2 size={16} />
                                </button>
                              )}
                            </div>
                          </div>

                          <div>
                            <label className="block text-xs font-medium text-neutral-500 mb-2">{t('recipe.qtyUsed')}</label>
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              value={row.quantity_used}
                              onChange={e => updateRow(index, { quantity_used: e.target.value })}
                              className="w-full px-3 py-3 rounded-lg bg-neutral-900 border border-neutral-800 text-white focus:outline-none focus:border-brand-500"
                            />
                          </div>

                          <div>
                            <label className="block text-xs font-medium text-neutral-500 mb-2">{t('recipe.unit')}</label>
                            <div className="px-3 py-3 rounded-lg bg-neutral-900 border border-neutral-800 text-neutral-300">
                              {ingredient?.unit || t('recipe.none')}
                            </div>
                          </div>

                          <div>
                            <label className="block text-xs font-medium text-neutral-500 mb-2">{t('recipe.lineCost')}</label>
                            <div className="px-3 py-3 rounded-lg bg-neutral-900 border border-neutral-800 text-white">
                              {formatPrice(lineCost)}
                            </div>
                          </div>

                          <button
                            onClick={() => removeIngredientRow(index)}
                            className="mt-6 h-11 w-11 rounded-lg border border-neutral-800 bg-neutral-900 text-neutral-400 hover:text-red-300 hover:border-red-800 transition-colors flex items-center justify-center"
                            title={t('common:buttons.remove')}
                          >
                            <MinusCircle size={18} />
                          </button>
                        </div>
                      );
                    })
                  )}

                  {!recipeLoading && hydratedRecipe.length === 0 && recipeRows.length === 1 && recipeRows[0].inventory_item_id === '' && (
                    <div className="rounded-xl border border-dashed border-neutral-800 px-4 py-8 text-center text-neutral-500">
                      {t('recipe.noIngredients')}
                    </div>
                  )}
                </div>

                <div className="flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between pt-2">
                  <div className="flex flex-col sm:flex-row gap-3">
                    <button
                      onClick={addIngredientRow}
                      className="px-4 py-3 rounded-xl border border-neutral-700 bg-neutral-950 text-white hover:border-neutral-600 transition-colors inline-flex items-center justify-center gap-2"
                    >
                      <Plus size={18} />
                      {t('recipe.addIngredient')}
                    </button>
                    <button
                      onClick={() => openNewIngredient(null)}
                      className="px-4 py-3 rounded-xl border border-neutral-700 bg-neutral-950 text-neutral-300 hover:text-white hover:border-brand-500 transition-colors inline-flex items-center justify-center gap-2"
                    >
                      <Sprout size={18} />
                      {t('recipe.newIngredient')}
                    </button>
                    <button
                      onClick={() => { setIngredientSearch(''); setManageIngredientsOpen(true); }}
                      className="px-4 py-3 rounded-xl border border-neutral-700 bg-neutral-950 text-neutral-300 hover:text-white hover:border-brand-500 transition-colors inline-flex items-center justify-center gap-2"
                    >
                      <Settings2 size={18} />
                      {t('recipe.manageIngredients')}
                    </button>
                  </div>

                  <button
                    onClick={handleSave}
                    disabled={saving || recipeLoading}
                    className="px-5 py-3 rounded-xl bg-brand-600 text-white font-medium hover:bg-brand-500 disabled:opacity-60 transition-colors"
                  >
                    {saving ? t('recipe.saving') : t('recipe.saveRecipe')}
                  </button>
                </div>
              </div>
            )}
          </section>
        </div>
      </div>

      {newIngredientOpen && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50">
          <div className="bg-neutral-900 rounded-2xl border border-neutral-800 shadow-xl max-w-md w-full p-6">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-xl font-bold text-white flex items-center gap-2">
                <Sprout size={20} />
                {t('recipe.newIngredient')}
              </h2>
              <button
                onClick={closeNewIngredient}
                className="text-neutral-500 hover:text-neutral-300"
              >
                <X size={20} />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-neutral-300 mb-2">
                  {t('recipe.ingredientName')}
                </label>
                <input
                  type="text"
                  value={newIngredientForm.name}
                  onChange={e => setNewIngredientForm({ ...newIngredientForm, name: e.target.value })}
                  placeholder={t('recipe.ingredientNamePlaceholder')}
                  autoFocus
                  className="w-full px-4 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:border-brand-500"
                />
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-sm font-medium text-neutral-300 mb-2">
                    {t('recipe.unit')}
                  </label>
                  <select
                    value={newIngredientForm.unit}
                    onChange={e => setNewIngredientForm({ ...newIngredientForm, unit: e.target.value })}
                    className="w-full px-3 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-white focus:outline-none focus:border-brand-500"
                  >
                    <option value="">{t('recipe.unitPlaceholder')}</option>
                    {INVENTORY_UNITS.map(u => (
                      <option key={u} value={u}>{u}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label
                    className="block text-sm font-medium text-neutral-300 mb-2"
                    title={t('recipe.packSizeHelp')}
                  >
                    {t('recipe.packSize')}
                  </label>
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={newIngredientForm.pack_size}
                    onChange={e => setNewIngredientForm({ ...newIngredientForm, pack_size: e.target.value })}
                    placeholder={t('recipe.packSizePlaceholder')}
                    className="w-full px-3 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:border-brand-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-neutral-300 mb-2">
                    {t('recipe.costPerUnit')}
                  </label>
                  <div className="flex items-center">
                    <span className="text-neutral-400 font-medium">$</span>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={newIngredientForm.cost_price}
                      onChange={e => setNewIngredientForm({ ...newIngredientForm, cost_price: e.target.value })}
                      placeholder="0.00"
                      className="w-full ml-1 px-3 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:border-brand-500"
                    />
                  </div>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-neutral-300 mb-2">
                  {t('recipe.ingredientCategory')}
                </label>
                <input
                  type="text"
                  value={newIngredientForm.category}
                  onChange={e => setNewIngredientForm({ ...newIngredientForm, category: e.target.value })}
                  placeholder={t('recipe.ingredientCategoryPlaceholder')}
                  className="w-full px-4 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:border-brand-500"
                />
              </div>
            </div>

            <div className="flex gap-3 mt-6">
              <button
                onClick={closeNewIngredient}
                className="flex-1 px-4 py-2 border border-neutral-700 text-neutral-300 rounded-lg hover:bg-neutral-800 transition-colors font-medium min-h-[44px]"
              >
                {t('common:buttons.cancel')}
              </button>
              <button
                onClick={handleCreateIngredient}
                disabled={creatingIngredient || !newIngredientForm.name.trim() || !newIngredientForm.unit.trim()}
                className="flex-1 px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-500 transition-colors font-medium disabled:opacity-50 min-h-[44px]"
              >
                {creatingIngredient ? t('recipe.saving') : t('recipe.createIngredient')}
              </button>
            </div>
          </div>
        </div>
      )}

      {manageIngredientsOpen && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50">
          <div className="bg-neutral-900 rounded-2xl border border-neutral-800 shadow-xl max-w-2xl w-full max-h-[85vh] flex flex-col">
            <div className="flex items-center justify-between p-6 border-b border-neutral-800">
              <div>
                <h2 className="text-xl font-bold text-white flex items-center gap-2">
                  <Settings2 size={20} />
                  {t('recipe.manageIngredientsTitle')}
                </h2>
                <p className="text-sm text-neutral-400 mt-1">{t('recipe.manageIngredientsHint')}</p>
              </div>
              <button
                onClick={() => setManageIngredientsOpen(false)}
                className="text-neutral-500 hover:text-neutral-300"
              >
                <X size={20} />
              </button>
            </div>

            <div className="p-6 pb-3">
              <div className="relative">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500" />
                <input
                  type="text"
                  value={ingredientSearch}
                  onChange={e => setIngredientSearch(e.target.value)}
                  placeholder={t('recipe.searchIngredients')}
                  autoFocus
                  className="w-full pl-10 pr-3 py-3 rounded-xl bg-neutral-950 border border-neutral-800 text-white placeholder:text-neutral-500 focus:outline-none focus:border-brand-500"
                />
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-6 pb-6 space-y-2">
              {sortedInventory.length === 0 ? (
                <div className="rounded-xl border border-dashed border-neutral-800 px-4 py-10 text-sm text-neutral-500 text-center">
                  {t('recipe.noIngredientsYet')}
                </div>
              ) : filteredInventory.length === 0 ? (
                <div className="rounded-xl border border-dashed border-neutral-800 px-4 py-10 text-sm text-neutral-500 text-center">
                  {t('recipe.noIngredientsFound')}
                </div>
              ) : (
                filteredInventory.map(item => (
                  <div
                    key={item.id}
                    className="flex items-center justify-between gap-3 rounded-xl border border-neutral-800 bg-neutral-950 px-4 py-3"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-white truncate">{item.name}</p>
                      <p className="text-xs text-neutral-500 mt-0.5">
                        {item.unit}
                        {item.category ? ` · ${item.category}` : ''}
                        {item.cost_price ? ` · ${formatPrice(item.cost_price)}/${item.unit}` : ''}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleDeleteIngredient(item.id)}
                      disabled={deletingIngredientId === item.id}
                      className="shrink-0 px-3 py-2 rounded-lg border border-neutral-800 bg-neutral-900 text-neutral-400 hover:text-red-300 hover:border-red-800 disabled:opacity-50 transition-colors inline-flex items-center gap-2 text-sm"
                      title={t('recipe.deleteIngredient')}
                    >
                      <Trash2 size={16} />
                      <span className="hidden sm:inline">{t('common:buttons.remove')}</span>
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      <BackToSetupButton />
    </div>
  );
}

function mapRecipeIngredientToRow(ingredient: RecipeIngredient): EditableIngredient {
  return {
    inventory_item_id: ingredient.inventory_item_id,
    quantity_used: String(ingredient.quantity_used),
  };
}

const StatCard: React.FC<{ icon: React.ReactNode; label: string; value: string }> = ({ icon, label, value }) => (
  <div className="rounded-2xl border border-neutral-800 bg-neutral-900 p-4">
    <div className="flex items-center gap-2 text-neutral-400 text-sm">
      {icon}
      <span>{label}</span>
    </div>
    <div className="mt-3 text-2xl font-bold text-white">{value}</div>
  </div>
);

const MiniStat: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="rounded-xl border border-neutral-800 bg-neutral-950 px-4 py-3 min-w-[120px]">
    <div className="text-xs uppercase tracking-wide text-neutral-500">{label}</div>
    <div className="mt-1 text-lg font-semibold text-white">{value}</div>
  </div>
);
