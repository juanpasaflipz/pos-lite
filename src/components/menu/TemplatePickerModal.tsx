import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Loader2, Check, ChevronRight, ArrowLeft, AlertTriangle } from 'lucide-react';
import { getMenuTemplates, applyMenuTemplate, applyMenuTemplateAsOwner } from '../../api';
import { MenuTemplateOption, MenuImportStats } from '../../types';
import { usePlan } from '../../context/PlanContext';

const TEMPLATE_ICONS: Record<string, string> = {
  taco: '\uD83C\uDF2E',
  burger: '\uD83C\uDF54',
  pizza: '\uD83C\uDF55',
  coffee: '\u2615',
  sushi: '\uD83C\uDF63',
  restaurant: '\uD83C\uDF7D\uFE0F',
};

type Step = 'pick' | 'confirm' | 'loading' | 'success';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onTemplateApplied?: () => void;
  isFirstSetup?: boolean;
  ownerToken?: string | null;
}

export default function TemplatePickerModal({ isOpen, onClose, onTemplateApplied, isFirstSetup, ownerToken }: Props) {
  const { t } = useTranslation('admin');
  const { plan, limits } = usePlan();
  const [step, setStep] = useState<Step>('pick');
  const [templates, setTemplates] = useState<MenuTemplateOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<MenuTemplateOption | null>(null);
  const [replaceMode, setReplaceMode] = useState(isFirstSetup ?? false);
  const [stats, setStats] = useState<MenuImportStats | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    setStep('pick');
    setSelected(null);
    setStats(null);
    setError('');
    setReplaceMode(isFirstSetup ?? false);
    setLoading(true);
    getMenuTemplates()
      .then(setTemplates)
      .catch(() => setError(t('menuTemplate.failedLoad')))
      .finally(() => setLoading(false));
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSelect = (tmpl: MenuTemplateOption) => {
    setSelected(tmpl);
    setStep('confirm');
  };

  const handleApply = async () => {
    if (!selected) return;
    setStep('loading');
    setError('');
    try {
      const mode = replaceMode ? 'replace' : 'append';
      let result: MenuImportStats;
      if (ownerToken) {
        result = await applyMenuTemplateAsOwner(selected.id, ownerToken, mode);
      } else {
        result = await applyMenuTemplate(selected.id, mode);
      }
      setStats(result);
      setStep('success');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('menuTemplate.failedApply'));
      setStep('confirm');
    }
  };

  const handleDone = () => {
    onTemplateApplied?.();
    onClose();
  };

  const limitWarning = typeof limits.menuItems === 'number' && limits.menuItems !== Infinity && selected
    ? selected.item_count > limits.menuItems
      ? t('menuTemplate.planLimitWarning', { limit: limits.menuItems })
      : null
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
            {step === 'confirm' && (
              <button onClick={() => setStep('pick')} className="p-1 hover:bg-neutral-800 rounded-lg transition-colors">
                <ArrowLeft size={18} className="text-neutral-400" />
              </button>
            )}
            <h2 className="text-lg font-bold text-white">
              {step === 'pick' && t('menuTemplate.chooseTemplate')}
              {step === 'confirm' && t('menuTemplate.confirmTemplate')}
              {step === 'loading' && t('menuTemplate.settingUp')}
              {step === 'success' && t('menuTemplate.menuCreated')}
            </h2>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-neutral-800 rounded-lg transition-colors">
            <X size={18} className="text-neutral-400" />
          </button>
        </div>

        <div className="p-6">
          {/* Pick step */}
          {step === 'pick' && (
            <>
              <p className="text-neutral-400 text-sm mb-6">
                {t('menuTemplate.pickDescription')}
              </p>
              {loading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 size={24} className="text-brand-500 animate-spin" />
                </div>
              ) : error ? (
                <div className="text-red-400 text-sm text-center py-8">{error}</div>
              ) : (
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                  {templates.map(tmpl => (
                    <button
                      key={tmpl.id}
                      onClick={() => handleSelect(tmpl)}
                      className="group text-left bg-neutral-800/60 hover:bg-neutral-800 border border-neutral-700/60 hover:border-brand-600/60 rounded-xl p-4 transition-all"
                    >
                      <div className="text-3xl mb-3">{TEMPLATE_ICONS[tmpl.icon] || '\uD83C\uDF7D\uFE0F'}</div>
                      <h3 className="text-white font-semibold text-sm mb-1">{tmpl.name}</h3>
                      <p className="text-neutral-400 text-xs mb-3 line-clamp-2">{tmpl.description}</p>
                      <div className="flex items-center gap-2 text-xs text-neutral-500">
                        <span>{tmpl.item_count} {t('menuTemplate.items')}</span>
                        <span>&middot;</span>
                        <span>{tmpl.category_count} {t('menuTemplate.categoriesLabel')}</span>
                      </div>
                      <div className="flex items-center gap-1 mt-3 text-brand-400 text-xs font-medium opacity-0 group-hover:opacity-100 transition-opacity">
                        {t('menuTemplate.useThis')} <ChevronRight size={12} />
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}

          {/* Confirm step */}
          {step === 'confirm' && selected && (
            <div className="space-y-5">
              <div className="flex items-start gap-4 bg-neutral-800/40 rounded-xl p-4">
                <div className="text-4xl flex-shrink-0">{TEMPLATE_ICONS[selected.icon] || '\uD83C\uDF7D\uFE0F'}</div>
                <div>
                  <h3 className="text-white font-bold text-lg">{selected.name}</h3>
                  <p className="text-neutral-400 text-sm mt-1">{selected.description}</p>
                  <div className="flex gap-4 mt-3 text-sm text-neutral-300">
                    <span>{selected.item_count} {t('menuTemplate.menuItems')}</span>
                    <span>{selected.category_count} {t('menuTemplate.categoriesLabel')}</span>
                  </div>
                </div>
              </div>

              {/* Replace toggle */}
              <label className="flex items-center gap-3 cursor-pointer">
                <div
                  className={`w-10 h-6 rounded-full transition-colors relative ${replaceMode ? 'bg-brand-600' : 'bg-neutral-700'}`}
                  onClick={() => setReplaceMode(!replaceMode)}
                >
                  <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-transform ${replaceMode ? 'left-5' : 'left-1'}`} />
                </div>
                <div>
                  <span className="text-white text-sm font-medium">{t('menuTemplate.replaceItems')}</span>
                  <p className="text-neutral-500 text-xs">{t('menuTemplate.replaceItemsHint')}</p>
                </div>
              </label>

              {/* Plan limit warning */}
              {limitWarning && (
                <div className="flex items-start gap-3 bg-amber-900/20 border border-amber-700/40 rounded-lg p-3">
                  <AlertTriangle size={16} className="text-amber-400 flex-shrink-0 mt-0.5" />
                  <p className="text-amber-300 text-sm">{limitWarning}</p>
                </div>
              )}

              {error && (
                <div className="text-red-400 text-sm bg-red-900/20 border border-red-800/40 rounded-lg p-3">{error}</div>
              )}

              <button
                onClick={handleApply}
                className="w-full py-3 bg-brand-600 hover:bg-brand-500 text-white font-semibold rounded-xl transition-colors text-sm"
              >
                {t('menuTemplate.applyTemplate')}
              </button>
            </div>
          )}

          {/* Loading step */}
          {step === 'loading' && (
            <div className="flex flex-col items-center justify-center py-16">
              <Loader2 size={36} className="text-brand-500 animate-spin mb-4" />
              <p className="text-neutral-300 text-sm">{t('menuTemplate.creatingItems')}</p>
            </div>
          )}

          {/* Success step */}
          {step === 'success' && stats && (
            <div className="space-y-5">
              <div className="flex items-center justify-center">
                <div className="w-16 h-16 rounded-full bg-brand-600/20 flex items-center justify-center">
                  <Check size={32} className="text-brand-400" />
                </div>
              </div>
              <h3 className="text-white text-xl font-bold text-center">{t('menuTemplate.menuReady')}</h3>

              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                {stats.categoriesCreated > 0 && (
                  <div className="bg-neutral-800/60 rounded-lg p-3 text-center">
                    <p className="text-2xl font-bold text-brand-400">{stats.categoriesCreated}</p>
                    <p className="text-neutral-400 text-xs mt-1">{t('menuTemplate.categoriesLabel')}</p>
                  </div>
                )}
                {stats.itemsCreated > 0 && (
                  <div className="bg-neutral-800/60 rounded-lg p-3 text-center">
                    <p className="text-2xl font-bold text-brand-400">{stats.itemsCreated}</p>
                    <p className="text-neutral-400 text-xs mt-1">{t('menuTemplate.menuItems')}</p>
                  </div>
                )}
                {stats.inventoryCreated > 0 && (
                  <div className="bg-neutral-800/60 rounded-lg p-3 text-center">
                    <p className="text-2xl font-bold text-brand-400">{stats.inventoryCreated}</p>
                    <p className="text-neutral-400 text-xs mt-1">{t('menuTemplate.ingredients')}</p>
                  </div>
                )}
                {stats.recipesCreated > 0 && (
                  <div className="bg-neutral-800/60 rounded-lg p-3 text-center">
                    <p className="text-2xl font-bold text-brand-400">{stats.recipesCreated}</p>
                    <p className="text-neutral-400 text-xs mt-1">{t('menuTemplate.recipes')}</p>
                  </div>
                )}
                {stats.modifierGroupsCreated > 0 && (
                  <div className="bg-neutral-800/60 rounded-lg p-3 text-center">
                    <p className="text-2xl font-bold text-brand-400">{stats.modifierGroupsCreated}</p>
                    <p className="text-neutral-400 text-xs mt-1">{t('menuTemplate.modifierGroups')}</p>
                  </div>
                )}
                {stats.combosCreated > 0 && (
                  <div className="bg-neutral-800/60 rounded-lg p-3 text-center">
                    <p className="text-2xl font-bold text-brand-400">{stats.combosCreated}</p>
                    <p className="text-neutral-400 text-xs mt-1">{t('menuTemplate.combos')}</p>
                  </div>
                )}
              </div>

              {stats.warnings.length > 0 && (
                <div className="bg-amber-900/20 border border-amber-700/40 rounded-lg p-3">
                  {stats.warnings.map((w, i) => (
                    <p key={i} className="text-amber-300 text-sm flex items-start gap-2">
                      <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" /> {w}
                    </p>
                  ))}
                </div>
              )}

              <button
                onClick={handleDone}
                className="w-full py-3 bg-brand-600 hover:bg-brand-500 text-white font-semibold rounded-xl transition-colors text-sm"
              >
                {isFirstSetup ? t('menuTemplate.continueToPOS') : t('menuTemplate.viewMenu')}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
