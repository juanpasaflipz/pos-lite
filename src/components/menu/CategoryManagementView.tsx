import React from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Edit2, X, Check, ChevronUp, ChevronDown } from 'lucide-react';
import { MenuCategory } from '../../types';

interface CategoryFormData {
  name: string;
  sort_order: string;
}

interface CategoryManagementViewProps {
  categories: MenuCategory[];
  showCategoryForm: boolean;
  editingCategoryId: number | null;
  categoryFormData: CategoryFormData;
  error: string | null;
  onShowCategoryForm: (show: boolean) => void;
  onEditingCategoryId: (id: number | null) => void;
  onCategoryFormData: (data: CategoryFormData) => void;
  onCreateCategory: () => void;
  onUpdateCategory: () => void;
  onToggleCategory: (id: number) => void;
  onStartEditCategory: (cat: MenuCategory) => void;
  onMoveCategoryOrder: (cat: MenuCategory, direction: 'up' | 'down') => void;
}

export default function CategoryManagementView({
  categories,
  showCategoryForm,
  editingCategoryId,
  categoryFormData,
  onShowCategoryForm,
  onEditingCategoryId,
  onCategoryFormData,
  onCreateCategory,
  onUpdateCategory,
  onToggleCategory,
  onStartEditCategory,
  onMoveCategoryOrder,
}: CategoryManagementViewProps) {
  const { t } = useTranslation('inventory');

  return (
    <div className="space-y-6">
      <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-white">{t('menu.manageCategories')}</h3>
          <button
            onClick={() => { onShowCategoryForm(true); onEditingCategoryId(null); onCategoryFormData({ name: '', sort_order: '' }); }}
            className="flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-lg font-medium hover:bg-brand-700 transition-colors"
          >
            <Plus size={18} /> {t('menu.addCategory')}
          </button>
        </div>

        {showCategoryForm && !editingCategoryId && (
          <div className="bg-neutral-800 p-4 rounded-lg mb-4 space-y-3">
            <div className="flex gap-3">
              <input
                value={categoryFormData.name}
                onChange={(e) => onCategoryFormData({ ...categoryFormData, name: e.target.value })}
                placeholder={t('menu.categoryForm.namePlaceholder')}
                className="flex-1 bg-neutral-700 border border-neutral-600 rounded-lg p-3 text-white focus:outline-none focus:border-brand-600"
              />
              <input
                type="number"
                value={categoryFormData.sort_order}
                onChange={(e) => onCategoryFormData({ ...categoryFormData, sort_order: e.target.value })}
                placeholder={t('menu.categoryForm.order')}
                className="w-24 bg-neutral-700 border border-neutral-600 rounded-lg p-3 text-white focus:outline-none focus:border-brand-600"
              />
            </div>
            <div className="flex gap-2">
              <button onClick={onCreateCategory} className="px-4 py-2 bg-green-600 text-white rounded-lg font-medium hover:bg-green-700">
                <Check size={18} className="inline mr-1" /> {t('common:buttons.create')}
              </button>
              <button onClick={() => onShowCategoryForm(false)} className="px-4 py-2 bg-neutral-700 text-white rounded-lg font-medium hover:bg-neutral-600">
                {t('common:buttons.cancel')}
              </button>
            </div>
          </div>
        )}

        <div className="space-y-2">
          {categories.map((cat, index) => (
            <div key={cat.id} className={`p-4 rounded-lg border transition-all ${
              cat.active ? 'border-neutral-700 bg-neutral-800' : 'border-neutral-800 bg-neutral-900 opacity-60'
            }`}>
              {editingCategoryId === cat.id ? (
                <div className="flex gap-3 items-center">
                  <input
                    value={categoryFormData.name}
                    onChange={(e) => onCategoryFormData({ ...categoryFormData, name: e.target.value })}
                    className="flex-1 bg-neutral-700 border border-neutral-600 rounded-lg p-2 text-white focus:outline-none focus:border-brand-600"
                  />
                  <input
                    type="number"
                    value={categoryFormData.sort_order}
                    onChange={(e) => onCategoryFormData({ ...categoryFormData, sort_order: e.target.value })}
                    placeholder={t('menu.categoryForm.order')}
                    className="w-20 bg-neutral-700 border border-neutral-600 rounded-lg p-2 text-white focus:outline-none focus:border-brand-600"
                  />
                  <button onClick={onUpdateCategory} className="p-2 bg-green-600 text-white rounded-lg hover:bg-green-700">
                    <Check size={18} />
                  </button>
                  <button onClick={() => onEditingCategoryId(null)} className="p-2 bg-neutral-700 text-white rounded-lg hover:bg-neutral-600">
                    <X size={18} />
                  </button>
                </div>
              ) : (
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="text-neutral-500 text-sm font-mono w-8">{cat.sort_order}</span>
                    <span className="text-white font-bold text-lg">{cat.name}</span>
                    {!cat.active && <span className="text-xs text-neutral-500 bg-neutral-700 px-2 py-0.5 rounded">{t('menu.inactive')}</span>}
                  </div>
                  <div className="flex items-center gap-2">
                    <button onClick={() => onMoveCategoryOrder(cat, 'up')} disabled={index === 0} className="p-1.5 text-neutral-500 hover:text-white disabled:opacity-30">
                      <ChevronUp size={18} />
                    </button>
                    <button onClick={() => onMoveCategoryOrder(cat, 'down')} disabled={index === categories.length - 1} className="p-1.5 text-neutral-500 hover:text-white disabled:opacity-30">
                      <ChevronDown size={18} />
                    </button>
                    <button onClick={() => onStartEditCategory(cat)} className="p-2 text-neutral-400 hover:text-white hover:bg-neutral-700 rounded-lg">
                      <Edit2 size={18} />
                    </button>
                    <button
                      onClick={() => onToggleCategory(cat.id)}
                      className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                        cat.active
                          ? 'bg-green-900/30 text-green-400 hover:bg-green-900/50'
                          : 'bg-neutral-700 text-neutral-400 hover:bg-neutral-600'
                      }`}
                    >
                      {cat.active ? t('menu.active') : t('menu.inactive')}
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
          {categories.length === 0 && (
            <div className="text-center py-8">
              <p className="text-neutral-400">{t('menu.noCategoriesYet')}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
