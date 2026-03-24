import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { getModifierGroupsForItem } from '../api';
import { MenuItem, ModifierGroup } from '../types';
import { formatPrice } from '../utils/currency';

interface ModifierModalProps {
  item: MenuItem;
  onConfirm: (selectedModifiers: number[], notes: string) => void;
  onClose: () => void;
}

export default function ModifierModal({ item, onConfirm, onClose }: ModifierModalProps) {
  const { t } = useTranslation('pos');
  const [groups, setGroups] = useState<ModifierGroup[]>([]);
  const [selected, setSelected] = useState<Record<number, number[]>>({});
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const data = await getModifierGroupsForItem(item.id);
        setGroups(data);
        // Initialize selections with defaults
        const init: Record<number, number[]> = {};
        data.forEach(g => { init[g.id] = []; });
        setSelected(init);
      } catch (err) {
        console.error('Failed to load modifiers:', err);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [item.id]);

  const handleSingleSelect = (groupId: number, modifierId: number) => {
    setSelected(prev => ({
      ...prev,
      [groupId]: prev[groupId]?.[0] === modifierId ? [] : [modifierId],
    }));
  };

  const handleMultiSelect = (groupId: number, modifierId: number, maxSelections: number) => {
    setSelected(prev => {
      const current = prev[groupId] || [];
      if (current.includes(modifierId)) {
        return { ...prev, [groupId]: current.filter(id => id !== modifierId) };
      }
      if (current.length >= maxSelections) return prev;
      return { ...prev, [groupId]: [...current, modifierId] };
    });
  };

  const totalAdjustment = Object.values(selected)
    .flat()
    .reduce((sum, modId) => {
      for (const g of groups) {
        const mod = g.modifiers?.find(m => m.id === modId);
        if (mod) return sum + (Number(mod.price_adjustment) || 0);
      }
      return sum;
    }, 0);

  const allModifierIds = Object.values(selected).flat();

  // Validate required groups
  const isValid = groups.every(g => {
    if (!g.required) return true;
    const sel = selected[g.id] || [];
    return sel.length >= g.min_selections;
  });

  const handleConfirm = () => {
    onConfirm(allModifierIds, notes);
  };

  if (loading) {
    return (
      <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
        <div className="bg-neutral-900 rounded-2xl p-8 text-white">{t('modifier.loadingModifiers')}</div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-neutral-900 rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] overflow-hidden border border-neutral-800 flex flex-col">
        {/* Header */}
        <div className="bg-brand-600 text-white p-5 flex-shrink-0">
          <h2 className="text-2xl font-bold">{item.name}</h2>
          <p className="text-brand-200 text-sm">{item.description}</p>
          <p className="text-lg font-bold mt-1">
            {formatPrice(item.price)}
            {totalAdjustment > 0 && (
              <span className="text-brand-200"> + {formatPrice(totalAdjustment)}</span>
            )}
          </p>
        </div>

        {/* Modifier Groups */}
        <div className="flex-1 overflow-y-auto p-5 space-y-6">
          {groups.map(group => (
            <div key={group.id}>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-lg font-bold text-white">{group.name}</h3>
                <span className="text-xs text-neutral-400">
                  {group.required ? t('modifier.required') : t('modifier.optional')}
                  {group.selection_type === 'multi' && ` (${t('modifier.upTo', { max: group.max_selections })})`}
                </span>
              </div>

              <div className="space-y-2">
                {group.modifiers?.map(mod => {
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
                      className={`w-full flex items-center justify-between p-3 rounded-lg transition-all ${
                        isSelected
                          ? 'bg-brand-600/20 border-2 border-brand-600 text-white'
                          : 'bg-neutral-800 border border-neutral-700 text-neutral-300 hover:bg-neutral-700'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <div className={`w-5 h-5 rounded-${group.selection_type === 'single' ? 'full' : 'md'} border-2 flex items-center justify-center ${
                          isSelected ? 'border-brand-500 bg-brand-600' : 'border-neutral-500'
                        }`}>
                          {isSelected && <div className="w-2 h-2 bg-white rounded-full" />}
                        </div>
                        <span className="font-medium">{mod.name}</span>
                      </div>
                      {mod.price_adjustment !== 0 && (
                        <span className={`font-bold ${mod.price_adjustment > 0 ? 'text-amber-400' : 'text-green-400'}`}>
                          {mod.price_adjustment > 0 ? '+' : ''}{formatPrice(mod.price_adjustment)}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}

          {/* Notes field */}
          <div>
            <h3 className="text-lg font-bold text-white mb-2">{t('modifier.specialInstructions')}</h3>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={t('modifier.instructionsPlaceholder')}
              className="w-full h-20 bg-neutral-800 border border-neutral-700 rounded-lg p-3 text-white placeholder-neutral-500 focus:outline-none focus:border-brand-600 resize-none"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="border-t border-neutral-800 p-4 flex-shrink-0 space-y-2">
          <button
            onClick={handleConfirm}
            disabled={!isValid}
            className="w-full py-4 bg-brand-600 text-white text-lg font-bold rounded-lg hover:bg-brand-700 disabled:bg-neutral-700 disabled:text-neutral-500 transition-all"
          >
            {t('modifier.addToOrder', { price: formatPrice(Number(item.price) + totalAdjustment) })}
          </button>
          <button
            onClick={onClose}
            className="w-full py-3 bg-neutral-800 text-neutral-400 font-bold rounded-lg hover:bg-neutral-700 transition-all"
          >
            {t('common:buttons.cancel')}
          </button>
        </div>
      </div>
    </div>
  );
}
