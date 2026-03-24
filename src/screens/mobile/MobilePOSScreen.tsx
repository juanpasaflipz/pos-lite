import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Zap, ZapOff } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useMobileCart } from '../../context/MobileCartContext';
import { useNetworkStatus } from '../../hooks/useNetworkStatus';
import {
  getCachedCategories,
  getCachedMenuItems,
  getCachedItemsWithModifiers,
} from '../../lib/menuCache';
import { createOrder } from '../../api';
import { createOfflineOrder } from '../../lib/offlineOrderQueue';
import { tapFeedback, successFeedback, errorFeedback } from '../../lib/haptics';
import { formatPrice } from '../../utils/currency';
import type { MenuCategory, MenuItem } from '../../types';

import MobileCategoryTabs from '../../components/mobile/MobileCategoryTabs';
import MobileMenuGrid from '../../components/mobile/MobileMenuGrid';
import MobileCartBar from '../../components/mobile/MobileCartBar';
import MobileItemDetail from '../../components/mobile/MobileItemDetail';

const MobilePOSScreen: React.FC = () => {
  const { currentEmployee } = useAuth();
  const { t } = useTranslation('pos');
  const { isOnline } = useNetworkStatus();
  const cart = useMobileCart();

  const [categories, setCategories] = useState<MenuCategory[]>([]);
  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
  const [itemModifierCache, setItemModifierCache] = useState<Record<number, boolean>>({});
  const [selectedCategory, setSelectedCategory] = useState<number | 'all'>('all');
  const [loading, setLoading] = useState(true);
  const [detailItem, setDetailItem] = useState<MenuItem | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Load menu data
  useEffect(() => {
    (async () => {
      try {
        const [cats, items, modItems] = await Promise.all([
          getCachedCategories(),
          getCachedMenuItems(),
          getCachedItemsWithModifiers().catch(() => ({ itemIds: [] })),
        ]);
        setCategories(cats);
        setMenuItems(items);
        const cache: Record<number, boolean> = {};
        for (const id of modItems.itemIds) cache[id] = true;
        setItemModifierCache(cache);
      } catch {
        // will show empty state
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const filteredItems = useMemo(() => {
    if (selectedCategory === 'all') return menuItems;
    return menuItems.filter((item) => item.category_id === selectedCategory);
  }, [menuItems, selectedCategory]);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2000);
  }, []);

  // Tap logic: quickMode on → always addItem; quickMode off + has modifiers → detail
  const handleItemTap = useCallback((item: MenuItem) => {
    tapFeedback();
    if (cart.quickMode) {
      cart.addItem(item);
    } else if (itemModifierCache[item.id]) {
      setDetailItem(item);
    } else {
      cart.addItem(item);
    }
  }, [cart, itemModifierCache]);

  // Long press always opens detail
  const handleItemLongPress = useCallback((item: MenuItem) => {
    setDetailItem(item);
  }, []);

  // Quick Mode: send to kitchen
  const handleSendToKitchen = useCallback(async () => {
    if (cart.items.length === 0) return;
    try {
      if (isOnline) {
        const orderItems = cart.items.map((ci) => ({
          menu_item_id: ci.menu_item_id,
          quantity: ci.quantity,
          notes: ci.notes,
          modifiers: ci.selectedModifierIds || [],
          combo_instance_id: null,
          virtual_brand_id: null,
        }));
        await createOrder({ employee_id: currentEmployee!.id, items: orderItems });
      } else {
        await createOfflineOrder(currentEmployee!.id, currentEmployee!.name, cart.items, 0, 0);
      }
      successFeedback();
      cart.clearCart();
      showToast(isOnline ? t('mobilePOS.orderSentToKitchen') : t('mobilePOS.offlineOrderSaved'));
    } catch (err) {
      errorFeedback();
      showToast(err instanceof Error ? err.message : t('toast.orderCreateFailed'));
    }
  }, [cart, currentEmployee, isOnline, showToast, t]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-brand-500 font-semibold animate-pulse">{t('actions.loadingMenu')}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-3 pb-1">
        <h1 className="text-lg font-bold text-white">{t('mobilePOS.title')}</h1>
        <button
          onClick={() => { tapFeedback(); cart.toggleQuickMode(); }}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold transition-colors touch-manipulation ${
            cart.quickMode
              ? 'bg-green-600/20 text-green-400 border border-green-600/40'
              : 'bg-neutral-800 text-neutral-400 border border-neutral-700'
          }`}
        >
          {cart.quickMode ? <Zap className="w-3.5 h-3.5" /> : <ZapOff className="w-3.5 h-3.5" />}
          {t('mobilePOS.quickMode')}
        </button>
      </div>

      {/* Offline indicator */}
      {!isOnline && (
        <div className="mx-3 mb-1 py-1.5 px-3 bg-amber-600/20 border border-amber-600/40 rounded-xl text-center">
          <p className="text-amber-400 text-xs font-semibold">{t('offline.indicator')}</p>
        </div>
      )}

      {/* Category tabs */}
      <MobileCategoryTabs
        categories={categories}
        selected={selectedCategory}
        onSelect={setSelectedCategory}
      />

      {/* Menu grid */}
      <div className="flex-1 overflow-y-auto">
        {filteredItems.length === 0 ? (
          <div className="flex items-center justify-center h-32">
            <p className="text-neutral-500">{t('cart.noItemsFound')}</p>
          </div>
        ) : (
          <MobileMenuGrid
            items={filteredItems}
            itemModifierCache={itemModifierCache}
            onItemTap={handleItemTap}
            onItemLongPress={handleItemLongPress}
          />
        )}
      </div>

      {/* Cart bar */}
      <MobileCartBar onSendToKitchen={handleSendToKitchen} />

      {/* Item detail bottom sheet */}
      {detailItem && (
        <MobileItemDetail
          item={detailItem}
          onAdd={cart.addItemWithModifiers}
          onClose={() => setDetailItem(null)}
        />
      )}

      {/* Toast */}
      {toast && (
        <div className="fixed top-16 left-4 right-4 z-50 bg-neutral-800 text-white text-sm font-semibold py-3 px-4 rounded-2xl text-center shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
};

export default MobilePOSScreen;
