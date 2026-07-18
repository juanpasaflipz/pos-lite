import React, { useCallback, useMemo, useState } from 'react';
import { Check, Plus, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useKioskCart } from '../context/KioskCartContext';
import { useKioskCustomer } from '../context/KioskCustomerContext';
import { useKioskSuggestions } from '../context/KioskSuggestionsContext';
import KioskModifierModal from './KioskModifierModal';
import type { KioskMenuItem, KioskModifier, SuggestionItem } from '../lib/kioskApi';

const money = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });
const MAX_CARDS = 6;

function suggestionToMenuItem(s: SuggestionItem): KioskMenuItem {
  return {
    id: s.menu_item_id,
    name: s.name,
    price: s.price,
    description: null,
    image_url: s.image_url,
    category_id: 0,
    active: true,
  };
}

/**
 * Compact horizontal upsell shown on the cart screen so customers see
 * complementary picks (drinks, sides, desserts) before committing to pay.
 * Filters out anything already in the cart and respects modifier groups by
 * opening the modifier modal when needed, same as the menu screen.
 */
const CartUpsellStrip: React.FC = () => {
  const { t } = useTranslation();
  const { lines, addItem } = useKioskCart();
  const { session } = useKioskCustomer();
  const { anonPopular, modifierMap } = useKioskSuggestions();
  const [modifierItem, setModifierItem] = useState<KioskMenuItem | null>(null);
  const [flashId, setFlashId] = useState<number | null>(null);

  const pulse = useCallback((menuItemId: number) => {
    setFlashId(menuItemId);
    window.setTimeout(() => setFlashId((c) => (c === menuItemId ? null : c)), 900);
  }, []);

  const candidates = useMemo<SuggestionItem[]>(() => {
    const inCart = new Set(lines.map((l) => l.menu_item_id));
    const pool: SuggestionItem[] = [];
    if (session) {
      pool.push(...session.suggestions.for_you);
      pool.push(...session.suggestions.popular);
      if (session.suggestions.house) pool.push(session.suggestions.house);
    } else {
      pool.push(...anonPopular);
    }
    const seen = new Set<number>();
    const out: SuggestionItem[] = [];
    for (const s of pool) {
      if (inCart.has(s.menu_item_id)) continue;
      if (seen.has(s.menu_item_id)) continue;
      seen.add(s.menu_item_id);
      out.push(s);
      if (out.length >= MAX_CARDS) break;
    }
    return out;
  }, [lines, session, anonPopular]);

  const handleTap = (s: SuggestionItem) => {
    const item = suggestionToMenuItem(s);
    const groups = modifierMap[item.id];
    if (groups && groups.length) {
      setModifierItem(item);
    } else {
      addItem(item);
      pulse(item.id);
    }
  };

  const confirmModifierAdd = (modifiers: KioskModifier[]) => {
    if (!modifierItem) return;
    addItem(modifierItem, modifiers);
    pulse(modifierItem.id);
    setModifierItem(null);
  };

  if (candidates.length === 0) return null;

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2 px-1">
        <Sparkles className="h-5 w-5 text-brand-300" />
        <h2 className="text-xl font-black">{t('upsell.anythingElse')}</h2>
      </div>
      <div className="flex gap-3 overflow-x-auto pb-2 -mx-1 px-1">
        {candidates.map((s) => {
          const added = flashId === s.menu_item_id;
          return (
            <button
              key={s.menu_item_id}
              onClick={() => handleTap(s)}
              className="relative w-[180px] shrink-0 rounded-lg bg-neutral-900 border border-neutral-800 active:border-brand-500 text-left touch-manipulation flex flex-col overflow-hidden"
            >
              <div className="h-24 w-full bg-gradient-to-br from-brand-600 to-brand-900 flex items-center justify-center overflow-hidden">
                {s.image_url ? (
                  <img src={s.image_url} alt={s.name} className="h-full w-full object-cover" />
                ) : (
                  <span className="text-3xl font-black text-white/80">
                    {s.name.trim().charAt(0).toUpperCase() || '·'}
                  </span>
                )}
              </div>
              <div className="p-3 flex flex-col flex-1 gap-1">
                <p className="text-base font-black leading-tight line-clamp-2">{s.name}</p>
                <div className="mt-auto flex items-center justify-between pt-1">
                  <span className="text-base font-black text-brand-300">
                    {money.format(Number(s.price))}
                  </span>
                  <span className="h-8 w-8 rounded-md bg-brand-600 text-white flex items-center justify-center">
                    <Plus className="h-5 w-5" />
                  </span>
                </div>
              </div>
              {added && (
                <div className="absolute inset-0 bg-cockpit-green/90 flex items-center justify-center gap-1 text-base font-black">
                  <Check className="h-6 w-6" />
                  {t('suggestions.added')}
                </div>
              )}
            </button>
          );
        })}
      </div>

      {modifierItem && (
        <KioskModifierModal
          item={modifierItem}
          groups={modifierMap[modifierItem.id] || []}
          onCancel={() => setModifierItem(null)}
          onConfirm={confirmModifierAdd}
        />
      )}
    </section>
  );
};

export default CartUpsellStrip;
