import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Sparkles, X } from 'lucide-react';
import {
  backfillInventoryAttrs,
  getInventoryAuditStatus,
  type InventoryAuditStatus,
} from '../../api';
import { useToast } from '../../context/ToastContext';

interface Props {
  onAuditComplete?: () => void;
}

const BATCH_SIZE = 25;
const MAX_BATCHES = 20; // hard ceiling = 500 items per run

const ShelfLifeAuditBanner: React.FC<Props> = ({ onAuditComplete }) => {
  const { t } = useTranslation('inventory');
  const { addToast } = useToast();
  const [status, setStatus] = useState<InventoryAuditStatus | null>(null);
  const [running, setRunning] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await getInventoryAuditStatus());
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleRun = async () => {
    if (!status || status.missing_shelf_life === 0) return;
    setRunning(true);
    const total = status.missing_shelf_life;
    setProgress({ done: 0, total });
    let aiHits = 0;
    let fallbacks = 0;
    let clocksSet = 0;
    try {
      for (let i = 0; i < MAX_BATCHES; i++) {
        const result = await backfillInventoryAttrs(BATCH_SIZE);
        aiHits += result.ai_hits;
        fallbacks += result.fallbacks;
        clocksSet += result.restock_clock_set;
        const doneSoFar = total - result.remaining;
        setProgress({ done: doneSoFar, total });
        if (result.remaining === 0 || result.processed === 0) break;
      }
      addToast(
        t('audit.complete', {
          defaultValue: 'Audit done · AI: {{ai}} · defaults: {{fb}} · clocks set: {{clk}}',
          ai: aiHits,
          fb: fallbacks,
          clk: clocksSet,
        }),
        'success',
        7000
      );
      await load();
      onAuditComplete?.();
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Audit failed', 'error');
    } finally {
      setRunning(false);
      setProgress(null);
    }
  };

  if (!status || status.missing_shelf_life === 0 || dismissed) return null;

  return (
    <div className="rounded-xl border border-brand-700/50 bg-brand-950/30 px-4 py-3 mb-4 flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-2 min-w-0">
        <Sparkles size={16} className="text-brand-400 shrink-0" />
        <div className="text-sm text-brand-100 min-w-0">
          <div className="font-medium truncate">
            {t('audit.headline', {
              defaultValue: '{{count}} items need a shelf life',
              count: status.missing_shelf_life,
            })}
          </div>
          <div className="text-xs text-brand-300/80">
            {running && progress
              ? t('audit.progress', {
                  defaultValue: 'Analyzing… {{done}} / {{total}}',
                  done: progress.done,
                  total: progress.total,
                })
              : t('audit.hint', {
                  defaultValue: 'Claude will infer typical shelf life + storage type so the stale-stock panel can flag drift.',
                })}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button
          type="button"
          onClick={handleRun}
          disabled={running}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-brand-600 hover:bg-brand-500 text-white text-sm font-semibold rounded-lg transition-colors disabled:opacity-60 min-h-[36px]"
        >
          {running
            ? <Loader2 size={14} className="animate-spin" />
            : <Sparkles size={14} />}
          {running
            ? t('audit.running', { defaultValue: 'Running…' })
            : t('audit.runButton', { defaultValue: 'Run AI audit' })}
        </button>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="p-1.5 text-brand-300/60 hover:text-brand-200 transition-colors"
          aria-label={t('common:buttons.dismiss', { defaultValue: 'Dismiss' })}
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
};

export default ShelfLifeAuditBanner;
