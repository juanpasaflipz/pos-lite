import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Plus, X, Layers, Upload, FileSpreadsheet, Sparkles } from 'lucide-react';
import {
  getCategories,
  getMenuItems,
  createMenuItem,
  updateMenuItem,
  toggleMenuItem,
  createCategory,
  updateCategory,
  toggleCategory,
  getModifierGroups,
  getModifierGroupsForItem,
  assignModifierGroupToItem,
  removeModifierGroupFromItem,
} from '../api';
import { MenuCategory, MenuItem, ModifierGroup } from '../types';
import { invalidateMenuCache } from '../lib/menuCache';
import BrandLogo from '../components/BrandLogo';
import { usePlan } from '../context/PlanContext';
import UpgradePrompt from '../components/UpgradePrompt';
import CategoryManagementView from '../components/menu/CategoryManagementView';
import ItemsView from '../components/menu/ItemsView';
import ItemFormModal from '../components/menu/ItemFormModal';
import TemplatePickerModal from '../components/menu/TemplatePickerModal';
import ImportMenuModal from '../components/menu/ImportMenuModal';
import AIMenuBuilderModal from '../components/menu/AIMenuBuilderModal';
import BackToSetupButton from '../components/BackToSetupButton';

type ModalMode = 'add' | 'edit' | null;
type View = 'items' | 'categories';
type ItemSubTab = 'live' | 'pre-menu';

interface FormData {
  name: string;
  price: string;
  description: string;
  category_id: string;
  image_url: string;
}

interface CategoryFormData {
  name: string;
  sort_order: string;
}

