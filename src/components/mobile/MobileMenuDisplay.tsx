import React, { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft } from 'lucide-react';
import { useBranding } from '../../context/BrandingContext';
import { getCachedCategories, getCachedMenuItems } from '../../lib/menuCache';
import { getCategoryIcon } from '../../lib/categoryIcons';
import { formatPrice } from '../../utils/currency';
import type { MenuCategory, MenuItem } from '../../types';

interface Props {
  onClose: () => void;
}

const MobileMenuDisplay: React.FC<Props> = ({ onClose }) => {
  const { t } = useTranslation('pos');
  const { branding } = useBranding();
  const [categories, setCategories] = useState<MenuCategory[]>([]);
  const [items, setItems] = useState<MenuItem[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<number | 'all'>('all');

  useEffect(() => {
    (async () => {
      try {
        const [cats, menuItems] = await Promise.all([
          getCachedCategories(),
          getCachedMenuItems(),
        ]);
        setCategories(cats);
        setItems(menuItems);
      } catch {
        // empty state
      }
    })();
  }, []);

  const filteredItems = useMemo(() => {
    if (selectedCategory === 'all') return items;
    return items.filter((item) => item.category_id === selectedCategory);
  }, [items, selectedCategory]);

  const categoryMap = useMemo(() => {
    const map: Record<number, string> = {};
    categories.forEach((c) => { map[c.id] = c.name; });
    return map;
  }, [categories]);

  return (
    <div className="fixed inset-0 z-50 bg-white flex flex-col">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-4 pt-3 pb-2">
        <div className="flex items-center justify-between">
          <div className="flex-1">
            <h1 className="text-xl font-bold text-gray-900">
              {branding?.restaurantName || 'Menu'}
            </h1>
            {branding?.tagline && (
              <p className="text-sm text-gray-500">{branding.tagline}</p>
            )}
          </div>
        </div>

        {/* Category pills */}
        <div className="flex gap-2 mt-3 overflow-x-auto scrollbar-hide">
          <button
            onClick={() => setSelectedCategory('all')}
            className={`shrink-0 px-3 py-1.5 rounded-full text-sm font-semibold transition-colors ${
              selectedCategory === 'all'
                ? 'bg-gray-900 text-white'
                : 'bg-gray-100 text-gray-600'
            }`}
          >
            {t('mobilePOS.allCategories')}
          </button>
          {categories.map((cat) => (
            <button
              key={cat.id}
              onClick={() => setSelectedCategory(cat.id)}
              className={`shrink-0 px-3 py-1.5 rounded-full text-sm font-semibold transition-colors ${
                selectedCategory === cat.id
                  ? 'bg-gray-900 text-white'
                  : 'bg-gray-100 text-gray-600'
              }`}
            >
              {getCategoryIcon(cat.name)} {cat.name}
            </button>
          ))}
        </div>
      </div>

      {/* Menu grid */}
      <div className="flex-1 overflow-y-auto p-3">
        <div className="grid grid-cols-2 gap-3">
          {filteredItems.map((item) => (
            <div
              key={item.id}
              className="bg-gray-50 rounded-2xl p-3 border border-gray-100"
            >
              {item.image_url && (
                <img
                  src={item.image_url}
                  alt={item.name}
                  className="w-full h-24 object-cover rounded-xl mb-2"
                />
              )}
              <div className="flex items-start gap-1.5">
                <span className="text-lg leading-none">
                  {categoryMap[item.category_id] ? getCategoryIcon(categoryMap[item.category_id]) : '🍽️'}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-gray-900 leading-tight">{item.name}</p>
                  {item.description && (
                    <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{item.description}</p>
                  )}
                </div>
              </div>
              <p className="text-sm font-bold text-gray-900 mt-1.5">{formatPrice(item.price)}</p>
            </div>
          ))}
        </div>
        {filteredItems.length === 0 && (
          <div className="flex items-center justify-center h-32">
            <p className="text-gray-400">{t('cart.noItemsFound')}</p>
          </div>
        )}
      </div>

      {/* Floating back button */}
      <div className="absolute bottom-6 left-1/2 -translate-x-1/2" style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}>
        <button
          onClick={onClose}
          className="flex items-center gap-2 px-5 py-3 bg-gray-900 text-white rounded-full shadow-lg font-semibold text-sm active:bg-gray-800 touch-manipulation"
        >
          <ArrowLeft className="w-4 h-4" />
          {t('mobilePOS.backToPOS')}
        </button>
      </div>
    </div>
  );
};

export default MobileMenuDisplay;
