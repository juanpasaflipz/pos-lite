import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ArrowRight, Check, FileText, Loader2, X } from 'lucide-react';
import {
  applyRecipe,
  parseRecipeText,
  previewRecipe,
  type RecipeMatchedLine,
  type RecipePreview,
} from '../../api';
import type { InventoryItem } from '../../types';
import { formatPrice } from '../../utils/currency';

interface Props {
  menuItemId: number;
  menuItemName: string;
  inventory: InventoryItem[];
  onClose: () => void;
  onApplied: () => void;
}

type Step = 'paste' | 'review';

export default function RecipeImporterModal({
  menuItemId,
  menuItemName,
  inventory,
  onClose,
  onApplied,
}: Props) {
  const { t } = useTranslation('inventory');
  const [step, setStep] = useState<Step>('paste');
  const [text, setText] = useState('');
  const [parsing, setParsing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [preview, setPreview] = useState<RecipePreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Editable per-line overrides keyed by index.
  const [overrides, setOverrides] = useState<
    Record<number, { inventory_item_id: number | null; quantity_used: number; include: boolean; alias?: string }>
  >({});

  const handleParse = async () => {
    setError(null);
    setParsing(true);
    try {
      const parsed = await parseRecipeText(menuItemId, text);
      if (!parsed.lines.length) {
        setError(t('recipeImport.noLines', { defaultValue: 'No ingredient lines detected.' }));
        return;
      }
      const previewResult = await previewRecipe(menuItemId, parsed.lines);
      setPreview(previewResult);
      const initial: typeof overrides = {};
      previewResult.matched.forEach((line, idx) => {
        initial[idx] = {
          inventory_item_id: line.match?.inventory_item_id ?? null,
          quantity_used: line.match?.quantity_used ?? line.qty,
          include: Boolean(line.match),
          alias: line.match && line.match.confidence !== 'exact' ? line.name : undefined,
        };
      });
      setOverrides(initial);
      setStep('review');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setParsing(false);
    }
  };

  const handleApply = async () => {
    if (!preview) return;
    setApplying(true);
    setError(null);
    try {
      const ingredients = preview.matched
        .map((_, idx) => overrides[idx])
        .filter((o) => o && o.include && o.inventory_item_id && o.quantity_used > 0)
        .map((o) => ({
          inventory_item_id: o!.inventory_item_id!,
          quantity_used: o!.quantity_used,
          alias: o!.alias,
        }));
      if (ingredients.length === 0) {
        setError(t('recipeImport.noConfirmed', { defaultValue: 'No confirmed ingredients to save.' }));
        return;
      }
      await applyRecipe(menuItemId, ingredients);
      onApplied();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setApplying(false);
    }
  };

  const proposedCost = preview
    ? preview.matched.reduce((sum, line, idx) => {
        const o = overrides[idx];
        if (!o?.include || !o.inventory_item_id) return sum;
        const inv = inventory.find((i) => i.id === o.inventory_item_id);
        return sum + (inv?.cost_price || 0) * o.quantity_used;
      }, 0)
    : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-4xl rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
          <div className="flex items-center gap-3">
            <FileText className="h-5 w-5 text-amber-600" />
            <div>
              <h2 className="text-lg font-semibold text-gray-900">
                {t('recipeImport.title', { defaultValue: 'Import recipe' })}
              </h2>
              <p className="text-xs text-gray-500">{menuItemName}</p>
            </div>
          </div>
          <button onClick={onClose} className="rounded p-1 hover:bg-gray-100">
            <X className="h-5 w-5 text-gray-500" />
          </button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto px-6 py-5">
          {step === 'paste' && (
            <div className="space-y-4">
              <p className="text-sm text-gray-600">
                {t('recipeImport.pasteHint', {
                  defaultValue: 'Paste the recipe text. One ingredient per line — quantities can be in g, kg, ml, l, pcs.',
                })}
              </p>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={10}
                placeholder={`250g picaña\n100g tortilla burrera\n80g queso cheddar\n40g guacamole`}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
              />
              {error && <p className="text-sm text-red-600">{error}</p>}
            </div>
          )}

          {step === 'review' && preview && (
            <div className="space-y-4">
              <SummaryBar preview={preview} proposedCost={proposedCost} />
              <div className="space-y-2">
                {preview.matched.map((line, idx) => (
                  <LineRow
                    key={idx}
                    line={line}
                    override={overrides[idx]}
                    inventory={inventory}
                    onChange={(patch) =>
                      setOverrides((prev) => ({ ...prev, [idx]: { ...prev[idx], ...patch } }))
                    }
                  />
                ))}
              </div>
              {error && <p className="text-sm text-red-600">{error}</p>}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-gray-200 px-6 py-4">
          <button
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100"
          >
            {t('common.cancel', { defaultValue: 'Cancel' })}
          </button>
          {step === 'paste' && (
            <button
              onClick={handleParse}
              disabled={!text.trim() || parsing}
              className="flex items-center gap-2 rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50"
            >
              {parsing ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
              {t('recipeImport.parse', { defaultValue: 'Parse & match' })}
            </button>
          )}
          {step === 'review' && (
            <button
              onClick={handleApply}
              disabled={applying}
              className="flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {applying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              {t('recipeImport.apply', { defaultValue: 'Save recipe' })}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function SummaryBar({ preview, proposedCost }: { preview: RecipePreview; proposedCost: number }) {
  const { t } = useTranslation('inventory');
  const delta = proposedCost - preview.summary.current_total_cost;
  return (
    <div className="grid grid-cols-2 gap-3 rounded-lg bg-gray-50 p-3 text-sm md:grid-cols-4">
      <Stat label={t('recipeImport.proposedCost', { defaultValue: 'Proposed cost' })} value={formatPrice(proposedCost)} />
      <Stat label={t('recipeImport.currentCost', { defaultValue: 'Current cost' })} value={formatPrice(preview.summary.current_total_cost)} />
      <Stat
        label={t('recipeImport.delta', { defaultValue: 'Δ vs current' })}
        value={`${delta >= 0 ? '+' : ''}${formatPrice(delta)}`}
        tone={delta > 0 ? 'warn' : delta < 0 ? 'good' : undefined}
      />
      <Stat
        label={t('recipeImport.warnings', { defaultValue: 'Warnings' })}
        value={String(preview.summary.unmatched_count + preview.summary.unit_mismatch_count + preview.summary.zombie_warning_count)}
        tone={preview.summary.unmatched_count + preview.summary.unit_mismatch_count + preview.summary.zombie_warning_count > 0 ? 'warn' : 'good'}
      />
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'warn' }) {
  const color = tone === 'warn' ? 'text-amber-700' : tone === 'good' ? 'text-emerald-700' : 'text-gray-900';
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-gray-500">{label}</div>
      <div className={`mt-0.5 font-semibold ${color}`}>{value}</div>
    </div>
  );
}

function LineRow({
  line,
  override,
  inventory,
  onChange,
}: {
  line: RecipeMatchedLine;
  override: { inventory_item_id: number | null; quantity_used: number; include: boolean; alias?: string } | undefined;
  inventory: InventoryItem[];
  onChange: (patch: Partial<{ inventory_item_id: number | null; quantity_used: number; include: boolean; alias?: string }>) => void;
}) {
  const include = override?.include ?? false;
  const selectedId = override?.inventory_item_id ?? null;
  const qty = override?.quantity_used ?? line.qty;
  const selected = inventory.find((i) => i.id === selectedId);

  const confidenceTone =
    line.match?.confidence === 'exact'
      ? 'bg-emerald-100 text-emerald-700'
      : line.match?.confidence === 'alias'
      ? 'bg-sky-100 text-sky-700'
      : line.match?.confidence === 'contains'
      ? 'bg-blue-100 text-blue-700'
      : line.match?.confidence === 'fuzzy'
      ? 'bg-amber-100 text-amber-700'
      : 'bg-red-100 text-red-700';

  return (
    <div className={`rounded-lg border p-3 ${include ? 'border-emerald-300 bg-emerald-50/40' : 'border-gray-200 bg-white'}`}>
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={include}
          onChange={(e) => onChange({ include: e.target.checked })}
          className="mt-1 h-4 w-4 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
        />
        <div className="flex-1 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-medium text-gray-900">{line.raw || line.name}</div>
            {line.match && (
              <span className={`rounded px-2 py-0.5 text-xs font-medium ${confidenceTone}`}>
                {line.match.confidence}
              </span>
            )}
            {!line.match && (
              <span className="rounded bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">no match</span>
            )}
          </div>

          <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
            <select
              value={selectedId ?? ''}
              onChange={(e) => onChange({ inventory_item_id: e.target.value ? Number(e.target.value) : null })}
              className="rounded border border-gray-300 px-2 py-1.5 text-sm"
            >
              <option value="">— select inventory item —</option>
              {inventory.map((inv) => (
                <option key={inv.id} value={inv.id}>
                  {inv.name} ({inv.unit}) · stock {inv.quantity ?? 0}
                </option>
              ))}
            </select>
            <div className="flex items-center gap-1">
              <input
                type="number"
                step="0.001"
                value={qty}
                onChange={(e) => onChange({ quantity_used: Number(e.target.value) })}
                className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
              />
              <span className="text-xs text-gray-500">{selected?.unit ?? line.unit}</span>
            </div>
            <div className="text-sm text-gray-700">
              {selected && qty > 0
                ? `${formatPrice((selected.cost_price || 0) * qty)} / unit`
                : '—'}
            </div>
          </div>

          {line.match?.unit_mismatch && (
            <Warning text={`Unit mismatch: parsed ${line.unit || '?'} vs inventory ${line.match.unit}. Confirm the quantity manually.`} />
          )}
          {line.zombie_warning && (
            <Warning
              text={`This ingredient has 0 stock — did you mean "${line.zombie_warning.sibling_name}"?`}
              actionLabel="use sibling"
              onAction={() => onChange({ inventory_item_id: line.zombie_warning!.sibling_id })}
            />
          )}
          {!line.match && line.candidates.length > 0 && (
            <div className="text-xs text-gray-600">
              Closest matches:{' '}
              {line.candidates.map((c) => (
                <button
                  key={c.inventory_item_id}
                  onClick={() => onChange({ inventory_item_id: c.inventory_item_id, include: true })}
                  className="mr-1 rounded bg-gray-100 px-2 py-0.5 hover:bg-gray-200"
                >
                  {c.name} ({c.score})
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Warning({ text, actionLabel, onAction }: { text: string; actionLabel?: string; onAction?: () => void }) {
  return (
    <div className="flex items-center gap-2 rounded bg-amber-50 px-2 py-1 text-xs text-amber-800">
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
      <span className="flex-1">{text}</span>
      {actionLabel && onAction && (
        <button onClick={onAction} className="rounded bg-amber-200 px-2 py-0.5 font-medium hover:bg-amber-300">
          {actionLabel}
        </button>
      )}
    </div>
  );
}
