import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Loader2, Check, Sparkles, Trash2, ChevronDown, ChevronRight, AlertTriangle, ArrowLeft, Wand2, MessageSquare } from 'lucide-react';
import { parseMenuWithAI, parseMenuWithAIAsOwner, commitAIMenu, commitAIMenuAsOwner } from '../../api';
import type { AIMenuParseResult, MenuImportStats } from '../../types';
import { usePlan } from '../../context/PlanContext';
import UpgradePrompt from '../UpgradePrompt';

type Step = 'input' | 'parsing' | 'preview' | 'committing' | 'done';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onMenuCreated?: () => void;
  isFirstSetup?: boolean;
  ownerToken?: string | null;
}

const EXAMPLE_PROMPTS = [
  'Somos una taqueria con tacos de asada, pastor, chorizo, quesadillas de queso y de flor, aguas de horchata y jamaica',
  'Italian pizzeria with margherita, pepperoni, hawaiian, calzone, tiramisu, house salad',
  'Coffee shop: espresso $35, latte $45, cappuccino $50, matcha $55, croissant $40, banana bread $35',
];

const PARSING_MESSAGE_KEYS = [
  'aiMenuBuilder.parsingReading',
  'aiMenuBuilder.parsingIdentifying',
  'aiMenuBuilder.parsingPrices',
  'aiMenuBuilder.parsingIngredients',
  'aiMenuBuilder.parsingModifiers',
];