export default function MenuManagement() {
  const { t } = useTranslation('inventory');
  const { limits, isAtLimit } = usePlan();
  const [view, setView] = useState<View>('items');
  const [itemSubTab, setItemSubTab] = useState<ItemSubTab>('live');
  const [categories, setCategories] = useState<MenuCategory[]>([]);
  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalMode, setModalMode] = useState<ModalMode>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [formData, setFormData] = useState<FormData>({
    name: '', price: '', description: '', category_id: '', image_url: '',
  });
  const [formErrors, setFormErrors] = useState<Partial<FormData>>({});
  const [actionLoading, setActionLoading] = useState(false);

  // Modifier assignment state
  const [allModifierGroups, setAllModifierGroups] = useState<ModifierGroup[]>([]);
  const [assignedGroupIds, setAssignedGroupIds] = useState<Set<number>>(new Set());
  const [modifierLoading, setModifierLoading] = useState(false);

  // Category management state
  const [showCategoryForm, setShowCategoryForm] = useState(false);
  const [editingCategoryId, setEditingCategoryId] = useState<number | null>(null);
  const [categoryFormData, setCategoryFormData] = useState<CategoryFormData>({ name: '', sort_order: '' });

  // Import modals
  const [showTemplatePicker, setShowTemplatePicker] = useState(false);
  const [showCSVImport, setShowCSVImport] = useState(false);
  const [showAIBuilder, setShowAIBuilder] = useState(false);

  useEffect(() => { fetchCategories(); }, []);
  useEffect(() => { if (selectedCategory && view === 'items') fetchMenuItems(selectedCategory); }, [selectedCategory, view]);

  const fetchCategories = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await getCategories();
      setCategories(data);
      if (data.length > 0 && !selectedCategory) setSelectedCategory(data[0].id);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.fetchCategories'));
    } finally {
      setLoading(false);
    }
  };

  const fetchMenuItems = async (categoryId: number) => {
    try {
      setError(null);
      const data = await getMenuItems(String(categoryId), true);
      setMenuItems(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.fetchMenuItems'));
    }
  };

  const liveItems = menuItems.filter(i => i.active);
  const preMenuItems = menuItems.filter(i => !i.active);

  const validateForm = (): boolean => {
    const errors: Partial<FormData> = {};
    if (!formData.name.trim()) errors.name = t('menu.form.itemNameRequired');
    if (!formData.price) errors.price = t('menu.form.priceRequired');
    else if (isNaN(parseFloat(formData.price)) || parseFloat(formData.price) <= 0) errors.price = t('menu.form.pricePositive');
    if (!formData.category_id) errors.category_id = t('menu.form.categoryRequired');
    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleToggleModifierGroup = async (groupId: number) => {
    const isAssigned = assignedGroupIds.has(groupId);
    const newSet = new Set(assignedGroupIds);
    if (isAssigned) newSet.delete(groupId); else newSet.add(groupId);
    setAssignedGroupIds(newSet);
    if (editingId) {
      try {
        if (isAssigned) await removeModifierGroupFromItem(editingId, groupId);
        else await assignModifierGroupToItem(editingId, groupId);
      } catch {
        setAssignedGroupIds(assignedGroupIds);
      }
    }
  };

  const handleAddItem = async () => {
    if (!validateForm()) return;
    setActionLoading(true);
    try {
      setError(null);
      const newItem = await createMenuItem({
        category_id: parseInt(formData.category_id),
        name: formData.name.trim(),
        price: parseFloat(formData.price),
        description: formData.description.trim() || undefined,
        image_url: formData.image_url.trim() || undefined,
      });
      if (assignedGroupIds.size > 0 && newItem?.id) {
        await Promise.all(Array.from(assignedGroupIds).map(gId => assignModifierGroupToItem(newItem.id, gId).catch(() => {})));
      }
      await invalidateMenuCache();
      const targetCategory = parseInt(formData.category_id);
      if (targetCategory === selectedCategory) await fetchMenuItems(targetCategory);
      else setSelectedCategory(targetCategory);
      closeModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.addItem'));
    } finally {
      setActionLoading(false);
    }
  };

  const handleEditItem = async () => {
    if (!editingId || !validateForm()) return;
    setActionLoading(true);
    try {
      setError(null);
      await updateMenuItem(editingId, {
        category_id: parseInt(formData.category_id),
        name: formData.name.trim(),
        price: parseFloat(formData.price),
        description: formData.description.trim() || undefined,
        image_url: formData.image_url.trim() || undefined,
      });
      await invalidateMenuCache();
      const targetCategory = parseInt(formData.category_id);
      if (selectedCategory) await fetchMenuItems(selectedCategory);
      if (targetCategory !== selectedCategory) setSelectedCategory(targetCategory);
      closeModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.editItem'));
    } finally {
      setActionLoading(false);
    }
  };

  const handleToggleItem = async (id: number) => {
    if (!selectedCategory) return;
    try {
      setError(null);
      await toggleMenuItem(id);
      await invalidateMenuCache();
      await fetchMenuItems(selectedCategory);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.toggleItem'));
    }
  };

  const openAddModal = async () => {
    setFormData({ name: '', price: '', description: '', category_id: selectedCategory ? String(selectedCategory) : '', image_url: '' });
    setFormErrors({});
    setEditingId(null);
    setAssignedGroupIds(new Set());
    setModalMode('add');
    try {
      const allGroups = await getModifierGroups();
      setAllModifierGroups(allGroups.filter(g => g.active));
    } catch { setAllModifierGroups([]); }
  };

  const openEditModal = async (item: MenuItem) => {
    setFormData({ name: item.name, price: item.price.toString(), description: item.description || '', category_id: String(item.category_id), image_url: item.image_url || '' });
    setFormErrors({});
    setEditingId(item.id);
    setModalMode('edit');
    setModifierLoading(true);
    try {
      const [allGroups, itemGroups] = await Promise.all([getModifierGroups(), getModifierGroupsForItem(item.id)]);
      setAllModifierGroups(allGroups.filter(g => g.active));
      setAssignedGroupIds(new Set(itemGroups.map(g => g.id)));
    } catch {
      setAllModifierGroups([]);
      setAssignedGroupIds(new Set());
    } finally { setModifierLoading(false); }
  };

  const closeModal = () => {
    setModalMode(null);
    setEditingId(null);
    setFormData({ name: '', price: '', description: '', category_id: '', image_url: '' });
    setFormErrors({});
    setAllModifierGroups([]);
    setAssignedGroupIds(new Set());
  };

  const getCategoryName = (id: number | null) => {
    if (!id) return 'Unknown';
    return categories.find((c) => c.id === id)?.name || 'Unknown';
  };

  // Category management handlers
  const handleCreateCategory = async () => {
    if (!categoryFormData.name.trim()) return;
    try {
      setError(null);
      await createCategory({ name: categoryFormData.name.trim(), sort_order: categoryFormData.sort_order ? parseInt(categoryFormData.sort_order) : undefined });
      setCategoryFormData({ name: '', sort_order: '' });
      setShowCategoryForm(false);
      await fetchCategories();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.createCategory'));
    }
  };

  const handleUpdateCategory = async () => {
    if (!editingCategoryId || !categoryFormData.name.trim()) return;
    try {
      setError(null);
      await updateCategory(editingCategoryId, { name: categoryFormData.name.trim(), sort_order: categoryFormData.sort_order ? parseInt(categoryFormData.sort_order) : undefined });
      setEditingCategoryId(null);
      setCategoryFormData({ name: '', sort_order: '' });
      await fetchCategories();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.updateCategory'));
    }
  };

  const handleToggleCategory = async (id: number) => {
    try {
      setError(null);
      await toggleCategory(id);
      await invalidateMenuCache();
      await fetchCategories();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.toggleCategory'));
    }
  };

  const startEditCategory = (cat: MenuCategory) => {
    setEditingCategoryId(cat.id);
    setCategoryFormData({ name: cat.name, sort_order: String(cat.sort_order) });
  };

  const handleMoveCategoryOrder = async (cat: MenuCategory, direction: 'up' | 'down') => {
    const newOrder = direction === 'up' ? cat.sort_order - 1 : cat.sort_order + 1;
    try {
      await updateCategory(cat.id, { sort_order: newOrder });
      await fetchCategories();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.reorder'));
    }
  };

  return (
    <div className="min-h-screen bg-neutral-950">
      <div className="bg-neutral-900 text-white p-6 border-b border-neutral-800">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link to="/admin" className="p-2 hover:bg-neutral-800 rounded-lg transition-colors">
              <ArrowLeft size={24} />
            </Link>
            <h1 className="text-3xl font-black tracking-tighter">{t('menu.title')}</h1>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex bg-neutral-800 rounded-lg p-1">
              <button
                onClick={() => setView('items')}
                className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                  view === 'items' ? 'bg-brand-600 text-white' : 'text-neutral-400 hover:text-white'
                }`}
              >
                {t('menu.items')}
              </button>
              <button
                onClick={() => setView('categories')}
                className={`px-4 py-2 rounded-md text-sm font-medium transition-colors flex items-center gap-1.5 ${
                  view === 'categories' ? 'bg-brand-600 text-white' : 'text-neutral-400 hover:text-white'
                }`}
              >
                <Layers size={16} />
                {t('menu.categories')}
              </button>
            </div>
            {view === 'items' && (
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setShowAIBuilder(true)}
                  className="px-4 py-3 border border-neutral-700 text-neutral-300 rounded-lg font-medium hover:bg-neutral-800 transition-colors flex items-center gap-2 min-h-[44px] text-sm"
                >
                  <Sparkles size={16} />
                  {t('admin:menu.aiBuilder')}
                </button>
                <button
                  onClick={() => setShowCSVImport(true)}
                  className="px-4 py-3 border border-neutral-700 text-neutral-300 rounded-lg font-medium hover:bg-neutral-800 transition-colors flex items-center gap-2 min-h-[44px] text-sm"
                >
                  <Upload size={16} />
                  {t('admin:menu.importCsv')}
                </button>
                <button
                  onClick={() => setShowTemplatePicker(true)}
                  className="px-4 py-3 border border-neutral-700 text-neutral-300 rounded-lg font-medium hover:bg-neutral-800 transition-colors flex items-center gap-2 min-h-[44px] text-sm"
                >
                  <FileSpreadsheet size={16} />
                  {t('admin:menu.useTemplate')}
                </button>
                {limits.menuItems !== Infinity && (
                  <span className="text-sm text-neutral-400">
                    {menuItems.filter(i => i.active).length} / {limits.menuItems} {t('admin:menu.items')}
                  </span>
                )}
                <button
                  onClick={openAddModal}
                  disabled={!selectedCategory || isAtLimit('menuItems', menuItems.filter(i => i.active).length)}
                  className="px-6 py-3 bg-brand-600 text-white rounded-lg font-medium hover:bg-brand-700 transition-colors flex items-center gap-2 min-h-[44px] disabled:opacity-50"
                >
                  <Plus size={20} />
                  {t('menu.addItem')}
                </button>
              </div>
            )}
            <BrandLogo className="h-10" />
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto p-6">
        {isAtLimit('menuItems', menuItems.filter(i => i.active).length) && (
          <div className="mb-6">
            <UpgradePrompt message={t('admin:menu.limitReached', { limit: limits.menuItems })} />
          </div>
        )}
        {error && (
          <div className="bg-brand-900/30 border border-brand-800 rounded-lg p-4 mb-6 flex justify-between items-center">
            <p className="text-brand-300">{error}</p>
            <button onClick={() => setError(null)} className="text-brand-400 hover:text-brand-300">
              <X size={20} />
            </button>
          </div>
        )}

        {loading ? (
          <div className="space-y-3">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="h-16 bg-neutral-900 rounded-lg border border-neutral-800 animate-pulse" />
            ))}
          </div>
        ) : view === 'categories' ? (
          <CategoryManagementView
            categories={categories}
            showCategoryForm={showCategoryForm}
            editingCategoryId={editingCategoryId}
            categoryFormData={categoryFormData}
            error={error}
            onShowCategoryForm={setShowCategoryForm}
            onEditingCategoryId={setEditingCategoryId}
            onCategoryFormData={setCategoryFormData}
            onCreateCategory={handleCreateCategory}
            onUpdateCategory={handleUpdateCategory}
            onToggleCategory={handleToggleCategory}
            onStartEditCategory={startEditCategory}
            onMoveCategoryOrder={handleMoveCategoryOrder}
          />
        ) : (
          <ItemsView
            categories={categories}
            selectedCategory={selectedCategory}
            itemSubTab={itemSubTab}
            liveItems={liveItems}
            preMenuItems={preMenuItems}
            onSelectCategory={setSelectedCategory}
            onSetItemSubTab={setItemSubTab}
            onOpenAddModal={openAddModal}
            onOpenEditModal={openEditModal}
            onToggleItem={handleToggleItem}
            onSwitchToCategories={() => setView('categories')}
            getCategoryName={getCategoryName}
          />
        )}
      </div>

      <ItemFormModal
        modalMode={modalMode}
        formData={formData}
        formErrors={formErrors}
        actionLoading={actionLoading}
        categories={categories}
        allModifierGroups={allModifierGroups}
        assignedGroupIds={assignedGroupIds}
        modifierLoading={modifierLoading}
        onFormData={setFormData}
        onAddItem={handleAddItem}
        onEditItem={handleEditItem}
        onToggleModifierGroup={handleToggleModifierGroup}
        onClose={closeModal}
      />

      <TemplatePickerModal
        isOpen={showTemplatePicker}
        onClose={() => setShowTemplatePicker(false)}
        onTemplateApplied={() => {
          fetchCategories();
          invalidateMenuCache();
        }}
      />

      <ImportMenuModal
        isOpen={showCSVImport}
        onClose={() => setShowCSVImport(false)}
        onImportComplete={() => {
          fetchCategories();
          invalidateMenuCache();
        }}
      />

      <AIMenuBuilderModal
        isOpen={showAIBuilder}
        onClose={() => setShowAIBuilder(false)}
        onMenuCreated={() => {
          fetchCategories();
          invalidateMenuCache();
        }}
      />
      <BackToSetupButton />
    </div>
  );
}
