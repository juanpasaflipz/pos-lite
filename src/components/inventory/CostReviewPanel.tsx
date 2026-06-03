import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, AlertTriangle, Check } from 'lucide-react';
import {
  getCostReviewCandidates,
  applyCostReviewCorrection,
  CostReviewCandidate,
} from '../../api';

interface Props {
  open: boolean;
  onClose: () => void;
  onApplied?: () => void;
}

// "Costos por revisar" — surfaces SKUs whose cost_price was almost certainly
// set from a line_total instead of line_total/qty. Owner sees stored vs
// proposed per-unit cost, taps Aplicar to correct. Backfill counterpart to
// the unit-mismatch anomaly gate that protects new purchases.
export default function CostReviewPanel({ open, onClose, onApplied }: Props) {
  const { t } = useTranslation('inventory');
  const [candidates, setCandidates] = useState<CostReviewCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        setError(null);
        const data = await getCostReviewCandidates();
        if (!cancelled) setCandidates(data);
      } catch (e: any) {
        if (!cancelled) setError(e?.message || 'Error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open]);

  const handleApply = async (c: CostReviewCandidate) => {
    try {
      setApplying(c.id);
      await applyCostReviewCorrection(c.id, c.proposed_unit_cost);
      setCandidates((prev) => prev.filter((x) => x.id !== c.id));
      onApplied?.();
    } catch (e: any) {
      setError(e?.message || 'Apply failed');
    } finally {
      setApplying(null);
    }
  };

  if (!open) return null;

  const fmt = (n: number) =>
    n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
      <div className="bg-neutral-900 border border-neutral-800 rounded-xl max-w-3xl w-full max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-neutral-800">
          <div className="flex items-center gap-3">
            <AlertTriangle className="text-cockpit-yellow" size={22} />
            <div>
              <h2 className="font-semibold text-white">
                {t('costReview.title', 'Costos por revisar')}
              </h2>
              <p className="text-xs text-neutral-400">
                {t(
                  'costReview.subtitle',
                  'Costos que parecen ser el total pagado, no el precio por unidad.'
                )}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-neutral-400 hover:text-white"
            aria-label={t('costReview.close', 'Cerrar')}
          >
            <X size={20} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {loading && (
            <div className="text-center text-neutral-400 py-8">
              {t('costReview.loading', 'Cargando…')}
            </div>
          )}
          {error && (
            <div className="text-center text-red-400 py-4">{error}</div>
          )}
          {!loading && !error && candidates.length === 0 && (
            <div className="text-center text-neutral-400 py-8">
              {t('costReview.empty', 'Nada por revisar. Todos los costos lucen bien.')}
            </div>
          )}
          {!loading && candidates.length > 0 && (
            <div className="space-y-3">
              {candidates.map((c) => (
                <div
                  key={c.id}
                  className="border border-neutral-800 rounded-lg p-3 flex items-center gap-3"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-white font-medium truncate">{c.name}</div>
                    <div className="text-xs text-neutral-400 mt-1">
                      {t('costReview.context', {
                        defaultValue: '{{qty}} {{unit}} · {{vendor}} · {{date}}',
                        qty: c.quantity_added,
                        unit: c.unit || '',
                        vendor: c.vendor || '—',
                        date: c.expense_date || '',
                      })}
                    </div>
                    <div className="text-xs mt-2 flex items-center gap-3 flex-wrap">
                      <span className="text-red-400">
                        {t('costReview.stored', 'Guardado')}: ${fmt(c.stored_unit_cost)}/{c.unit || 'u'}
                      </span>
                      <span className="text-neutral-500">→</span>
                      <span className="text-green-400">
                        {t('costReview.proposed', 'Propuesto')}: ${fmt(c.proposed_unit_cost)}/{c.unit || 'u'}
                      </span>
                    </div>
                  </div>
                  <button
                    onClick={() => handleApply(c)}
                    disabled={applying === c.id}
                    className="px-3 py-2 bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white text-sm rounded-md flex items-center gap-1.5 flex-shrink-0"
                  >
                    <Check size={14} />
                    {applying === c.id
                      ? t('costReview.applying', 'Aplicando…')
                      : t('costReview.apply', 'Aplicar')}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
