import React from 'react';
import { useTranslation } from 'react-i18next';
import { SlidersHorizontal, Star } from 'lucide-react';
import { MenuItem } from '../../types';
import { formatPrice } from '../../utils/currency';
import MenuItemImage from '../MenuItemImage';

interface MenuGridProps {
  filteredItems: MenuItem[];
  filteredPopularItems: MenuItem[];
  brandItemMap: Map<number, { custom_name: string | null; custom_price: number | null }> | null;
  itemModifierCache: Record<number, boolean>;
  soldOutItemIds: Set<number>;
  pushItemIds: Set<number>;
  avoidItemIds: Set<number>;
  lowStockItemIds: Set<number>;
  searchQuery: string;
  onItemTap: (item: MenuItem) => void;
  onAddToast: (message: string, type: 'success' | 'error' | 'info') => void;
}

export default function MenuGrid({
  filteredItems,
  filteredPopularItems,
  brandItemMap,
  itemModifierCache,
  soldOutItemIds,
  pushItemIds,
  avoidItemIds,
  lowStockItemIds,
  searchQuery,
  onItemTap,
  onAddToast,
}: MenuGridProps) {
  const { t } = useTranslation('pos');

  return (
    <div className="flex-1 overflow-y-auto p-5 lg:p-6">
      {/* Favorites / Popular Items Row */}
      {!searchQuery && filteredPopularItems.length > 0 && (
        <div className="mb-6 pb-6 border-b border-neutral-800/60">
          <div className="flex items-center gap-2 mb-3.5">
            <Star className="w-4 h-4 text-amber-400 fill-amber-400" />
            <p className="text-sm font-semibold text-amber-400 uppercase tracking-wider">{t('favorites.title')}</p>
          </div>
          <div className="flex gap-3.5 overflow-x-auto pb-3 scrollbar-hide">
            {filteredPopularItems.map((item) => {
              const isSoldOut = soldOutItemIds.has(item.id);
              return (
                <button
                  key={`pop-${item.id}`}
                  onClick={() => !isSoldOut && onItemTap(item)}
                  disabled={isSoldOut}
                  className={`flex-shrink-0 w-40 rounded-xl p-4 transition-all touch-manipulation border ${
                    isSoldOut
                      ? 'bg-neutral-900/40 border-neutral-700 opacity-50 cursor-not-allowed'
                      : 'bg-neutral-900 border-amber-600/50 hover:border-amber-500 active:scale-95'
                  }`}
                >
                  <p className="font-bold text-white text-sm line-clamp-2 leading-snug">{brandItemMap?.get(item.id)?.custom_name || item.name}</p>
                  <p className="font-bold text-amber-400 text-base mt-2">{formatPrice(brandItemMap?.get(item.id)?.custom_price ?? item.price)}</p>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-3 gap-5 lg:gap-6 items-start">
        {filteredItems.map((item) => {
          const isPush = pushItemIds.has(item.id);
          const isAvoid = avoidItemIds.has(item.id);
          const isSoldOut = soldOutItemIds.has(item.id);
          const isLowStock = lowStockItemIds.has(item.id);
          const hasModifiers = !!itemModifierCache[item.id];
          return (
            <button
              key={item.id}
              onClick={() => {
                onItemTap(item);
                if (isAvoid && !isSoldOut) {
                  onAddToast(t('cart.lowStockWarning', { name: item.name }), 'info');
                }
              }}
              disabled={isSoldOut}
              className={`rounded-xl hover:shadow-lg active:scale-[0.97] transition-all touch-manipulation flex flex-col overflow-hidden relative ${
                isSoldOut
                  ? 'bg-neutral-900/40 border border-neutral-700 grayscale cursor-not-allowed'
                  : isLowStock
                    ? 'bg-neutral-900 border-2 border-yellow-500'
                    : isPush
                      ? 'bg-neutral-900 border-2 border-green-600 ring-1 ring-green-600/30'
                      : isAvoid
                        ? 'bg-neutral-900/60 border border-neutral-700 opacity-60'
                        : 'bg-neutral-900 border border-neutral-700 hover:border-brand-600'
              }`}
            >
              {/* Image or placeholder */}
              <div className="h-28 lg:h-32 w-full bg-neutral-800 flex items-center justify-center overflow-hidden flex-shrink-0">
                <MenuItemImage src={item.image_url} alt={item.name} />
              </div>

              {/* Sold out overlay */}
              {isSoldOut && (
                <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                  <span className="bg-brand-600 text-white text-xs font-bold px-3 py-1 rounded-full uppercase">
                    {t('soldOut')}
                  </span>
                </div>
              )}

              {/* Content */}
              <div className="px-3.5 py-3.5">
                <div className="flex items-start justify-between">
                  <p className="font-semibold text-white text-sm lg:text-base leading-snug line-clamp-2 flex-1 text-left">{brandItemMap?.get(item.id)?.custom_name || item.name}</p>
                  <div className="flex items-center gap-1.5 ml-2 flex-shrink-0 mt-0.5">
                    {hasModifiers && <SlidersHorizontal className="w-3.5 h-3.5 text-neutral-500" />}
                    {isPush && <span className="w-2.5 h-2.5 bg-green-500 rounded-full" />}
                  </div>
                </div>
                {item.description && (
                  <p className="text-xs text-neutral-400 mt-0.5 line-clamp-2 leading-snug text-left">{item.description}</p>
                )}
                <p className={`font-bold text-lg mt-1 ${
                  isSoldOut ? 'text-neutral-600' : isAvoid ? 'text-neutral-500' : 'text-brand-500'
                }`}>
                  {formatPrice(brandItemMap?.get(item.id)?.custom_price ?? item.price)}
                </p>
              </div>
            </button>
          );
        })}
      </div>
      {filteredItems.length === 0 && (
        <div className="flex items-center justify-center h-full">
          <p className="text-neutral-500 text-lg">{t('cart.noItemsFound')}</p>
        </div>
      )}
    </div>
  );
}
