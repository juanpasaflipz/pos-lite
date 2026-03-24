import React from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Edit2, AlertCircle, Layers } from 'lucide-react';
import { MenuCategory, MenuItem } from '../../types';
import { formatPrice } from '../../utils/currency';

type ItemSubTab = 'live' | 'pre-menu';

interface ItemsViewProps {
  categories: MenuCategory[];
  selectedCategory: number | null;
  itemSubTab: ItemSubTab;
  liveItems: MenuItem[];
  preMenuItems: MenuItem[];
  onSelectCategory: (id: number) => void;
  onSetItemSubTab: (tab: ItemSubTab) => void;
  onOpenAddModal: () => void;
  onOpenEditModal: (item: MenuItem) => void;
  onToggleItem: (id: number) => void;
  onSwitchToCategories: () => void;
  getCategoryName: (id: number | null) => string;
}

export default function ItemsView({
  categories,
  selectedCategory,
  itemSubTab,
  liveItems,
  preMenuItems,
  onSelectCategory,
  onSetItemSubTab,
  onOpenAddModal,
  onOpenEditModal,
  onToggleItem,
  onSwitchToCategories,
  getCategoryName,
}: ItemsViewProps) {
  const { t } = useTranslation('inventory');
  const displayedItems = itemSubTab === 'live' ? liveItems : preMenuItems;

  if (categories.length === 0) {
    return (
      <div className="bg-neutral-900 rounded-lg border border-neutral-800 p-12 text-center">
        <AlertCircle className="mx-auto text-neutral-600 mb-3" size={40} />
        <p className="text-neutral-400 mb-4">{t('menu.noCategories')}</p>
        <button
          onClick={onSwitchToCategories}
          className="px-6 py-3 bg-brand-600 text-white rounded-lg font-medium hover:bg-brand-700 transition-colors inline-flex items-center gap-2"
        >
          <Layers size={20} />
          {t('menu.manageCategories')}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
        <h3 className="text-lg font-semibold text-white mb-4">{t('menu.categories')}</h3>
        <div className="flex gap-3 flex-wrap">
          {categories.filter(c => c.active).map((category) => (
            <button
              key={category.id}
              onClick={() => onSelectCategory(category.id)}
              className={`px-6 py-3 rounded-lg font-medium transition-colors min-h-[44px] ${
                selectedCategory === category.id
                  ? 'bg-brand-600 text-white'
                  : 'bg-neutral-800 text-neutral-300 border border-neutral-700 hover:bg-neutral-700'
              }`}
            >
              {category.name}
            </button>
          ))}
        </div>
      </div>

      {/* Live Menu / Pre-Menu sub-tabs */}
      <div className="flex gap-2">
        <button
          onClick={() => onSetItemSubTab('live')}
          className={`px-5 py-2.5 rounded-lg font-medium text-sm transition-colors ${
            itemSubTab === 'live'
              ? 'bg-green-600 text-white'
              : 'bg-neutral-800 text-neutral-400 border border-neutral-700 hover:text-white'
          }`}
        >
          {t('menu.liveMenu')} ({liveItems.length})
        </button>
        <button
          onClick={() => onSetItemSubTab('pre-menu')}
          className={`px-5 py-2.5 rounded-lg font-medium text-sm transition-colors ${
            itemSubTab === 'pre-menu'
              ? 'bg-amber-600 text-white'
              : 'bg-neutral-800 text-neutral-400 border border-neutral-700 hover:text-white'
          }`}
        >
          {t('menu.preMenu')} ({preMenuItems.length})
        </button>
      </div>

      {displayedItems.length === 0 ? (
        <div className="bg-neutral-900 rounded-lg border border-neutral-800 p-12 text-center">
          <AlertCircle className="mx-auto text-neutral-600 mb-3" size={40} />
          {itemSubTab === 'live' ? (
            <>
              <p className="text-neutral-400 mb-6">
                {t('menu.noItemsIn')} {getCategoryName(selectedCategory)}
              </p>
              <button
                onClick={onOpenAddModal}
                className="px-6 py-3 bg-brand-600 text-white rounded-lg font-medium hover:bg-brand-700 transition-colors inline-flex items-center gap-2 min-h-[44px]"
              >
                <Plus size={20} />
                {t('menu.addFirstItem')}
              </button>
            </>
          ) : (
            <p className="text-neutral-400">{t('menu.noPreMenuItems')}</p>
          )}
        </div>
      ) : (
        <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
          <h3 className="text-lg font-semibold text-white mb-4">
            {getCategoryName(selectedCategory)}
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {displayedItems.map((item) => (
              <div
                key={item.id}
                className={`p-5 rounded-lg border transition-all ${
                  item.active
                    ? 'border-neutral-700 bg-neutral-800'
                    : 'border-neutral-800 bg-neutral-900 opacity-60'
                }`}
              >
                {item.image_url && (
                  <div className="rounded-lg overflow-hidden h-28 bg-neutral-700 mb-3 -mx-5 -mt-5">
                    <img src={item.image_url} alt={item.name} className="w-full h-full object-cover" />
                  </div>
                )}
                <div>
                  <h4 className="font-bold text-white text-lg">
                    {item.name}
                  </h4>
                  <p className="text-2xl font-bold text-brand-500">
                    {formatPrice(item.price)}
                  </p>
                  {item.description && (
                    <p className="text-sm text-neutral-400 mt-1">
                      {item.description}
                    </p>
                  )}
                </div>

                <div className="flex gap-2 pt-4 border-t border-neutral-700">
                  <button
                    onClick={() => onOpenEditModal(item)}
                    className="flex-1 px-4 py-2 text-neutral-300 bg-neutral-700 rounded-lg hover:bg-neutral-600 transition-colors font-medium flex items-center justify-center gap-2 min-h-[44px]"
                  >
                    <Edit2 size={18} />
                    {t('common:buttons.edit')}
                  </button>
                  <button
                    onClick={() => onToggleItem(item.id)}
                    className={`flex-1 px-4 py-2 rounded-lg transition-colors font-medium min-h-[44px] ${
                      item.active
                        ? 'bg-brand-600/20 text-brand-400 hover:bg-brand-600/30 border border-brand-800'
                        : 'bg-green-600/20 text-green-400 hover:bg-green-600/30 border border-green-800'
                    }`}
                  >
                    {item.active ? t('menu.deactivate') : t('menu.activate')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
