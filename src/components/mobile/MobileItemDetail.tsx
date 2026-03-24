import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Minus, Plus } from 'lucide-react';
import { getModifierGroupsForItem } from '../../api';
import type { MenuItem, ModifierGroup } from '../../types';
import { formatPrice } from '../../utils/currency';
import { tapFeedback } from '../../lib/haptics';

interface Props {
  item: MenuItem;
  onAdd: (
    item: MenuItem,
    modifierIds: number[],
    modifierNames: string[],
    modifierPriceTotal: number,
    notes?: string,
    quantity?: number,
  ) => void;
  onClose: () => void;
}

const MobileItemDetail: React.FC<Props> = ({ item, onAdd, onClose }) => {
  const { t } = useTranslation('pos');
  const [groups, setGroups] = useState<ModifierGroup[]>([]);
  const [selected, setSelected] = useState<Record<number, number[]>>({});
  const [notes, setNotes] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const data = await getModifierGroupsForItem(item.id);
        setGroups(data);
        const init: Record<number, number[]> = {};
        data.forEach((g) => { init[g.id] = []; });
        setSelected(init);
      } catch {
        // no modifiers
      } finally {
        setLoading(false);
      }
    })();
  }, [item.id]);

  const handleSingleSelect = (groupId: number, modifierId: number) => {
    setSelected((prev) => ({
      ...prev,
      [groupId]: prev[groupId]?.[0] === modifierId ? [] : [modifierId],
    }));
  };

  const handleMultiSelect = (groupId: number, modifierId: number, max: number) => {
    setSelected((prev) => {
      const current = prev[groupId] || [];
      if (current.includes(modifierId)) {
        return { ...prev, [groupId]: current.filter((id) => id !== modifierId) };
      }
      if (current.length >= max) return prev;
      return { ...prev, [groupId]: [...current, modifierId] };
    });
  };

  const modifierPriceTotal = Object.values(selected)
    .flat()
    .reduce((sum, modId) => {
      for (const g of groups) {
        const mod = g.modifiers?.find((m) => m.id === modId);
        if (mod) return sum + (Number(mod.price_adjustment) || 0);
      }
      return sum;
    }, 0);

  const allModifierIds = Object.values(selected).flat();
  const allModifierNames = allModifierIds.map((id) => {
    for (const g of groups) {
      const mod = g.modifiers?.find((m) => m.id === id);
      if (mod) return mod.name;
    }
    return '';
  }).filter(Boolean);

  const isValid = groups.every((g) => {
    if (!g.required) return true;
    return (selected[g.id] || []).length >= g.min_selections;
  });

  const unitPrice = Number(item.price) + modifierPriceTotal;
  const lineTotal = unitPrice * quantity;

  const handleAdd = useCallback(() => {
    tapFeedback();
    onAdd(item, allModifierIds, allModifierNames, modifierPriceTotal, notes || undefined, quantity);
    onClose();
  }, [item, allModifierIds, allModifierNames, modifierPriceTotal, notes, quantity, onAdd, onClose]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end" onClick={onClose}>
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60" />

      {/* Sheet */}
      <div
        className="relative bg-neutral-900 rounded-t-3xl max-h-[85vh] flex flex-col animate-slide-up"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Drag handle */}
        <div className="flex justify-center pt-3 pb-1">
          <div className="w-10 h-1 rounded-full bg-neutral-700" />
        </div>

        {/* Header */}
        <div className="flex items-start justify-between px-4 pb-3">
          <div className="flex-1">
            <h2 className="text-xl font-bold text-white">{item.name}</h2>
            {item.description && (
              <p className="text-sm text-neutral-400 mt-0.5">{item.description}</p>
            )}
            <p className="text-brand-400 font-bold mt-1">{formatPrice(item.price)}</p>
          </div>
          <button onClick={onClose} className="p-2 text-neutral-500 touch-manipulation">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-5">
          {loading ? (
            <div className="text-neutral-500 text-center py-6">{t('modifier.loadingModifiers')}</div>
          ) : (
            <>
              {/* Quantity */}
              <div className="flex items-center justify-between">
                <span className="text-white font-semibold">{t('mobilePOS.quantity')}</span>
                <div className="flex items-center gap-4">
                  <button
                    onClick={() => setQuantity((q) => Math.max(1, q - 1))}
                    className="w-10 h-10 rounded-full bg-neutral-800 flex items-center justify-center text-white touch-manipulation"
                  >
                    <Minus className="w-4 h-4" />
                  </button>
                  <span className="text-white font-bold text-lg w-6 text-center">{quantity}</span>
                  <button
                    onClick={() => setQuantity((q) => q + 1)}
                    className="w-10 h-10 rounded-full bg-neutral-800 flex items-center justify-center text-white touch-manipulation"
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Modifier groups */}
              {groups.map((group) => (
                <div key={group.id}>
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-base font-bold text-white">{group.name}</h3>
                    <span className="text-xs text-neutral-400">
                      {group.required ? t('modifier.required') : t('modifier.optional')}
                      {group.selection_type === 'multi' && ` (${t('modifier.upTo', { max: group.max_selections })})`}
                    </span>
                  </div>
                  <div className="space-y-1.5">
                    {group.modifiers?.map((mod) => {
                      const isSelected = (selected[group.id] || []).includes(mod.id);
                      return (
                        <button
                          key={mod.id}
                          onClick={() => {
                            if (group.selection_type === 'single') {
                              handleSingleSelect(group.id, mod.id);
                            } else {
                              handleMultiSelect(group.id, mod.id, group.max_selections);
                            }
                          }}
                          className={`w-full flex items-center justify-between p-3 rounded-xl transition-colors touch-manipulation ${
                            isSelected
                              ? 'bg-brand-600/20 border-2 border-brand-600 text-white'
                              : 'bg-neutral-800 border border-neutral-700 text-neutral-300'
                          }`}
                        >
                          <div className="flex items-center gap-2.5">
                            <div
                              className={`w-5 h-5 rounded-${group.selection_type === 'single' ? 'full' : 'md'} border-2 flex items-center justify-center ${
                                isSelected ? 'border-brand-500 bg-brand-600' : 'border-neutral-500'
                              }`}
                            >
                              {isSelected && <div className="w-2 h-2 bg-white rounded-full" />}
                            </div>
                            <span className="font-medium text-sm">{mod.name}</span>
                          </div>
                          {mod.price_adjustment !== 0 && (
                            <span className={`text-sm font-bold ${mod.price_adjustment > 0 ? 'text-amber-400' : 'text-green-400'}`}>
                              {mod.price_adjustment > 0 ? '+' : ''}{formatPrice(mod.price_adjustment)}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}

              {/* Notes */}
              <div>
                <h3 className="text-base font-bold text-white mb-2">{t('mobilePOS.notes')}</h3>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder={t('mobilePOS.notesPlaceholder')}
                  className="w-full h-16 bg-neutral-800 border border-neutral-700 rounded-xl p-3 text-white text-sm placeholder-neutral-500 focus:outline-none focus:border-brand-600 resize-none"
                />
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-neutral-800 p-4" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 1rem)' }}>
          <button
            onClick={handleAdd}
            disabled={!isValid || loading}
            className="w-full py-4 bg-brand-600 text-white text-base font-bold rounded-2xl disabled:bg-neutral-700 disabled:text-neutral-500 active:bg-brand-700 transition-colors touch-manipulation"
          >
            {isValid
              ? `${t('mobilePOS.addToCart')} — ${formatPrice(lineTotal)}`
              : t('mobilePOS.requiredModifiers')}
          </button>
        </div>
      </div>

      <style>{`
        @keyframes slide-up {
          from { transform: translateY(100%); }
          to { transform: translateY(0); }
        }
        .animate-slide-up {
          animation: slide-up 0.25s ease-out;
        }
      `}</style>
    </div>
  );
};

export default MobileItemDetail;
