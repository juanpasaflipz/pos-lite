import React from 'react';
import { useTranslation } from 'react-i18next';
import { MenuCategory } from '../types';

interface CategoryBarProps {
  categories: MenuCategory[];
  selectedCategory: number | 'all';
  onSelectCategory: (id: number | 'all') => void;
}

const CategoryBar: React.FC<CategoryBarProps> = ({ categories, selectedCategory, onSelectCategory }) => {
  const { t } = useTranslation('pos');

  return (
    <div className="flex overflow-x-auto gap-2 py-2 px-4 bg-neutral-900 border-b border-neutral-800" style={{ scrollbarWidth: 'none', msOverflowStyle: 'none', WebkitOverflowScrolling: 'touch' }}>
      <button
        onClick={() => onSelectCategory('all')}
        className={`px-4 py-2 rounded-full text-sm font-semibold whitespace-nowrap flex-shrink-0 transition-all touch-manipulation ${
          selectedCategory === 'all'
            ? 'bg-brand-600 text-white'
            : 'bg-neutral-800 text-neutral-300 active:bg-neutral-700'
        }`}
      >
        {t('header.allItems')}
      </button>
      {categories.map((cat) => (
        <button
          key={cat.id}
          onClick={() => onSelectCategory(cat.id)}
          className={`px-4 py-2 rounded-full text-sm font-semibold whitespace-nowrap flex-shrink-0 transition-all touch-manipulation ${
            selectedCategory === cat.id
              ? 'bg-brand-600 text-white'
              : 'bg-neutral-800 text-neutral-300 active:bg-neutral-700'
          }`}
        >
          {cat.name}
        </button>
      ))}
    </div>
  );
};

export default CategoryBar;
