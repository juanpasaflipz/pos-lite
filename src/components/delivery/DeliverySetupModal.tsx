import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Loader2, Check, Truck } from 'lucide-react';
import { batchCreateDeliveryPlatforms } from '../../api';

type Step = 'select' | 'committing' | 'done';

interface PlatformOption {
  name: string;
  display_name: string;
  commission_percent: number;
  default_markup_percent: number;
  selected: boolean;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onDeliverySetup?: () => void;
}

const DEFAULT_PLATFORMS: PlatformOption[] = [
  { name: 'uber_eats', display_name: 'Uber Eats', commission_percent: 30, default_markup_percent: 0, selected: false },
  { name: 'rappi', display_name: 'Rappi', commission_percent: 25, default_markup_percent: 0, selected: false },
  { name: 'didi_food', display_name: 'DiDi Food', commission_percent: 22, default_markup_percent: 0, selected: false },
];

const PLATFORM_COLORS: Record<string, string> = {
  uber_eats: 'bg-green-600',
  rappi: 'bg-orange-500',
  didi_food: 'bg-orange-600',
};

export default function DeliverySetupModal({ isOpen, onClose, onDeliverySetup }: Props) {
  const { t } = useTranslation('admin');
  const [step, setStep] = useState<Step>('select');
  const [platforms, setPlatforms] = useState<PlatformOption[]>(DEFAULT_PLATFORMS.map(p => ({ ...p })));
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ created: number; updated: number } | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setStep('select');
    setPlatforms(DEFAULT_PLATFORMS.map(p => ({ ...p })));
    setError('');
    setResult(null);
  }, [isOpen]);

  if (!isOpen) return null;

  const selectedCount = platforms.filter(p => p.selected).length;

  const togglePlatform = (name: string) => {
    setPlatforms(prev => prev.map(p =>
      p.name === name ? { ...p, selected: !p.selected } : p
    ));
  };

  const updateCommission = (name: string, value: string) => {
    const num = parseFloat(value);
    if (isNaN(num)) return;
    setPlatforms(prev => prev.map(p =>
      p.name === name ? { ...p, commission_percent: Math.max(0, Math.min(100, num)) } : p
    ));
  };

  const updateMarkup = (name: string, value: string) => {
    const num = parseFloat(value);
    if (isNaN(num)) return;
    setPlatforms(prev => prev.map(p =>
      p.name === name ? { ...p, default_markup_percent: Math.max(0, Math.min(100, num)) } : p
    ));
  };

  const handleSetup = async () => {
    const selected = platforms.filter(p => p.selected);
    if (selected.length === 0) return;

    setStep('committing');
    setError('');

    try {
      const res = await batchCreateDeliveryPlatforms(
        selected.map(({ name, display_name, commission_percent, default_markup_percent }) => ({
          name, display_name, commission_percent, default_markup_percent,
        }))
      );
      setResult({ created: res.platforms_created, updated: res.platforms_updated });
      setStep('done');
      onDeliverySetup?.();
    } catch (err: any) {
      setError(err.message || t('delivery.failedSetup'));
      setStep('select');
    }
  };

  const handleDone = () => {
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="bg-neutral-900 border border-neutral-800 rounded-2xl w-full max-w-lg shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-neutral-800">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-brand-600/20 flex items-center justify-center">
              <Truck size={18} className="text-brand-400" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-white">{t('delivery.setupTitle')}</h2>
              <p className="text-xs text-neutral-400">{t('delivery.setupSubtitle')}</p>
            </div>
          </div>
          {step !== 'committing' && (
            <button onClick={onClose} className="text-neutral-500 hover:text-neutral-300 p-1">
              <X size={20} />
            </button>
          )}
        </div>

        {/* Content */}
        <div className="p-5">
          {step === 'select' && (
            <div className="space-y-3">
              {platforms.map(p => (
                <div
                  key={p.name}
                  className={`rounded-xl border transition-colors cursor-pointer ${
                    p.selected
                      ? 'border-brand-600 bg-brand-950/40'
                      : 'border-neutral-800 bg-neutral-800/40 hover:border-neutral-700'
                  }`}
                  onClick={() => togglePlatform(p.name)}
                >
                  <div className="flex items-center gap-3 p-4">
                    {/* Checkbox */}
                    <div className={`w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 transition-colors ${
                      p.selected ? 'bg-brand-600 border-brand-600' : 'border-neutral-600'
                    }`}>
                      {p.selected && <Check size={14} className="text-white" />}
                    </div>

                    {/* Platform badge */}
                    <span className={`px-2.5 py-1 rounded text-xs font-bold text-white ${PLATFORM_COLORS[p.name] || 'bg-neutral-600'}`}>
                      {p.display_name}
                    </span>

                    <div className="flex-1" />

                    {/* Commission input */}
                    <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
                      <label className="text-xs text-neutral-500">{t('delivery.commission')}</label>
                      <input
                        type="number"
                        value={p.commission_percent}
                        onChange={e => updateCommission(p.name, e.target.value)}
                        className="w-16 bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-sm text-white text-right focus:outline-none focus:border-brand-600"
                        min={0}
                        max={100}
                        step={1}
                      />
                      <span className="text-xs text-neutral-500">%</span>
                    </div>
                  </div>

                  {/* Expanded: markup input */}
                  {p.selected && (
                    <div className="px-4 pb-4 pt-0" onClick={e => e.stopPropagation()}>
                      <div className="flex items-center gap-2">
                        <label className="text-xs text-neutral-400">{t('delivery.defaultMarkup')}</label>
                        <input
                          type="number"
                          value={p.default_markup_percent}
                          onChange={e => updateMarkup(p.name, e.target.value)}
                          className="w-16 bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-sm text-white text-right focus:outline-none focus:border-brand-600"
                          min={0}
                          max={100}
                          step={1}
                        />
                        <span className="text-xs text-neutral-500">%</span>
                        <span className="text-xs text-neutral-600 ml-1">({t('delivery.markupHint')})</span>
                      </div>
                    </div>
                  )}
                </div>
              ))}

              {error && (
                <div className="bg-red-900/20 border border-red-800/50 rounded-lg p-3">
                  <p className="text-red-400 text-sm">{error}</p>
                </div>
              )}

              <button
                onClick={handleSetup}
                disabled={selectedCount === 0}
                className="w-full mt-2 py-3 rounded-xl font-bold text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed bg-brand-600 hover:bg-brand-500"
              >
                {t('delivery.setupButton', { count: selectedCount })}
              </button>
            </div>
          )}

          {step === 'committing' && (
            <div className="flex flex-col items-center justify-center py-12 gap-4">
              <Loader2 size={36} className="text-brand-400 animate-spin" />
              <p className="text-neutral-300 text-sm">{t('delivery.settingUp')}</p>
            </div>
          )}

          {step === 'done' && result && (
            <div className="flex flex-col items-center justify-center py-8 gap-4">
              <div className="w-14 h-14 rounded-full bg-green-900/30 flex items-center justify-center">
                <Check size={28} className="text-green-400" />
              </div>
              <div className="text-center">
                <p className="text-white font-bold text-lg">{t('delivery.platformsReady')}</p>
                <p className="text-neutral-400 text-sm mt-1">
                  {result.created > 0 && t('delivery.platformsCreated', { count: result.created })}
                  {result.created > 0 && result.updated > 0 && ', '}
                  {result.updated > 0 && t('delivery.platformsUpdated', { count: result.updated })}
                </p>
              </div>
              <button
                onClick={handleDone}
                className="px-6 py-2.5 rounded-xl font-bold text-white bg-brand-600 hover:bg-brand-500 transition-colors"
              >
                {t('common:buttons.done')}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