export default function AIMenuBuilderModal({ isOpen, onClose, onMenuCreated, isFirstSetup, ownerToken }: Props) {
  const { t } = useTranslation('admin');
  const { limits, isFeatureLocked } = usePlan();
  const aiLocked = isFeatureLocked('ai');
  const [step, setStep] = useState<Step>('input');
  const [text, setText] = useState('');
  const [parsedData, setParsedData] = useState<AIMenuParseResult['data'] | null>(null);
  const [stats, setStats] = useState<MenuImportStats | null>(null);
  const [error, setError] = useState('');
  const [replaceMode, setReplaceMode] = useState(isFirstSetup ?? false);
  const [parsingMsgIdx, setParsingMsgIdx] = useState(0);
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    setStep('input');
    setText('');
    setParsedData(null);
    setStats(null);
    setError('');
    setReplaceMode(isFirstSetup ?? false);
    setParsingMsgIdx(0);
    setCollapsedCategories(new Set());
    setTimeout(() => textareaRef.current?.focus(), 100);
  }, [isOpen]);

  // Cycle parsing messages
  useEffect(() => {
    if (step !== 'parsing') return;
    const interval = setInterval(() => {
      setParsingMsgIdx(i => (i + 1) % PARSING_MESSAGE_KEYS.length);
    }, 1500);
    return () => clearInterval(interval);
  }, [step]);

  if (!isOpen) return null;

  if (aiLocked) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
        <div className="bg-neutral-900 border border-neutral-700 rounded-xl p-8 max-w-md space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold text-white">{t('aiMenuBuilder.title')}</h2>
            <button onClick={onClose} className="p-1 text-neutral-500 hover:text-white"><X className="w-5 h-5" /></button>
          </div>
          <UpgradePrompt feature="AI Menu Builder" />
        </div>
      </div>
    );
  }

  const handleParse = async () => {
    if (!text.trim()) return;
    setStep('parsing');
    setError('');
    setParsingMsgIdx(0);
    try {
      let result: AIMenuParseResult;
      if (ownerToken) {
        result = await parseMenuWithAIAsOwner(text.trim(), ownerToken);
      } else {
        result = await parseMenuWithAI(text.trim());
      }
      if (result.success && result.data) {
        setParsedData(result.data);
        setStep('preview');
      } else {
        setError(result.error || t('aiMenuBuilder.failedParse'));
        setStep('input');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('aiMenuBuilder.failedParse'));
      setStep('input');
    }
  };

  const handleCommit = async () => {
    if (!parsedData) return;
    setStep('committing');
    setError('');
    try {
      const mode = replaceMode ? 'replace' : 'append';
      let result: MenuImportStats;
      if (ownerToken) {
        result = await commitAIMenuAsOwner(parsedData, ownerToken, mode);
      } else {
        result = await commitAIMenu(parsedData, mode);
      }
      setStats(result);
      setStep('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('aiMenuBuilder.failedCreate'));
      setStep('preview');
    }
  };

  const handleDone = () => {
    onMenuCreated?.();
    onClose();
  };

  const handleDeleteItem = (itemName: string) => {
    if (!parsedData) return;
    const newItems = parsedData.items.filter(i => i.name !== itemName);
    const newRecipes = (parsedData.recipes || []).filter(r => r.item_name !== itemName);
    setParsedData({ ...parsedData, items: newItems, recipes: newRecipes });
  };

  const handleEditPrice = (itemName: string, newPrice: string) => {
    if (!parsedData) return;
    const price = parseFloat(newPrice);
    if (isNaN(price)) return;
    const newItems = parsedData.items.map(i =>
      i.name === itemName ? { ...i, price: Math.round(price * 100) / 100 } : i
    );
    setParsedData({ ...parsedData, items: newItems });
  };

  const handleEditItemName = (oldName: string, newName: string) => {
    if (!parsedData) return;
    const newItems = parsedData.items.map(i =>
      i.name === oldName ? { ...i, name: newName } : i
    );
    const newRecipes = (parsedData.recipes || []).map(r =>
      r.item_name === oldName ? { ...r, item_name: newName } : r
    );
    setParsedData({ ...parsedData, items: newItems, recipes: newRecipes });
  };

  const toggleCategory = (catName: string) => {
    setCollapsedCategories(prev => {
      const next = new Set(prev);
      if (next.has(catName)) next.delete(catName);
      else next.add(catName);
      return next;
    });
  };

  // Group items by category for preview
  const itemsByCategory = parsedData?.items.reduce<Record<string, typeof parsedData.items>>((acc, item) => {
    const cat = item.category || 'General';
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(item);
    return acc;
  }, {}) || {};

  const totalItems = parsedData?.items.length || 0;
  const totalCategories = parsedData?.categories?.length || 0;
  const totalIngredients = parsedData?.inventory?.length || 0;
  const totalModGroups = parsedData?.modifier_groups?.length || 0;

  const limitWarning = typeof limits.menuItems === 'number' && limits.menuItems !== Infinity && totalItems > limits.menuItems
    ? t('aiMenuBuilder.planLimitWarning', { limit: limits.menuItems })
    : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
      <div
        className="relative bg-neutral-900 border border-neutral-800 rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="sticky top-0 bg-neutral-900 border-b border-neutral-800 px-6 py-4 flex items-center justify-between z-10">
          <div className="flex items-center gap-3">
            {step === 'preview' && (
              <button onClick={() => setStep('input')} className="p-1 hover:bg-neutral-800 rounded-lg transition-colors">
                <ArrowLeft size={18} className="text-neutral-400" />
              </button>
            )}
            <Sparkles size={18} className="text-brand-400" />
            <h2 className="text-lg font-bold text-white">
              {step === 'input' && t('aiMenuBuilder.title')}
              {step === 'parsing' && t('aiMenuBuilder.building')}
              {step === 'preview' && t('aiMenuBuilder.reviewMenu')}
              {step === 'committing' && t('aiMenuBuilder.creatingMenu')}
              {step === 'done' && t('aiMenuBuilder.menuCreated')}
            </h2>
          </div>
          {step !== 'parsing' && step !== 'committing' && (
            <button onClick={onClose} className="p-2 hover:bg-neutral-800 rounded-lg transition-colors">
              <X size={18} className="text-neutral-400" />
            </button>
          )}
        </div>

        <div className="p-6">
          {/* Input step */}
          {step === 'input' && (
            <>
              <p className="text-neutral-400 text-sm mb-4">
                {t('aiMenuBuilder.inputDescription')}
              </p>

              <textarea
                ref={textareaRef}
                value={text}
                onChange={e => { setText(e.target.value); setError(''); }}
                placeholder={t('aiMenuBuilder.inputPlaceholder')}
                className="w-full h-48 bg-neutral-800/60 border border-neutral-700/60 rounded-xl p-4 text-white text-sm placeholder-neutral-500 resize-none focus:outline-none focus:border-brand-600/60 transition-colors"
                maxLength={10000}
              />

              <div className="flex items-center justify-between mt-2 mb-4">
                <span className="text-neutral-500 text-xs">
                  {text.length.toLocaleString()} / 10,000 characters
                </span>
              </div>

              {/* Example prompts */}
              <div className="mb-5">
                <p className="text-neutral-500 text-xs font-medium uppercase tracking-wider mb-2">{t('aiMenuBuilder.tryExample')}</p>
                <div className="flex flex-wrap gap-2">
                  {EXAMPLE_PROMPTS.map((prompt, i) => (
                    <button
                      key={i}
                      onClick={() => setText(prompt)}
                      className="text-left text-xs bg-neutral-800/60 hover:bg-neutral-800 border border-neutral-700/40 hover:border-brand-600/40 rounded-lg px-3 py-2 text-neutral-300 transition-colors line-clamp-1"
                    >
                      {prompt.length > 60 ? prompt.slice(0, 60) + '...' : prompt}
                    </button>
                  ))}
                </div>
              </div>

              {error && (
                <div className="mb-4 flex items-start gap-3 bg-cockpit-red/20 border border-cockpit-red/40 rounded-lg p-3">
                  <AlertTriangle size={16} className="text-cockpit-red flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-cockpit-red text-sm">{error}</p>
                    <p className="text-neutral-400 text-xs mt-1">
                      {t('aiMenuBuilder.errorHint')}
                    </p>
                  </div>
                </div>
              )}

              <button
                onClick={handleParse}
                disabled={!text.trim()}
                className="w-full py-3 bg-brand-600 hover:bg-brand-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold rounded-xl transition-colors text-sm flex items-center justify-center gap-2"
              >
                <Sparkles size={16} /> {t('aiMenuBuilder.buildMenu')}
              </button>

              <button
                onClick={() => {
                  onClose();
                  // Open FAB modal via DOM event
                  window.dispatchEvent(new CustomEvent('open-ai-assistant', { detail: { context: 'menu' } }));
                }}
                className="w-full mt-3 py-2.5 text-cockpit-blue hover:text-cockpit-blue/90 text-xs flex items-center justify-center gap-2 transition-colors"
              >
                <MessageSquare size={14} /> {t('aiMenuBuilder.tryAssistant')}
              </button>
            </>
          )}

          {/* Parsing step */}
          {step === 'parsing' && (
            <div className="flex flex-col items-center justify-center py-16">
              <Loader2 size={36} className="text-brand-500 animate-spin mb-4" />
              <p className="text-neutral-300 text-sm animate-pulse">
                {t(PARSING_MESSAGE_KEYS[parsingMsgIdx])}
              </p>
            </div>
          )}

          {/* Preview step */}
          {step === 'preview' && parsedData && (
            <div className="space-y-5">
              {/* Summary bar */}
              <div className="flex flex-wrap gap-3">
                <div className="bg-neutral-800/60 rounded-lg px-3 py-2 text-center">
                  <p className="text-lg font-bold text-brand-400">{totalCategories}</p>
                  <p className="text-neutral-400 text-xs">{t('aiMenuBuilder.categories')}</p>
                </div>
                <div className="bg-neutral-800/60 rounded-lg px-3 py-2 text-center">
                  <p className="text-lg font-bold text-brand-400">{totalItems}</p>
                  <p className="text-neutral-400 text-xs">{t('aiMenuBuilder.items')}</p>
                </div>
                {totalIngredients > 0 && (
                  <div className="bg-neutral-800/60 rounded-lg px-3 py-2 text-center">
                    <p className="text-lg font-bold text-brand-400">{totalIngredients}</p>
                    <p className="text-neutral-400 text-xs">{t('aiMenuBuilder.ingredients')}</p>
                  </div>
                )}
                {totalModGroups > 0 && (
                  <div className="bg-neutral-800/60 rounded-lg px-3 py-2 text-center">
                    <p className="text-lg font-bold text-brand-400">{totalModGroups}</p>
                    <p className="text-neutral-400 text-xs">{t('aiMenuBuilder.modifierGroups')}</p>
                  </div>
                )}
              </div>

              {/* Items grouped by category */}
              <div className="space-y-2">
                {Object.entries(itemsByCategory).map(([catName, items]) => (
                  <div key={catName} className="bg-neutral-800/40 rounded-xl overflow-hidden">
                    <button
                      onClick={() => toggleCategory(catName)}
                      className="w-full flex items-center gap-2 px-4 py-3 text-left"
                    >
                      {collapsedCategories.has(catName)
                        ? <ChevronRight size={14} className="text-neutral-400" />
                        : <ChevronDown size={14} className="text-neutral-400" />
                      }
                      <span className="text-white font-semibold text-sm">{catName}</span>
                      <span className="text-neutral-500 text-xs ml-1">({items.length})</span>
                    </button>
                    {!collapsedCategories.has(catName) && (
                      <div className="px-4 pb-3 space-y-1.5">
                        {items.map((item) => (
                          <div key={item.name} className="flex items-center gap-3 bg-neutral-900/60 rounded-lg px-3 py-2">
                            <input
                              type="text"
                              defaultValue={item.name}
                              onBlur={e => {
                                const v = e.target.value.trim();
                                if (v && v !== item.name) handleEditItemName(item.name, v);
                              }}
                              className="flex-1 bg-transparent text-white text-sm outline-none min-w-0"
                            />
                            {item.description && (
                              <span className="hidden md:block text-neutral-500 text-xs truncate max-w-[140px]">
                                {item.description}
                              </span>
                            )}
                            <div className="flex items-center gap-1 flex-shrink-0">
                              <span className="text-neutral-500 text-xs">$</span>
                              <input
                                type="number"
                                defaultValue={item.price}
                                onBlur={e => handleEditPrice(item.name, e.target.value)}
                                className="w-16 bg-neutral-800 border border-neutral-700/60 rounded px-2 py-1 text-white text-sm text-right outline-none focus:border-brand-600/60"
                                step="0.5"
                                min="0"
                              />
                            </div>
                            <button
                              onClick={() => handleDeleteItem(item.name)}
                              className="p-1 hover:bg-cockpit-red/30 rounded transition-colors flex-shrink-0"
                              title="Remove item"
                            >
                              <Trash2 size={14} className="text-neutral-500 hover:text-cockpit-red/90" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {/* Modifier groups */}
              {parsedData.modifier_groups && parsedData.modifier_groups.length > 0 && (
                <div>
                  <p className="text-neutral-400 text-xs font-medium uppercase tracking-wider mb-2">{t('aiMenuBuilder.modifierGroups')}</p>
                  <div className="flex flex-wrap gap-2">
                    {parsedData.modifier_groups.map((mg, i) => (
                      <div key={i} className="bg-neutral-800/60 border border-neutral-700/40 rounded-lg px-3 py-2">
                        <p className="text-white text-sm font-medium">{mg.name}</p>
                        <p className="text-neutral-500 text-xs">
                          {mg.modifiers.map(m => m.name).join(', ')}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Replace toggle */}
              <label className="flex items-center gap-3 cursor-pointer">
                <div
                  className={`w-10 h-6 rounded-full transition-colors relative ${replaceMode ? 'bg-brand-600' : 'bg-neutral-700'}`}
                  onClick={() => setReplaceMode(!replaceMode)}
                >
                  <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-transform ${replaceMode ? 'left-5' : 'left-1'}`} />
                </div>
                <div>
                  <span className="text-white text-sm font-medium">{t('aiMenuBuilder.replaceItems')}</span>
                  <p className="text-neutral-500 text-xs">{t('aiMenuBuilder.replaceItemsHint')}</p>
                </div>
              </label>

              {/* Plan limit warning */}
              {limitWarning && (
                <div className="flex items-start gap-3 bg-cockpit-yellow/20 border border-cockpit-yellow/40 rounded-lg p-3">
                  <AlertTriangle size={16} className="text-cockpit-yellow flex-shrink-0 mt-0.5" />
                  <p className="text-cockpit-yellow text-sm">{limitWarning}</p>
                </div>
              )}

              {error && (
                <div className="text-cockpit-red text-sm bg-cockpit-red/20 border border-cockpit-red/40 rounded-lg p-3">{error}</div>
              )}

              <div className="flex gap-3">
                <button
                  onClick={() => { setStep('input'); setError(''); }}
                  className="flex-1 py-3 border border-neutral-700 text-neutral-300 font-semibold rounded-xl transition-colors text-sm hover:bg-neutral-800 flex items-center justify-center gap-2"
                >
                  <Wand2 size={14} /> {t('aiMenuBuilder.refine')}
                </button>
                <button
                  onClick={handleCommit}
                  disabled={totalItems === 0}
                  className="flex-[2] py-3 bg-brand-600 hover:bg-brand-500 disabled:opacity-40 text-white font-semibold rounded-xl transition-colors text-sm flex items-center justify-center gap-2"
                >
                  {t('aiMenuBuilder.createMenu')}
                </button>
              </div>
            </div>
          )}

          {/* Committing step */}
          {step === 'committing' && (
            <div className="flex flex-col items-center justify-center py-16">
              <Loader2 size={36} className="text-brand-500 animate-spin mb-4" />
              <p className="text-neutral-300 text-sm">{t('aiMenuBuilder.creatingItems')}</p>
            </div>
          )}

          {/* Done step */}
          {step === 'done' && stats && (
            <div className="space-y-5">
              <div className="flex items-center justify-center">
                <div className="w-16 h-16 rounded-full bg-brand-600/20 flex items-center justify-center">
                  <Check size={32} className="text-brand-400" />
                </div>
              </div>
              <h3 className="text-white text-xl font-bold text-center">{t('aiMenuBuilder.menuReady')}</h3>

              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                {stats.categoriesCreated > 0 && (
                  <div className="bg-neutral-800/60 rounded-lg p-3 text-center">
                    <p className="text-2xl font-bold text-brand-400">{stats.categoriesCreated}</p>
                    <p className="text-neutral-400 text-xs mt-1">{t('aiMenuBuilder.categories')}</p>
                  </div>
                )}
                {stats.itemsCreated > 0 && (
                  <div className="bg-neutral-800/60 rounded-lg p-3 text-center">
                    <p className="text-2xl font-bold text-brand-400">{stats.itemsCreated}</p>
                    <p className="text-neutral-400 text-xs mt-1">{t('aiMenuBuilder.menuItems')}</p>
                  </div>
                )}
                {stats.inventoryCreated > 0 && (
                  <div className="bg-neutral-800/60 rounded-lg p-3 text-center">
                    <p className="text-2xl font-bold text-brand-400">{stats.inventoryCreated}</p>
                    <p className="text-neutral-400 text-xs mt-1">{t('aiMenuBuilder.ingredients')}</p>
                  </div>
                )}
                {stats.recipesCreated > 0 && (
                  <div className="bg-neutral-800/60 rounded-lg p-3 text-center">
                    <p className="text-2xl font-bold text-brand-400">{stats.recipesCreated}</p>
                    <p className="text-neutral-400 text-xs mt-1">{t('aiMenuBuilder.recipes')}</p>
                  </div>
                )}
                {stats.modifierGroupsCreated > 0 && (
                  <div className="bg-neutral-800/60 rounded-lg p-3 text-center">
                    <p className="text-2xl font-bold text-brand-400">{stats.modifierGroupsCreated}</p>
                    <p className="text-neutral-400 text-xs mt-1">{t('aiMenuBuilder.modifierGroups')}</p>
                  </div>
                )}
              </div>

              {stats.warnings.length > 0 && (
                <div className="bg-cockpit-yellow/20 border border-cockpit-yellow/40 rounded-lg p-3">
                  {stats.warnings.map((w, i) => (
                    <p key={i} className="text-cockpit-yellow text-sm flex items-start gap-2">
                      <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" /> {w}
                    </p>
                  ))}
                </div>
              )}

              <button
                onClick={handleDone}
                className="w-full py-3 bg-brand-600 hover:bg-brand-500 text-white font-semibold rounded-xl transition-colors text-sm"
              >
                {isFirstSetup ? t('aiMenuBuilder.continueToPOS') : t('aiMenuBuilder.viewMenu')}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
