import React from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles, AlertCircle, Clock, Moon, ShieldCheck } from 'lucide-react';

export type PulseBucket = 'added_today' | 'low' | 'stale' | 'dormant' | 'healthy';

interface PulseCounts {
  added_today: number;
  low: number;
  stale: number;
  dormant: number;
  healthy: number;
  total: number;
}

interface InventoryPulseGridProps {
  counts: PulseCounts;
  loading: boolean;
  activeBucket: PulseBucket | null;
  onBucketToggle: (bucket: PulseBucket) => void;
}

interface CardConfig {
  key: PulseBucket;
  labelKey: string;
  hintKey: string;
  icon: React.ReactNode;
  ring: string;
  accent: string;
  number: string;
}

const cardConfigs: CardConfig[] = [
  {
    key: 'added_today',
    labelKey: 'pulse.addedToday',
    hintKey: 'pulse.addedTodayHint',
    icon: <Sparkles size={18} />,
    ring: 'ring-cockpit-green',
    accent: 'bg-cockpit-green/15 text-cockpit-in-text border-cockpit-green/40',
    number: 'text-cockpit-in-text',
  },
  {
    key: 'low',
    labelKey: 'pulse.lowStock',
    hintKey: 'pulse.lowStockHint',
    icon: <AlertCircle size={18} />,
    ring: 'ring-cockpit-yellow',
    accent: 'bg-cockpit-yellow/15 text-cockpit-attention-text border-cockpit-yellow/40',
    number: 'text-cockpit-attention-text',
  },
  {
    key: 'stale',
    labelKey: 'pulse.stale',
    hintKey: 'pulse.staleHint',
    icon: <Clock size={18} />,
    ring: 'ring-cockpit-red',
    accent: 'bg-cockpit-red/15 text-cockpit-out-text border-cockpit-red/40',
    number: 'text-cockpit-out-text',
  },
  {
    key: 'dormant',
    labelKey: 'pulse.dormant',
    hintKey: 'pulse.dormantHint',
    icon: <Moon size={18} />,
    ring: 'ring-brand-500',
    accent: 'bg-brand-600/15 text-brand-300 border-brand-600/40',
    number: 'text-brand-300',
  },
  {
    key: 'healthy',
    labelKey: 'pulse.healthy',
    hintKey: 'pulse.healthyHint',
    icon: <ShieldCheck size={18} />,
    ring: 'ring-neutral-500',
    accent: 'bg-neutral-800 text-neutral-300 border-neutral-700',
    number: 'text-neutral-200',
  },
];

export default function InventoryPulseGrid({
  counts,
  loading,
  activeBucket,
  onBucketToggle,
}: InventoryPulseGridProps) {
  const { t } = useTranslation('inventory');

  return (
    <div className="mb-6">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-sm uppercase tracking-wider text-neutral-500 font-semibold">
          {t('pulse.title')}
        </h2>
        <span className="text-xs text-neutral-500">
          {t('pulse.totalItems', { n: counts.total })}
        </span>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {cardConfigs.map((cfg) => {
          const value = counts[cfg.key];
          const isActive = activeBucket === cfg.key;
          const isDimmed = activeBucket !== null && !isActive;
          return (
            <button
              key={cfg.key}
              type="button"
              onClick={() => onBucketToggle(cfg.key)}
              aria-pressed={isActive}
              className={`text-left p-4 rounded-lg border transition-all min-h-[88px] ${cfg.accent} ${
                isActive ? `ring-2 ${cfg.ring} ring-offset-2 ring-offset-neutral-950` : ''
              } ${isDimmed ? 'opacity-50 hover:opacity-100' : ''} hover:scale-[1.02] active:scale-[0.98]`}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold uppercase tracking-wider">
                  {t(cfg.labelKey)}
                </span>
                {cfg.icon}
              </div>
              <div className={`text-3xl font-black ${cfg.number}`}>
                {loading ? '–' : value}
              </div>
              <p className="text-[11px] text-neutral-400 mt-1 leading-tight">
                {t(cfg.hintKey)}
              </p>
            </button>
          );
        })}
      </div>

      {activeBucket && (
        <div className="mt-3 flex items-center gap-2 text-xs text-neutral-400">
          <span>{t('pulse.filterActive', { bucket: t(`pulse.${activeBucket === 'added_today' ? 'addedToday' : activeBucket === 'low' ? 'lowStock' : activeBucket}`) })}</span>
          <button
            onClick={() => onBucketToggle(activeBucket)}
            className="px-2 py-0.5 bg-neutral-800 hover:bg-neutral-700 rounded text-neutral-300 transition-colors"
          >
            {t('pulse.clearFilter')}
          </button>
        </div>
      )}
    </div>
  );
}
