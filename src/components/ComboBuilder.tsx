import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { getCombos, getMenuItems } from '../api';
import { ComboDefinition, MenuItem } from '../types';
import { formatPrice } from '../utils/currency';

interface ComboBuilderProps {
  onAddCombo: (items: Array<{ menu_item_id: number; combo_instance_id: string }>, comboPrice: number) => void;
  onClose: () => void;
}

export default function ComboBuilder({ onAddCombo, onClose }: ComboBuilderProps) {
  const { t } = useTranslation('pos');
  const [combos, setCombos] = useState<ComboDefinition[]>([]);
  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
  const [selectedCombo, setSelectedCombo] = useState<ComboDefinition | null>(null);
  const [slotSelections, setSlotSelections] = useState<Record<number, number>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const [combosData, itemsData] = await Promise.all([
          getCombos(),
          getMenuItems(),
        ]);
        setCombos(combosData);
        setMenuItems(itemsData);
      } catch (err) {
        console.error('Failed to load combos:', err);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  const getItemsForSlot = (slot: any): MenuItem[] => {
    if (slot.specific_item_id) {
      return menuItems.filter(mi => mi.id === slot.specific_item_id);
    }
    if (slot.category_id) {
      return menuItems.filter(mi => mi.category_id === slot.category_id && mi.active);
    }
    return menuItems.filter(mi => mi.active);
  };

  const handleSelectCombo = (combo: ComboDefinition) => {
    setSelectedCombo(combo);
    // Auto-select specific items
    const init: Record<number, number> = {};
    combo.slots?.forEach(slot => {
      if (slot.specific_item_id) {
        init[slot.id] = slot.specific_item_id;
      }
    });
    setSlotSelections(init);
  };

  const allSlotsFilled = selectedCombo?.slots?.every(slot => slotSelections[slot.id]) ?? false;

  const handleConfirm = () => {
    if (!selectedCombo || !allSlotsFilled) return;

    const comboInstanceId = `combo_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const items = selectedCombo.slots!.map(slot => ({
      menu_item_id: slotSelections[slot.id],
      combo_instance_id: comboInstanceId,
    }));

    onAddCombo(items, selectedCombo.combo_price);
  };

  // Calculate savings
  const individualTotal = selectedCombo?.slots?.reduce((sum, slot) => {
    const itemId = slotSelections[slot.id];
    if (!itemId) return sum;
    const item = menuItems.find(mi => mi.id === itemId);
    return sum + (item?.price || 0);
  }, 0) || 0;

  const savings = individualTotal - (selectedCombo?.combo_price || 0);

  if (loading) {
    return (
      <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
        <div className="bg-neutral-900 rounded-2xl p-8 text-white">{t('comboBuilder.loadingCombos')}</div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-neutral-900 rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] overflow-hidden border border-neutral-800 flex flex-col">
        <div className="bg-brand-600 text-white p-5 flex-shrink-0">
          <h2 className="text-2xl font-bold">
            {selectedCombo ? selectedCombo.name : t('comboBuilder.title')}
          </h2>
          {selectedCombo && (
            <p className="text-brand-200 text-sm mt-1">{selectedCombo.description}</p>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {!selectedCombo ? (
            // Combo Selection
            <div className="space-y-3">
              {combos.map(combo => (
                <button
                  key={combo.id}
                  onClick={() => handleSelectCombo(combo)}
                  className="w-full p-4 bg-neutral-800 border border-neutral-700 rounded-lg hover:border-brand-600 transition-all text-left"
                >
                  <div className="flex justify-between items-start">
                    <div>
                      <h3 className="text-lg font-bold text-white">{combo.name}</h3>
                      <p className="text-sm text-neutral-400 mt-1">{combo.description}</p>
                    </div>
                    <span className="text-xl font-bold text-brand-500">{formatPrice(combo.combo_price)}</span>
                  </div>
                </button>
              ))}
              {combos.length === 0 && (
                <p className="text-neutral-500 text-center py-8">{t('comboBuilder.noCombos')}</p>
              )}
            </div>
          ) : (
            // Slot Selection
            <div className="space-y-6">
              {selectedCombo.slots?.map((slot, index) => {
                const items = getItemsForSlot(slot);
                const selectedId = slotSelections[slot.id];

                return (
                  <div key={slot.id}>
                    <h3 className="text-lg font-bold text-white mb-2">
                      {t('comboBuilder.step', { number: index + 1 })}: {slot.slot_label}
                    </h3>
                    <div className="space-y-2">
                      {items.map(item => (
                        <button
                          key={item.id}
                          onClick={() => setSlotSelections(prev => ({ ...prev, [slot.id]: item.id }))}
                          className={`w-full flex items-center justify-between p-3 rounded-lg transition-all ${
                            selectedId === item.id
                              ? 'bg-brand-600/20 border-2 border-brand-600 text-white'
                              : 'bg-neutral-800 border border-neutral-700 text-neutral-300 hover:bg-neutral-700'
                          }`}
                        >
                          <span className="font-medium">{item.name}</span>
                          <span className="text-neutral-400 text-sm">{formatPrice(item.price)}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}

              {/* Savings Display */}
              {savings > 0 && allSlotsFilled && (
                <div className="bg-green-900/30 border border-green-800 rounded-lg p-4 text-center">
                  <p className="text-green-400 font-bold text-lg">{t('comboBuilder.youSave', { amount: formatPrice(savings) })}</p>
                  <p className="text-green-300 text-sm">
                    {t('comboBuilder.individual')}: {formatPrice(individualTotal)} → {t('comboBuilder.comboLabel')}: {formatPrice(selectedCombo.combo_price)}
                  </p>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="border-t border-neutral-800 p-4 flex-shrink-0 space-y-2">
          {selectedCombo ? (
            <>
              <button
                onClick={handleConfirm}
                disabled={!allSlotsFilled}
                className="w-full py-4 bg-brand-600 text-white text-lg font-bold rounded-lg hover:bg-brand-700 disabled:bg-neutral-700 disabled:text-neutral-500 transition-all"
              >
                {t('comboBuilder.addCombo', { price: formatPrice(selectedCombo.combo_price) })}
              </button>
              <button
                onClick={() => { setSelectedCombo(null); setSlotSelections({}); }}
                className="w-full py-3 bg-neutral-800 text-neutral-400 font-bold rounded-lg hover:bg-neutral-700 transition-all"
              >
                {t('comboBuilder.backToCombos')}
              </button>
            </>
          ) : (
            <button
              onClick={onClose}
              className="w-full py-3 bg-neutral-800 text-neutral-400 font-bold rounded-lg hover:bg-neutral-700 transition-all"
            >
              {t('common:buttons.cancel')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
