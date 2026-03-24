import React, { useCallback, useRef } from 'react';
import type { MenuItem } from '../../types';
import { formatPrice } from '../../utils/currency';
import { tapFeedback } from '../../lib/haptics';

interface Props {
  items: MenuItem[];
  itemModifierCache: Record<number, boolean>;
  onItemTap: (item: MenuItem) => void;
  onItemLongPress: (item: MenuItem) => void;
}

const LONG_PRESS_MS = 500;

const MenuCard: React.FC<{
  item: MenuItem;
  hasModifiers: boolean;
  onTap: (item: MenuItem) => void;
  onLongPress: (item: MenuItem) => void;
}> = React.memo(({ item, hasModifiers, onTap, onLongPress }) => {
  const timerRef = useRef<ReturnType<typeof setTimeout>>();
  const didLongPress = useRef(false);

  const handleTouchStart = useCallback(() => {
    didLongPress.current = false;
    timerRef.current = setTimeout(() => {
      didLongPress.current = true;
      onLongPress(item);
      tapFeedback();
    }, LONG_PRESS_MS);
  }, [item, onLongPress]);

  const handleTouchEnd = useCallback(() => {
    clearTimeout(timerRef.current);
    if (!didLongPress.current) {
      onTap(item);
      tapFeedback();
    }
  }, [item, onTap]);

  const handleTouchCancel = useCallback(() => {
    clearTimeout(timerRef.current);
  }, []);

  return (
    <div
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchCancel}
      onClick={(e) => e.preventDefault()}
      className="bg-neutral-800 rounded-xl p-3 flex flex-col justify-between min-h-[88px] active:scale-95 transition-transform touch-manipulation select-none"
    >
      {item.image_url && (
        <img
          src={item.image_url}
          alt={item.name}
          loading="lazy"
          className="w-full h-20 object-cover rounded-lg mb-2"
        />
      )}
      <div className="flex-1">
        <p className="text-sm font-semibold text-white leading-tight line-clamp-2">{item.name}</p>
      </div>
      <div className="flex items-center justify-between mt-1">
        <span className="text-brand-400 font-bold text-sm">{formatPrice(item.price)}</span>
        {hasModifiers && (
          <span className="w-2 h-2 rounded-full bg-brand-500" />
        )}
      </div>
    </div>
  );
});

MenuCard.displayName = 'MenuCard';

const MobileMenuGrid: React.FC<Props> = ({ items, itemModifierCache, onItemTap, onItemLongPress }) => {
  return (
    <div className="grid grid-cols-2 gap-2 px-3 pb-4">
      {items.map((item) => (
        <MenuCard
          key={item.id}
          item={item}
          hasModifiers={!!itemModifierCache[item.id]}
          onTap={onItemTap}
          onLongPress={onItemLongPress}
        />
      ))}
    </div>
  );
};

export default React.memo(MobileMenuGrid);
