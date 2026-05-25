import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Check, ChevronDown, ChevronUp, Loader2, RotateCcw, Trash2 } from 'lucide-react';
import {
  getStaleStock,
  markInventoryWasted,
  touchInventoryRestocked,
  type StaleStockItem,
} from '../../api';
import { formatPrice } from '../../utils/currency';
import { useToast } from '../../context/ToastContext';

interface Props {
  onItemUpdated?: () => void;
}

const StaleStockPanel: React.FC<Props> = ({ onItemUpdated }) => {
  const { t } = useTranslation('inventory');
  const { addToast } = useToast();
  const [items, setItems] = useState<StaleStockItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await getStaleStock(false));
    } catch (err) {
      console.error('[StaleStock] load failed', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleStillHere = async (item: StaleStockItem) => {
    setBusyId(item.id);
    try {
      await touchInventoryRestocked(item.id);
      setItems(prev => prev.filter(i => i.id !== item.id));
      addToast(t('stale.stillHereConfirmed', { defaultValue: 'Clock reset for {{name}}', name: item.name }), 'success');
      onItemUpdated?.();
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Failed', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleWasted = async (item: StaleStockItem) => {
    const msg = t('stale.confirmWasted', {
      defaultValue: 'Mark {{qty}} {{unit}} of {{name}} as wasted? This zeros the stock and records the loss.',
      qty: item.quantity,
      unit: item.unit || '',
      name: item.name,
    });
    if (!confirm(msg)) return;
    setBusyId(item.id);
    try {
      await markInventoryWasted(item.id, { reason: 'expired' });
      setItems(prev => prev.filter(i => i.id !== item.id));
      addToast(t('stale.wastedLogged', { defaultValue: 'Logged {{name}} as wasted', name: item.name }), 'success');
      onItemUpdated?.();
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Failed', 'error');
    } finally {
      setBusyId(null);
    }
  };

  if (loading) return null;
  if (items.length === 0) return null;

  return (
    <div className="rounded-xl border border-cockpit-yellow/60 bg-cockpit-yellow/30 overflow-hidden mb-4">
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-cockpit-yellow/50 transition-colors"
      >
        <div className="flex items-center gap-2">
          <AlertTriangle size={18} className="text-cockpit-attention-text" />
          <span className="font-semibold text-cockpit-attention-text">
            {t('stale.title', { defaultValue: 'Stale stock check' })}
          </span>
          <span className="text-xs px-2 py-0.5 rounded-full bg-cockpit-yellow/60 text-cockpit-attention-text">
            {items.length}
          </span>
        </div>
        {expanded ? <ChevronUp size={16} className="text-cockpit-attention-text" /> : <ChevronDown size={16} className="text-cockpit-attention-text" />}
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-2">
          <p className="text-xs text-cockpit-attention-text/80 pb-1">
            {t('stale.hint', {
              defaultValue: 'These items are past their typical shelf life. Confirm what\'s still good and log the rest as waste.',
            })}
          </p>
          {items.map((item) => (
            <div
              key={item.id}
              className="rounded-lg border border-cockpit-yellow/50 bg-neutral-950 p-3 space-y-2"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-white font-medium truncate">{item.name}</div>
                  <div className="text-xs text-neutral-400 mt-0.5">
                    {t('stale.daysAgo', {
                      defaultValue: 'Restocked {{days}} days ago · typical {{shelf}} days',
                      days: item.days_since_restock,
                      shelf: item.shelf_life_days,
                    })}
                    {item.storage_type && (
                      <span className="text-neutral-500"> · {item.storage_type}</span>
                    )}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-sm text-white font-medium">
                    {item.quantity} {item.unit || ''}
                  </div>
                  {item.cost_price > 0 && (
                    <div className="text-[10px] text-neutral-500">
                      ≈ {formatPrice(item.quantity * item.cost_price)}
                    </div>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => handleStillHere(item)}
                  disabled={busyId === item.id}
                  className="flex items-center justify-center gap-1.5 py-2 bg-neutral-800 hover:bg-cockpit-green/30 hover:text-cockpit-in-text/90 text-neutral-200 text-sm rounded-md border border-neutral-700 hover:border-cockpit-green/90 transition-colors disabled:opacity-50 min-h-[40px]"
                >
                  {busyId === item.id
                    ? <Loader2 size={14} className="animate-spin" />
                    : <Check size={14} />}
                  {t('stale.stillHere', { defaultValue: 'Still here' })}
                </button>
                <button
                  type="button"
                  onClick={() => handleWasted(item)}
                  disabled={busyId === item.id}
                  className="flex items-center justify-center gap-1.5 py-2 bg-neutral-800 hover:bg-cockpit-red/40 hover:text-cockpit-out-text/90 text-neutral-200 text-sm rounded-md border border-neutral-700 hover:border-cockpit-red/90 transition-colors disabled:opacity-50 min-h-[40px]"
                >
                  {busyId === item.id
                    ? <Loader2 size={14} className="animate-spin" />
                    : <Trash2 size={14} />}
                  {t('stale.markWasted', { defaultValue: 'Log as waste' })}
                </button>
              </div>
            </div>
          ))}
          <button
            type="button"
            onClick={load}
            className="w-full flex items-center justify-center gap-1.5 py-1.5 text-xs text-cockpit-attention-text/70 hover:text-cockpit-attention-text/90 transition-colors"
          >
            <RotateCcw size={12} />
            {t('common:buttons.refresh', { defaultValue: 'Refresh' })}
          </button>
        </div>
      )}
    </div>
  );
};

export default StaleStockPanel;
