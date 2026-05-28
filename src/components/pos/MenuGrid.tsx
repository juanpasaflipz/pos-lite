import React from 'react';
import { useTranslation } from 'react-i18next';
import { SlidersHorizontal } from 'lucide-react';
import { MenuItem } from '../../types';
import { formatPrice } from '../../utils/currency';
import MenuItemImage from '../MenuItemImage';

interface MenuGridProps {
  filteredItems: MenuItem[];
  brandItemMap: Map<number, { custom_name: string | null; custom_price: number | null }> | null;
  itemModifierCache: Record<number, boolean>;
  soldOutItemIds: Set<number>;
  pushItemIds: Set<number>;
  avoidItemIds: Set<number>;
  lowStockItemIds: Set<number>;
  onItemTap: (item: MenuItem) => void;
  onAddToast: (message: string, type: 'success' | 'error' | 'info') => void;
}

export default function MenuGrid({
  filteredItems,
  brandItemMap,
  itemModifierCache,
  soldOutItemIds,
  pushItemIds,
  avoidItemIds,
  lowStockItemIds,
  onItemTap,
  onAddToast,
}: MenuGridProps) {
  const { t } = useTranslation('pos');

  return (
    <div className="flex-1 overflow-y-auto p-5 lg:p-6">
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
                    ? 'bg-neutral-900 border-2 border-cockpit-yellow'
                    : isPush
                      ? 'bg-neutral-900 border-2 border-cockpit-green ring-1 ring-cockpit-green/30'
                      : isAvoid
                        ? 'bg-neutral-900/60 border border-neutral-700 opacity-60'
                        : 'bg-neutral-900 border border-neutral-700 hover:border-brand-600'
              }`}
            >
              {/* Image or placeholder */}
              <div className="h-28 lg:h-32 w-full bg-neutral-800 flex items-center justify-center overflow-hidden flex-shrink-0">
                <MenuItemImage
                  src={item.image_url}
                  alt={item.name}
                  seed={item.id}
                  category={item.name}
                />
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
                    {isPush && <span className="w-2.5 h-2.5 bg-cockpit-green rounded-full" />}
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
