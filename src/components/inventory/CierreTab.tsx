import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Moon, Trash2 } from 'lucide-react';
import { getEodSummary, discardOnClose, recordInventoryCount, getPortionVariance } from '../../api';
import type { EodComponent, PortionVarianceRow } from '../../types';

// Cierre — the end-of-day count.
//
// The screen exists to ask one question per component: "we think there are N
// left, how many are actually there?" Everything above the input is the
// arithmetic behind that N, shown so the number isn't a black box the kitchen
// is asked to trust.
//
// Entering a different number posts the difference as a count_adjust ledger
// row — that row IS the shrinkage, and it's what the variance table below
// reads back. Perishables flagged discard_on_close get a one-tap Tirar instead,
// which books the loss under its own reason so a planned nightly discard never
// masquerades as missing stock.

interface CierreTabProps {
  onStockChanged: () => void;
}

export default function CierreTab({ onStockChanged }: CierreTabProps) {
  const { t } = useTranslation('inventory');
  const [rows, setRows] = useState<EodComponent[]>([]);
  const [counts, setCounts] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [variance, setVariance] = useState<PortionVarianceRow[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [summary, varianceRes] = await Promise.all([
        getEodSummary(),
        getPortionVariance(7).catch(() => ({ rows: [] as PortionVarianceRow[] })),
      ]);
      setRows(summary.components);
      setCounts({});
      setVariance(varianceRes.rows || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('cierre.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { load(); }, [load]);

  const handleCount = async (row: EodComponent) => {
    const raw = counts[row.inventory_item_id];
    if (raw == null || raw.trim() === '') return;
    const counted = Number(raw);
    if (!Number.isFinite(counted) || counted < 0) return;

    setBusyId(row.inventory_item_id);
    setError(null);
    try {
      await recordInventoryCount(row.inventory_item_id, { counted_quantity: counted });
      await load();
      onStockChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('cierre.countFailed'));
    } finally {
      setBusyId(null);
    }
  };

  const handleDiscard = async (row: EodComponent) => {
    if (!window.confirm(t('cierre.confirmDiscard', { name: row.name, n: row.current }))) return;
    setBusyId(row.inventory_item_id);
    setError(null);
    try {
      await discardOnClose(row.inventory_item_id);
      await load();
      onStockChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('cierre.discardFailed'));
    } finally {
      setBusyId(null);
    }
  };

  const missing = useMemo(
    () => variance.filter((v) => v.variance < 0).slice(0, 8),
    [variance]
  );

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 size={28} className="animate-spin text-neutral-500" />
      </div>
    );
  }

  if (!rows.length) {
    return (
      <div className="text-center py-16 px-6">
        <Moon size={40} className="mx-auto text-neutral-600 mb-3" />
        <p className="text-neutral-300 font-medium">{t('cierre.noComponents')}</p>
        <p className="text-neutral-500 text-sm mt-1">{t('cierre.noComponentsHint')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
          {error}
        </div>
      )}

      <div className="space-y-2">
        {rows.map((row) => {
          const entered = counts[row.inventory_item_id] ?? '';
          const diff = entered.trim() === '' ? null : Number(entered) - row.expected;
          return (
            <div
              key={row.inventory_item_id}
              className="bg-neutral-900 border border-neutral-800 rounded-lg p-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-white font-medium truncate">{row.name}</p>
                  {/* The arithmetic behind "expected", so the count isn't a
                      number the kitchen is asked to take on faith. */}
                  <p className="text-neutral-500 text-xs mt-0.5">
                    {t('cierre.breakdown', {
                      carryover: row.carryover,
                      produced: row.produced,
                      sold: row.sold,
                      waste: row.waste,
                    })}
                  </p>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-neutral-400 text-xs">{t('cierre.expected')}</p>
                  <p className="text-white font-semibold text-lg">{row.expected}</p>
                </div>
              </div>

              <div className="flex items-center gap-2 mt-3">
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  step={1}
                  placeholder={t('cierre.actual')}
                  value={entered}
                  onChange={(e) => setCounts((prev) => ({
                    ...prev, [row.inventory_item_id]: e.target.value,
                  }))}
                  className="w-24 min-h-[44px] px-2 rounded-lg bg-neutral-800 border border-neutral-700 text-white text-center"
                />
                <button
                  type="button"
                  disabled={busyId === row.inventory_item_id || entered.trim() === ''}
                  onClick={() => handleCount(row)}
                  className="min-h-[44px] px-4 rounded-lg bg-brand-600 hover:bg-brand-500 disabled:bg-neutral-800 disabled:text-neutral-500 text-white text-sm font-semibold"
                >
                  {t('cierre.save')}
                </button>

                {diff != null && diff !== 0 && (
                  <span className={`text-sm font-semibold ${diff < 0 ? 'text-red-400' : 'text-cockpit-in-text'}`}>
                    {diff > 0 ? '+' : ''}{diff}
                  </span>
                )}

                {row.discard_on_close && row.current > 0 && (
                  <button
                    type="button"
                    disabled={busyId === row.inventory_item_id}
                    onClick={() => handleDiscard(row)}
                    className="ml-auto min-h-[44px] px-3 rounded-lg border border-neutral-700 text-neutral-300 hover:text-red-400 hover:border-red-500/50 text-sm flex items-center gap-1.5"
                  >
                    <Trash2 size={14} /> {t('cierre.discard')}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {missing.length > 0 && (
        <div>
          <h3 className="text-white font-semibold mb-2">{t('cierre.recentVariance')}</h3>
          <div className="bg-neutral-900 border border-neutral-800 rounded-lg divide-y divide-neutral-800">
            {missing.map((v, i) => (
              <div key={`${v.business_date}-${v.inventory_item_id}-${i}`} className="px-3 py-2 flex items-center justify-between">
                <div className="min-w-0">
                  <p className="text-neutral-200 text-sm truncate">{v.name}</p>
                  <p className="text-neutral-600 text-xs">{v.business_date}</p>
                </div>
                <span className="text-red-400 text-sm font-semibold shrink-0">
                  {t('cierre.missing', { n: Math.abs(v.variance) })}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
