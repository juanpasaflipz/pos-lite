import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import BrandLogo from '../BrandLogo';
import { MenuCategory } from '../../types';

interface CategorySidebarProps {
  categories: MenuCategory[];
  selectedCategory: number | 'all';
  onSelectCategory: (id: number | 'all') => void;
}

export default function CategorySidebar({
  categories,
  selectedCategory,
  onSelectCategory,
}: CategorySidebarProps) {
  const navigate = useNavigate();
  const { t } = useTranslation('pos');

  return (
    <div className="hidden lg:flex w-52 bg-neutral-900 border-r border-neutral-800 flex-col">
      <div className="bg-neutral-950 px-4 py-5 text-center border-b border-neutral-800">
        <BrandLogo className="h-8 mx-auto mb-1.5" />
        <p className="font-semibold text-xs text-neutral-500 uppercase tracking-widest">{t('header.categories')}</p>
      </div>

      <div className="flex-1 overflow-y-auto py-2 space-y-0.5">
        <button
          onClick={() => onSelectCategory('all')}
          className={`w-full py-4 px-5 text-base font-semibold transition-all touch-manipulation text-left ${
            selectedCategory === 'all'
              ? 'bg-brand-600/15 text-brand-400 border-l-4 border-brand-500'
              : 'bg-transparent text-neutral-300 border-l-4 border-transparent hover:bg-neutral-800/60 hover:text-white'
          }`}
        >
          {t('header.allItems')}
        </button>

        {categories.map((cat) => (
          <button
            key={cat.id}
            onClick={() => onSelectCategory(cat.id)}
            className={`w-full py-4 px-5 text-base font-semibold transition-all touch-manipulation text-left ${
              selectedCategory === cat.id
                ? 'bg-brand-600/15 text-brand-400 border-l-4 border-brand-500'
                : 'bg-transparent text-neutral-300 border-l-4 border-transparent hover:bg-neutral-800/60 hover:text-white'
            }`}
          >
            {cat.name}
          </button>
        ))}
      </div>

      <div className="border-t border-neutral-800 p-3.5 space-y-2">
        <button
          onClick={() => navigate('/admin')}
          className="w-full py-2.5 bg-neutral-800 text-neutral-300 text-sm font-bold rounded-lg hover:bg-neutral-700 transition-all border border-neutral-700"
        >
          {t('common:buttons.admin')}
        </button>
        <button
          onClick={() => navigate('/kitchen')}
          className="w-full py-2.5 bg-neutral-800 text-neutral-300 text-sm font-bold rounded-lg hover:bg-neutral-700 transition-all border border-neutral-700"
        >
          {t('common:buttons.kitchen')}
        </button>
      </div>
    </div>
  );
}
