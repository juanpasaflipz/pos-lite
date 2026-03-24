import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Plus, Edit2, X, Check, Trash2 } from 'lucide-react';
import {
  getModifierGroups,
  createModifierGroup,
  updateModifierGroup,
  createModifier,
  updateModifier,
  getCombos,
  createCombo,
  updateCombo,
  getCategories,
  getMenuItems,
} from '../api';
import { ModifierGroup, ComboDefinition, ComboSlot, MenuCategory, MenuItem } from '../types';
import { formatPrice } from '../utils/currency';
import BrandLogo from '../components/BrandLogo';
import { usePlan } from '../context/PlanContext';
import UpgradePrompt from '../components/UpgradePrompt';

interface ComboFormData {
  name: string;
  description: string;
  combo_price: string;
  slots: SlotFormData[];
}

interface SlotFormData {
  slot_label: string;
  category_id: string;
  specific_item_id: string;
  sort_order: number;
}

const emptySlot = (): SlotFormData => ({
  slot_label: '',
  category_id: '',
  specific_item_id: '',
  sort_order: 0,
});

const emptyComboForm = (): ComboFormData => ({
  name: '',
  description: '',
  combo_price: '',
  slots: [emptySlot()],
});

export default function ModifierManagement() {
  const { t } = useTranslation('inventory');
  const { limits, isAtLimit } = usePlan();
  const [groups, setGroups] = useState<ModifierGroup[]>([]);
  const [combos, setCombos] = useState<ComboDefinition[]>([]);
  const [categories, setCategories] = useState<MenuCategory[]>([]);
  const [menuItemsByCategory, setMenuItemsByCategory] = useState<Record<number, MenuItem[]>>({});
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'modifiers' | 'combos'>('modifiers');
  const [showAddGroup, setShowAddGroup] = useState(false);
  const [showAddModifier, setShowAddModifier] = useState<number | null>(null);
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupType, setNewGroupType] = useState<'single' | 'multi'>('single');
  const [newModName, setNewModName] = useState('');
  const [newModPrice, setNewModPrice] = useState('0');

  // Combo form state
  const [showComboForm, setShowComboForm] = useState(false);
  const [editingComboId, setEditingComboId] = useState<number | null>(null);
  const [comboForm, setComboForm] = useState<ComboFormData>(emptyComboForm());
  const [comboFormError, setComboFormError] = useState<string | null>(null);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      setLoading(true);
      const [groupsData, combosData, categoriesData] = await Promise.all([
        getModifierGroups(),
        getCombos(),
        getCategories(true),
      ]);
      setGroups(groupsData);
      setCombos(combosData);
      setCategories(categoriesData);
    } catch (err) {
      console.error('Failed to load data:', err);
    } finally {
      setLoading(false);
    }
  };

  const fetchMenuItemsForCategory = async (categoryId: number) => {
    if (menuItemsByCategory[categoryId]) return;
    try {
      const items = await getMenuItems(String(categoryId));
      setMenuItemsByCategory(prev => ({ ...prev, [categoryId]: items }));
    } catch (err) {
      console.error('Failed to fetch items for category:', err);
    }
  };

  const handleCreateGroup = async () => {
    if (!newGroupName.trim()) return;
    try {
      await createModifierGroup({
        name: newGroupName,
        selection_type: newGroupType,
        required: false,
        min_selections: 0,
        max_selections: newGroupType === 'single' ? 1 : 5,
      });
      setNewGroupName('');
      setShowAddGroup(false);
      fetchData();
    } catch (err) {
      console.error('Failed to create group:', err);
    }
  };

  const handleCreateModifier = async (groupId: number) => {
    if (!newModName.trim()) return;
    try {
      await createModifier({
        group_id: groupId,
        name: newModName,
        price_adjustment: parseFloat(newModPrice) || 0,
      });
      setNewModName('');
      setNewModPrice('0');
      setShowAddModifier(null);
      fetchData();
    } catch (err) {
      console.error('Failed to create modifier:', err);
    }
  };

  const handleToggleGroup = async (group: ModifierGroup) => {
    try {
      await updateModifierGroup(group.id, { active: !group.active });
      fetchData();
    } catch (err) {
      console.error('Failed to toggle group:', err);
    }
  };

  const handleToggleModifier = async (modId: number, currentActive: boolean) => {
    try {
      await updateModifier(modId, { active: !currentActive });
      fetchData();
    } catch (err) {
      console.error('Failed to toggle modifier:', err);
    }
  };

  // Combo handlers
  const openCreateCombo = () => {
    setComboForm(emptyComboForm());
    setEditingComboId(null);
    setComboFormError(null);
    setShowComboForm(true);
  };

  const openEditCombo = (combo: ComboDefinition) => {
    setComboForm({
      name: combo.name,
      description: combo.description || '',
      combo_price: String(combo.combo_price),
      slots: combo.slots && combo.slots.length > 0
        ? combo.slots.map(s => ({
            slot_label: s.slot_label,
            category_id: s.category_id ? String(s.category_id) : '',
            specific_item_id: s.specific_item_id ? String(s.specific_item_id) : '',
            sort_order: s.sort_order,
          }))
        : [emptySlot()],
    });
    setEditingComboId(combo.id);
    setComboFormError(null);
    setShowComboForm(true);
  };

  const closeComboForm = () => {
    setShowComboForm(false);
    setEditingComboId(null);
    setComboForm(emptyComboForm());
    setComboFormError(null);
  };

  const addSlot = () => {
    setComboForm(prev => ({
      ...prev,
      slots: [...prev.slots, { ...emptySlot(), sort_order: prev.slots.length }],
    }));
  };

  const removeSlot = (index: number) => {
    setComboForm(prev => ({
      ...prev,
      slots: prev.slots.filter((_, i) => i !== index),
    }));
  };

  const updateSlot = (index: number, field: keyof SlotFormData, value: string | number) => {
    setComboForm(prev => ({
      ...prev,
      slots: prev.slots.map((s, i) => i === index ? { ...s, [field]: value } : s),
    }));
  };

  const handleSaveCombo = async () => {
    if (!comboForm.name.trim()) {
      setComboFormError(t('modifiers.combos.comboNameRequired'));
      return;
    }
    if (!comboForm.combo_price || parseFloat(comboForm.combo_price) <= 0) {
      setComboFormError(t('modifiers.combos.pricePositive'));
      return;
    }
    if (comboForm.slots.length === 0 || !comboForm.slots.some(s => s.slot_label.trim())) {
      setComboFormError(t('modifiers.combos.slotRequired'));
      return;
    }

    const validSlots = comboForm.slots
      .filter(s => s.slot_label.trim())
      .map((s, i) => ({
        slot_label: s.slot_label.trim(),
        category_id: s.category_id ? parseInt(s.category_id) : null,
        specific_item_id: s.specific_item_id ? parseInt(s.specific_item_id) : null,
        sort_order: i,
      }));

    try {
      setComboFormError(null);
      if (editingComboId) {
        await updateCombo(editingComboId, {
          name: comboForm.name.trim(),
          description: comboForm.description.trim(),
          combo_price: parseFloat(comboForm.combo_price),
        });
        // Note: slot editing requires delete+recreate on backend (not supported in current PUT).
        // For now we update the combo metadata. Full slot editing would need a backend endpoint.
      } else {
        await createCombo({
          name: comboForm.name.trim(),
          description: comboForm.description.trim(),
          combo_price: parseFloat(comboForm.combo_price),
          slots: validSlots,
        } as any);
      }
      closeComboForm();
      fetchData();
    } catch (err) {
      setComboFormError(err instanceof Error ? err.message : t('modifiers.combos.failedSave'));
    }
  };

  const handleToggleCombo = async (combo: ComboDefinition) => {
    try {
      await updateCombo(combo.id, { active: !combo.active });
      fetchData();
    } catch (err) {
      console.error('Failed to toggle combo:', err);
    }
  };

  return (
    <div className="min-h-screen bg-neutral-950">
      <div className="bg-neutral-900 text-white p-6 border-b border-neutral-800">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link to="/admin" className="p-2 hover:bg-neutral-800 rounded-lg transition-colors">
              <ArrowLeft size={24} />
            </Link>
            <h1 className="text-3xl font-black tracking-tighter">{t('modifiers.title')}</h1>
          </div>
          <BrandLogo className="h-10" />
        </div>
      </div>

      <div className="max-w-5xl mx-auto p-6">
        {/* Tabs */}
        <div className="flex gap-3 mb-6">
          <button
            onClick={() => setTab('modifiers')}
            className={`px-6 py-3 rounded-lg font-medium transition-colors ${
              tab === 'modifiers' ? 'bg-brand-600 text-white' : 'bg-neutral-900 text-neutral-300 border border-neutral-800 hover:bg-neutral-800'
            }`}
          >
            {t('modifiers.tabs.modifierGroups')}
          </button>
          <button
            onClick={() => setTab('combos')}
            className={`px-6 py-3 rounded-lg font-medium transition-colors ${
              tab === 'combos' ? 'bg-brand-600 text-white' : 'bg-neutral-900 text-neutral-300 border border-neutral-800 hover:bg-neutral-800'
            }`}
          >
            {t('modifiers.tabs.combos')}
          </button>
        </div>

        {loading ? (
          <div className="space-y-4">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="h-32 bg-neutral-900 rounded-lg border border-neutral-800 animate-pulse" />
            ))}
          </div>
        ) : tab === 'modifiers' ? (
          <div className="space-y-4">
            {isAtLimit('modifierGroups', groups.filter(g => g.active !== false).length) && (
              <UpgradePrompt message={t('modifiers.limitReached', { limit: limits.modifierGroups })} />
            )}
            <div className="flex items-center gap-3">
              <button
                onClick={() => setShowAddGroup(true)}
                disabled={isAtLimit('modifierGroups', groups.filter(g => g.active !== false).length)}
                className="flex items-center gap-2 px-4 py-3 bg-brand-600 text-white rounded-lg font-medium hover:bg-brand-700 transition-colors disabled:opacity-50"
              >
                <Plus size={20} /> {t('modifiers.addGroup')}
              </button>
              {limits.modifierGroups !== Infinity && (
                <span className="text-sm text-neutral-400">
                  {groups.filter(g => g.active !== false).length} / {limits.modifierGroups} {t('modifiers.groupsCount')}
                </span>
              )}
            </div>

            {showAddGroup && (
              <div className="bg-neutral-900 p-4 rounded-lg border border-neutral-800 space-y-3">
                <input
                  value={newGroupName}
                  onChange={(e) => setNewGroupName(e.target.value)}
                  placeholder={t('modifiers.groupNamePlaceholder')}
                  className="w-full bg-neutral-800 border border-neutral-700 rounded-lg p-3 text-white focus:outline-none focus:border-brand-600"
                />
                <div className="flex gap-3">
                  <button
                    onClick={() => setNewGroupType('single')}
                    className={`px-4 py-2 rounded-lg font-medium ${newGroupType === 'single' ? 'bg-brand-600 text-white' : 'bg-neutral-800 text-neutral-300'}`}
                  >
                    {t('modifiers.singleSelect')}
                  </button>
                  <button
                    onClick={() => setNewGroupType('multi')}
                    className={`px-4 py-2 rounded-lg font-medium ${newGroupType === 'multi' ? 'bg-brand-600 text-white' : 'bg-neutral-800 text-neutral-300'}`}
                  >
                    {t('modifiers.multiSelect')}
                  </button>
                </div>
                <div className="flex gap-2">
                  <button onClick={handleCreateGroup} className="px-4 py-2 bg-green-600 text-white rounded-lg font-medium hover:bg-green-700">{t('common:buttons.create')}</button>
                  <button onClick={() => setShowAddGroup(false)} className="px-4 py-2 bg-neutral-700 text-white rounded-lg font-medium hover:bg-neutral-600">{t('common:buttons.cancel')}</button>
                </div>
              </div>
            )}

            {groups.map(group => (
              <div key={group.id} className={`bg-neutral-900 rounded-lg border border-neutral-800 overflow-hidden ${!group.active ? 'opacity-50' : ''}`}>
                <div className="p-4 flex items-center justify-between border-b border-neutral-800">
                  <div>
                    <h3 className="text-lg font-bold text-white">{group.name}</h3>
                    <p className="text-sm text-neutral-400">
                      {group.selection_type === 'single' ? t('modifiers.singleSelectLabel') : t('modifiers.multiSelectLabel')}
                      {group.required ? ` (${t('modifiers.required')})` : ` (${t('modifiers.optional')})`}
                      {' — '}{group.modifiers?.length || 0} {t('modifiers.optionsCount')}
                    </p>
                  </div>
                  <button
                    onClick={() => handleToggleGroup(group)}
                    className={`px-3 py-1 rounded-lg text-sm font-medium ${group.active ? 'bg-green-900/30 text-green-400' : 'bg-neutral-800 text-neutral-500'}`}
                  >
                    {group.active ? t('menu.active') : t('menu.inactive')}
                  </button>
                </div>

                <div className="p-4 space-y-2">
                  {group.modifiers?.map(mod => (
                    <div key={mod.id} className="flex items-center justify-between p-2 bg-neutral-800/50 rounded-lg">
                      <div className="flex items-center gap-3">
                        <span className={`text-white ${!mod.active ? 'line-through text-neutral-500' : ''}`}>{mod.name}</span>
                        {mod.price_adjustment !== 0 && (
                          <span className="text-xs font-bold text-amber-400">
                            {mod.price_adjustment > 0 ? '+' : ''}{formatPrice(mod.price_adjustment)}
                          </span>
                        )}
                      </div>
                      <button
                        onClick={() => handleToggleModifier(mod.id, mod.active)}
                        className="text-xs text-neutral-500 hover:text-white"
                      >
                        {mod.active ? t('common:buttons.disable') : t('common:buttons.enable')}
                      </button>
                    </div>
                  ))}

                  {showAddModifier === group.id ? (
                    <div className="flex gap-2 mt-2">
                      <input
                        value={newModName}
                        onChange={(e) => setNewModName(e.target.value)}
                        placeholder={t('modifiers.modifierNamePlaceholder')}
                        className="flex-1 bg-neutral-800 border border-neutral-700 rounded-lg p-2 text-white text-sm focus:outline-none focus:border-brand-600"
                      />
                      <input
                        type="number"
                        value={newModPrice}
                        onChange={(e) => setNewModPrice(e.target.value)}
                        placeholder={t('modifiers.priceAdj')}
                        className="w-24 bg-neutral-800 border border-neutral-700 rounded-lg p-2 text-white text-sm focus:outline-none focus:border-brand-600"
                      />
                      <button onClick={() => handleCreateModifier(group.id)} className="px-3 py-2 bg-green-600 text-white rounded-lg text-sm font-medium">{t('common:buttons.add')}</button>
                      <button onClick={() => setShowAddModifier(null)} className="px-3 py-2 bg-neutral-700 text-white rounded-lg text-sm font-medium">X</button>
                    </div>
                  ) : (
                    <button
                      onClick={() => { setShowAddModifier(group.id); setNewModName(''); setNewModPrice('0'); }}
                      className="flex items-center gap-1 text-sm text-neutral-400 hover:text-white mt-2"
                    >
                      <Plus size={14} /> {t('modifiers.addModifier')}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          /* ==================== Combos Tab ==================== */
          <div className="space-y-4">
            {isAtLimit('combos', combos.filter(c => c.active !== false).length) && (
              <UpgradePrompt message={t('modifiers.comboLimitReached', { limit: limits.combos })} />
            )}
            <div className="flex items-center gap-3">
              <button
                onClick={openCreateCombo}
                disabled={isAtLimit('combos', combos.filter(c => c.active !== false).length)}
                className="flex items-center gap-2 px-4 py-3 bg-brand-600 text-white rounded-lg font-medium hover:bg-brand-700 transition-colors disabled:opacity-50"
              >
                <Plus size={20} /> {t('modifiers.combos.createCombo')}
              </button>
              {limits.combos !== Infinity && (
                <span className="text-sm text-neutral-400">
                  {combos.filter(c => c.active !== false).length} / {limits.combos} {t('modifiers.combosCount')}
                </span>
              )}
            </div>

            {/* Combo Create/Edit Form */}
            {showComboForm && (
              <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800 space-y-4">
                <h3 className="text-lg font-bold text-white">
                  {editingComboId ? t('modifiers.combos.editCombo') : t('modifiers.combos.newCombo')}
                </h3>

                {comboFormError && (
                  <div className="bg-brand-900/30 border border-brand-800 rounded-lg p-3">
                    <p className="text-brand-300 text-sm">{comboFormError}</p>
                  </div>
                )}

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <input
                    value={comboForm.name}
                    onChange={(e) => setComboForm({ ...comboForm, name: e.target.value })}
                    placeholder={t('modifiers.combos.form.name')}
                    className="bg-neutral-800 border border-neutral-700 rounded-lg p-3 text-white focus:outline-none focus:border-brand-600"
                  />
                  <input
                    value={comboForm.description}
                    onChange={(e) => setComboForm({ ...comboForm, description: e.target.value })}
                    placeholder={t('modifiers.combos.form.description')}
                    className="bg-neutral-800 border border-neutral-700 rounded-lg p-3 text-white focus:outline-none focus:border-brand-600"
                  />
                  <div className="flex items-center">
                    <span className="text-neutral-400 font-medium mr-1">$</span>
                    <input
                      type="number"
                      value={comboForm.combo_price}
                      onChange={(e) => setComboForm({ ...comboForm, combo_price: e.target.value })}
                      placeholder={t('modifiers.combos.form.price')}
                      step="0.01"
                      min="0"
                      className="flex-1 bg-neutral-800 border border-neutral-700 rounded-lg p-3 text-white focus:outline-none focus:border-brand-600"
                    />
                  </div>
                </div>

                {/* Slots */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold text-neutral-400 uppercase">{t('modifiers.combos.form.slots')}</p>
                    <button
                      onClick={addSlot}
                      className="flex items-center gap-1 text-sm text-brand-400 hover:text-brand-300"
                    >
                      <Plus size={14} /> {t('modifiers.combos.form.addSlot')}
                    </button>
                  </div>

                  {comboForm.slots.map((slot, index) => (
                    <div key={index} className="flex gap-2 items-center bg-neutral-800/50 p-3 rounded-lg">
                      <span className="text-neutral-500 font-bold text-sm w-6">{index + 1}.</span>
                      <input
                        value={slot.slot_label}
                        onChange={(e) => updateSlot(index, 'slot_label', e.target.value)}
                        placeholder={t('modifiers.combos.form.slotLabel')}
                        className="flex-1 bg-neutral-700 border border-neutral-600 rounded-lg p-2 text-white text-sm focus:outline-none focus:border-brand-600"
                      />
                      <select
                        value={slot.category_id}
                        onChange={(e) => {
                          updateSlot(index, 'category_id', e.target.value);
                          updateSlot(index, 'specific_item_id', '');
                          if (e.target.value) fetchMenuItemsForCategory(parseInt(e.target.value));
                        }}
                        className="w-40 bg-neutral-700 border border-neutral-600 rounded-lg p-2 text-white text-sm focus:outline-none focus:border-brand-600"
                      >
                        <option value="">{t('modifiers.combos.form.anyCategory')}</option>
                        {categories.map(c => (
                          <option key={c.id} value={c.id}>{c.name}</option>
                        ))}
                      </select>
                      {slot.category_id && menuItemsByCategory[parseInt(slot.category_id)] && (
                        <select
                          value={slot.specific_item_id}
                          onChange={(e) => updateSlot(index, 'specific_item_id', e.target.value)}
                          className="w-40 bg-neutral-700 border border-neutral-600 rounded-lg p-2 text-white text-sm focus:outline-none focus:border-brand-600"
                        >
                          <option value="">{t('modifiers.combos.form.anyItem')}</option>
                          {menuItemsByCategory[parseInt(slot.category_id)]?.map(item => (
                            <option key={item.id} value={item.id}>{item.name}</option>
                          ))}
                        </select>
                      )}
                      {comboForm.slots.length > 1 && (
                        <button
                          onClick={() => removeSlot(index)}
                          className="p-1.5 text-neutral-500 hover:text-brand-400"
                        >
                          <Trash2 size={16} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>

                <div className="flex gap-2 pt-2">
                  <button
                    onClick={handleSaveCombo}
                    className="px-6 py-2 bg-green-600 text-white rounded-lg font-medium hover:bg-green-700 flex items-center gap-2"
                  >
                    <Check size={18} />
                    {editingComboId ? t('menu.form.saveChanges') : t('modifiers.combos.createCombo')}
                  </button>
                  <button
                    onClick={closeComboForm}
                    className="px-6 py-2 bg-neutral-700 text-white rounded-lg font-medium hover:bg-neutral-600"
                  >
                    {t('common:buttons.cancel')}
                  </button>
                </div>
              </div>
            )}

            {/* Combo List */}
            {combos.map(combo => (
              <div key={combo.id} className={`bg-neutral-900 rounded-lg border border-neutral-800 p-6 ${!combo.active ? 'opacity-50' : ''}`}>
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <h3 className="text-xl font-bold text-white">{combo.name}</h3>
                    <p className="text-neutral-400 text-sm">{combo.description}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-2xl font-bold text-brand-500">{formatPrice(combo.combo_price)}</span>
                    <button
                      onClick={() => openEditCombo(combo)}
                      className="p-2 text-neutral-400 hover:text-white hover:bg-neutral-800 rounded-lg transition-colors"
                    >
                      <Edit2 size={18} />
                    </button>
                    <button
                      onClick={() => handleToggleCombo(combo)}
                      className={`px-3 py-1 rounded-lg text-sm font-medium ${combo.active ? 'bg-green-900/30 text-green-400' : 'bg-neutral-800 text-neutral-500'}`}
                    >
                      {combo.active ? t('modifiers.combos.active') : t('modifiers.combos.inactive')}
                    </button>
                  </div>
                </div>
                {combo.slots && combo.slots.length > 0 && (
                  <div className="space-y-2 mt-4">
                    <p className="text-sm font-semibold text-neutral-400 uppercase">{t('modifiers.combos.slots')}</p>
                    {combo.slots.map((slot: any, i: number) => (
                      <div key={slot.id} className="flex items-center gap-2 text-sm text-neutral-300 bg-neutral-800 p-2 rounded">
                        <span className="font-bold text-neutral-500">{i + 1}.</span>
                        <span>{slot.slot_label}</span>
                        {slot.category_name && <span className="text-neutral-500">({slot.category_name})</span>}
                        {slot.item_name && <span className="text-neutral-500">({t('modifiers.combos.fixed')} {slot.item_name})</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {combos.length === 0 && !showComboForm && (
              <div className="bg-neutral-900 rounded-lg border border-neutral-800 p-12 text-center">
                <p className="text-neutral-400 mb-4">{t('modifiers.combos.noCombos')}</p>
                <button
                  onClick={openCreateCombo}
                  className="px-6 py-3 bg-brand-600 text-white rounded-lg font-medium hover:bg-brand-700 transition-colors inline-flex items-center gap-2"
                >
                  <Plus size={20} /> {t('modifiers.combos.createFirstCombo')}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
