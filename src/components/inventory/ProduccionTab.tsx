import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChefHat, Loader2, Minus, Plus, Trash2, X } from 'lucide-react';
import { createPrepRun, getPrepRuns } from '../../api';
import type { InventoryItem, PrepRun } from '../../types';

// Producción — logging a prep run: what came out of the walk-in, what went
// onto the line.
//
// Deliberately owns its own state instead of hoisting to InventoryScreen the
// way the other tabs do. The screen is already ~1100 lines with every tab's
// state in it, and a two-section builder with add/remove rows would push it
// past readable. AIInsightsTab is the precedent for a self-contained tab.
//
// Sized for the phone in a cook's hand: single column, ≥40px touch targets,
// whole-portion steppers rather than free-text where it matters.

interface ProduccionTabProps {
  items: InventoryItem[];
  onStockChanged: () => void;
}

interface DraftLine {
  key: string;
  inventoryItemId: number | '';
  amount: string;
}

let lineSeq = 0;
const newLine = (): DraftLine => ({ key: `l${++lineSeq}`, inventoryItemId: '', amount: '' });

export default function ProduccionTab({ items, onStockChanged }: ProduccionTabProps) {
  const { t } = useTranslation('inventory');

  const [inputs, setInputs] = useState<DraftLine[]>([]);
  const [outputs, setOutputs] = useState<DraftLine[]>([newLine()]);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runs, setRuns] = useState<PrepRun[]>([]);
  const [loadingRuns, setLoadingRuns] = useState(true);

  const rawItems = useMemo(() => items.filter((i) => i.kind === 'raw'), [items]);
  const componentItems = useMemo(() => items.filter((i) => i.kind === 'component'), [items]);
  const itemsById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);

  const loadRuns = useCallback(async () => {
    setLoadingRuns(true);
    try {
      const res = await getPrepRuns(20);
      setRuns(res.runs);
    } catch {
      setRuns([]);
    } finally {
      setLoadingRuns(false);
    }
  }, []);

  useEffect(() => { loadRuns(); }, [loadRuns]);

  const updateLine = (
    setter: React.Dispatch<React.SetStateAction<DraftLine[]>>,
    key: string,
    patch: Partial<DraftLine>
  ) => setter((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const removeLine = (
    setter: React.Dispatch<React.SetStateAction<DraftLine[]>>,
    key: string
  ) => setter((prev) => prev.filter((l) => l.key !== key));

  const filledOutputs = outputs.filter((l) => l.inventoryItemId !== '' && Number(l.amount) > 0);
  const canSave = filledOutputs.length > 0 && !saving;

  const handleSave = async () => {
    setError(null);
    const payloadOutputs = filledOutputs.map((l) => ({
      inventory_item_id: Number(l.inventoryItemId),
      portions: Number(l.amount),
    }));
    const payloadInputs = inputs
      .filter((l) => l.inventoryItemId !== '' && Number(l.amount) > 0)
      .map((l) => ({
        inventory_item_id: Number(l.inventoryItemId),
        quantity: Number(l.amount),
      }));

    setSaving(true);
    try {
      await createPrepRun({
        inputs: payloadInputs.length ? payloadInputs : undefined,
        outputs: payloadOutputs,
        notes: notes.trim() || undefined,
      });
      setInputs([]);
      setOutputs([newLine()]);
      setNotes('');
      await loadRuns();
      onStockChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('prep.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const renderLineRows = (
    lines: DraftLine[],
    setter: React.Dispatch<React.SetStateAction<DraftLine[]>>,
    options: InventoryItem[],
    variant: 'input' | 'output'
  ) => (
    <div className="space-y-2">
      {lines.map((line) => {
        const selected = line.inventoryItemId === '' ? null : itemsById.get(Number(line.inventoryItemId));
        return (
          <div key={line.key} className="flex items-center gap-2">
            <select
              value={line.inventoryItemId}
              onChange={(e) => updateLine(setter, line.key, {
                inventoryItemId: e.target.value === '' ? '' : Number(e.target.value),
              })}
              className="flex-1 min-h-[44px] px-3 rounded-lg bg-neutral-800 border border-neutral-700 text-white text-sm"
            >
              <option value="">
                {variant === 'input' ? t('prep.pickRaw') : t('prep.pickComponent')}
              </option>
              {options.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}{item.unit ? ` (${item.unit})` : ''}
                </option>
              ))}
            </select>

            {variant === 'output' ? (
              // Whole portions only in v1 — the stepper makes that the obvious
              // interaction rather than something to enforce with validation.
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  aria-label={t('prep.decrement')}
                  onClick={() => updateLine(setter, line.key, {
                    amount: String(Math.max(0, (Number(line.amount) || 0) - 1)),
                  })}
                  className="min-w-[44px] min-h-[44px] rounded-lg bg-neutral-800 border border-neutral-700 text-white flex items-center justify-center"
                >
                  <Minus size={16} />
                </button>
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  step={1}
                  value={line.amount}
                  onChange={(e) => updateLine(setter, line.key, { amount: e.target.value })}
                  className="w-16 min-h-[44px] px-2 rounded-lg bg-neutral-800 border border-neutral-700 text-white text-center text-sm"
                />
                <button
                  type="button"
                  aria-label={t('prep.increment')}
                  onClick={() => updateLine(setter, line.key, {
                    amount: String((Number(line.amount) || 0) + 1),
                  })}
                  className="min-w-[44px] min-h-[44px] rounded-lg bg-neutral-800 border border-neutral-700 text-white flex items-center justify-center"
                >
                  <Plus size={16} />
                </button>
              </div>
            ) : (
              <input
                type="number"
                inputMode="decimal"
                min={0}
                step="any"
                placeholder={selected?.unit || t('prep.qty')}
                value={line.amount}
                onChange={(e) => updateLine(setter, line.key, { amount: e.target.value })}
                className="w-24 min-h-[44px] px-2 rounded-lg bg-neutral-800 border border-neutral-700 text-white text-center text-sm"
              />
            )}

            <button
              type="button"
              aria-label={t('prep.removeLine')}
              onClick={() => removeLine(setter, line.key)}
              className="min-w-[44px] min-h-[44px] rounded-lg text-neutral-400 hover:text-red-400 flex items-center justify-center"
            >
              <X size={18} />
            </button>
          </div>
        );
      })}
    </div>
  );

  if (!componentItems.length) {
    return (
      <div className="text-center py-16 px-6">
        <ChefHat size={40} className="mx-auto text-neutral-600 mb-3" />
        <p className="text-neutral-300 font-medium">{t('prep.noComponentsTitle')}</p>
        <p className="text-neutral-500 text-sm mt-1 max-w-md mx-auto">{t('prep.noComponentsHint')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="bg-neutral-900 rounded-xl border border-neutral-800 p-4 space-y-5">
        {/* Sacamos — optional. Skipping it still records production; it only
            costs the yield % and cost-per-portion this run would have bought. */}
        <div>
          <div className="flex items-baseline justify-between mb-2">
            <h3 className="text-white font-semibold">{t('prep.sacamos')}</h3>
            <span className="text-xs text-neutral-500">{t('prep.optional')}</span>
          </div>
          <p className="text-xs text-neutral-500 mb-3">{t('prep.sacamosHint')}</p>
          {renderLineRows(inputs, setInputs, rawItems, 'input')}
          <button
            type="button"
            onClick={() => setInputs((prev) => [...prev, newLine()])}
            className="mt-2 min-h-[44px] px-3 rounded-lg text-sm text-brand-400 hover:text-brand-300 flex items-center gap-1"
          >
            <Plus size={16} /> {t('prep.addInput')}
          </button>
        </div>

        <div className="border-t border-neutral-800 pt-4">
          <div className="flex items-baseline justify-between mb-2">
            <h3 className="text-white font-semibold">{t('prep.salio')}</h3>
            <span className="text-xs text-brand-400">{t('prep.required')}</span>
          </div>
          <p className="text-xs text-neutral-500 mb-3">{t('prep.salioHint')}</p>
          {renderLineRows(outputs, setOutputs, componentItems, 'output')}
          <button
            type="button"
            onClick={() => setOutputs((prev) => [...prev, newLine()])}
            className="mt-2 min-h-[44px] px-3 rounded-lg text-sm text-brand-400 hover:text-brand-300 flex items-center gap-1"
          >
            <Plus size={16} /> {t('prep.addOutput')}
          </button>
        </div>

        <div className="border-t border-neutral-800 pt-4">
          <input
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={t('prep.notesPlaceholder')}
            className="w-full min-h-[44px] px-3 rounded-lg bg-neutral-800 border border-neutral-700 text-white text-sm"
          />
        </div>

        {error && (
          <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
            {error}
          </div>
        )}

        <button
          type="button"
          disabled={!canSave}
          onClick={handleSave}
          className="w-full min-h-[48px] rounded-xl bg-brand-600 hover:bg-brand-500 disabled:bg-neutral-700 disabled:text-neutral-500 text-white font-semibold flex items-center justify-center gap-2"
        >
          {saving ? <Loader2 size={18} className="animate-spin" /> : <ChefHat size={18} />}
          {t('prep.save')}
        </button>
      </div>

      <div>
        <h3 className="text-white font-semibold mb-3">{t('prep.recentRuns')}</h3>
        {loadingRuns ? (
          <div className="flex justify-center py-8">
            <Loader2 size={24} className="animate-spin text-neutral-500" />
          </div>
        ) : runs.length === 0 ? (
          <p className="text-neutral-500 text-sm py-6 text-center">{t('prep.noRuns')}</p>
        ) : (
          <div className="space-y-2">
            {runs.map((run) => (
              <div key={run.id} className="bg-neutral-900 rounded-lg border border-neutral-800 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-white text-sm font-medium truncate">
                      {run.outputs.map((o) => `${o.portions} ${o.name}`).join(' · ') || '—'}
                    </p>
                    {run.inputs.length > 0 && (
                      <p className="text-neutral-500 text-xs mt-0.5 truncate">
                        {t('prep.from')} {run.inputs.map((i) => `${i.quantity} ${i.unit || ''} ${i.name}`.trim()).join(' · ')}
                      </p>
                    )}
                    <p className="text-neutral-600 text-xs mt-1">
                      {new Date(run.prepped_at).toLocaleString()}
                      {run.employee_name ? ` · ${run.employee_name}` : ''}
                    </p>
                    {run.notes && <p className="text-neutral-500 text-xs mt-1 italic">{run.notes}</p>}
                  </div>
                  {run.cost_per_portion != null && (
                    <div className="text-right shrink-0">
                      <p className="text-brand-400 text-sm font-semibold">
                        ${run.cost_per_portion.toFixed(2)}
                      </p>
                      <p className="text-neutral-600 text-xs">{t('prep.perPortion')}</p>
                    </div>
                  )}
                </div>
                {run.corrections.length > 0 && (
                  <div className="mt-2 pt-2 border-t border-neutral-800 flex items-center gap-1.5 text-xs text-amber-400">
                    <Trash2 size={12} />
                    {t('prep.correctedBy', {
                      delta: run.corrections.map((c) => `${c.delta > 0 ? '+' : ''}${c.delta} ${c.name}`).join(', '),
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
