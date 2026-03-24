import React from 'react';
import { useTranslation } from 'react-i18next';
import type { MenuCategory } from '../../types';

interface Props {
  categories: MenuCategory[];
  selected: number | 'all';
  onSelect: (id: number | 'all') => void;
}

const MobileCategoryTabs: React.FC<Props> = ({ categories, selected, onSelect }) => {
  const { t } = useTranslation('pos');

  return (
    <div className="flex gap-2 px-3 py-2 overflow-x-auto scrollbar-hide touch-manipulation">
      <button
        onClick={() => onSelect('all')}
        className={`shrink-0 px-4 py-2 rounded-full text-sm font-semibold transition-colors ${
          selected === 'all'
            ? 'bg-brand-600 text-white'
            : 'bg-neutral-800 text-neutral-400'
        }`}
      >
        {t('mobilePOS.allCategories')}
      </button>
      {categories.map((cat) => (
        <button
          key={cat.id}
          onClick={() => onSelect(cat.id)}
          className={`shrink-0 px-4 py-2 rounded-full text-sm font-semibold transition-colors ${
            selected === cat.id
              ? 'bg-brand-600 text-white'
              : 'bg-neutral-800 text-neutral-400'
          }`}
        >
          {cat.name}
        </button>
      ))}
    </div>
  );
};

export default React.memo(MobileCategoryTabs);
