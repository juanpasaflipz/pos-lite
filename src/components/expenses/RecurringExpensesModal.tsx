import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2, X, Repeat, AlertTriangle } from 'lucide-react';
import {
  createRecurringExpense,
  deleteRecurringExpense,
  getRecurringExpenses,
  updateRecurringExpense,
  type RecurringExpense,
} from '../../api';
import { formatPrice } from '../../utils/currency';
import { useToast } from '../../context/ToastContext';

interface Props {
  onClose: () => void;
}

const CATEGORY_KEYS = ['utilities', 'rent', 'marketing', 'supplies', 'food_cost', 'other'] as const;
const FREQUENCIES = ['weekly', 'biweekly', 'monthly', 'bimonthly', 'quarterly', 'annual'] as const;

interface DraftRule {
  id?: number;
  label: string;
  category: string;
  expected_amount: string;
  variance_threshold_pct: string;
  frequency: typeof FREQUENCIES[number];
  payee: string;
  notes: string;
}

const blankDraft = (): DraftRule => ({
  label: '',
  category: 'utilities',
  expected_amount: '',
  variance_threshold_pct: '10',
  frequency: 'monthly',
  payee: '',
  notes: '',
});

const RecurringExpensesModal: React.FC<Props> = ({ onClose }) => {
  const { t } = useTranslation('admin');
  const { addToast } = useToast();
  const [rules, setRules] = useState<RecurringExpense[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<DraftRule | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRules(await getRecurringExpenses());
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const startEdit = (rule: RecurringExpense) => {
    setEditing({
      id: rule.id,
      label: rule.label,
      category: rule.category,
      expected_amount: String(rule.expected_amount),
      variance_threshold_pct: String(rule.variance_threshold_pct),
      frequency: rule.frequency,
      payee: rule.payee || '',
      notes: rule.notes || '',
    });
  };

  const handleSave = async () => {
    if (!editing) return;
    const expected = Number(editing.expected_amount);
    if (!editing.label.trim() || !expected || expected <= 0) return;
    setSaving(true);
    try {
      const payload = {
        label: editing.label.trim(),
        category: editing.category,
        expected_amount: expected,
        variance_threshold_pct: Number(editing.variance_threshold_pct) || 10,
        frequency: editing.frequency,
        payee: editing.payee.trim() || null,
        notes: editing.notes.trim() || null,
      } as Partial<RecurringExpense>;
      if (editing.id) {
        await updateRecurringExpense(editing.id, payload);
      } else {
        await createRecurringExpense(payload);
      }
      setEditing(null);
      await load();
      addToast(t('expenses.recurringSaved', { defaultValue: 'Recurring expense saved' }), 'success');
    } catch (err) {
      addToast(
        err instanceof Error ? err.message : t('expenses.recurringSaveFailed', { defaultValue: 'Save failed' }),
        'error'
      );
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm(t('expenses.recurringDeleteConfirm', { defaultValue: 'Remove this recurring expense?' }))) return;
    try {
      await deleteRecurringExpense(id);
      await load();
    } catch (err) {
      addToast(
        err instanceof Error ? err.message : t('expenses.recurringDeleteFailed', { defaultValue: 'Delete failed' }),
        'error'
      );
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="bg-neutral-900 rounded-xl border border-neutral-800 w-full max-w-2xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-neutral-800">
          <div className="flex items-center gap-2">
            <Repeat size={18} className="text-brand-400" />
            <h2 className="text-lg font-bold text-white">
              {t('expenses.recurringTitle', { defaultValue: 'Recurring Expenses' })}
            </h2>
          </div>
          <button onClick={onClose} className="p-1 text-neutral-400 hover:text-white">
            <X size={20} />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <p className="text-sm text-neutral-400">
            {t('expenses.recurringHint', {
              defaultValue: 'Track fixed bills (rent, utilities, internet) so the system can alert when an amount drifts outside the expected range.',
            })}
          </p>

          {editing ? (
            <div className="rounded-xl border border-brand-700/50 bg-brand-950/30 p-4 space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs uppercase tracking-wider text-neutral-500 mb-1">
                    {t('expenses.recurringLabel', { defaultValue: 'Label' })}
                  </label>
                  <input
                    type="text"
                    autoFocus
                    placeholder="Internet — Telmex"
                    value={editing.label}
                    onChange={(e) => setEditing({ ...editing, label: e.target.value })}
                    className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-white placeholder-neutral-500 focus:border-brand-500 focus:outline-none min-h-[40px]"
                  />
                </div>
                <div>
                  <label className="block text-xs uppercase tracking-wider text-neutral-500 mb-1">
                    {t('expenses.category')}
                  </label>
                  <select
                    value={editing.category}
                    onChange={(e) => setEditing({ ...editing, category: e.target.value })}
                    className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-white focus:border-brand-500 focus:outline-none min-h-[40px]"
                  >
                    {CATEGORY_KEYS.map((k) => (
                      <option key={k} value={k}>{t(`expenses.categories.${k}`)}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs uppercase tracking-wider text-neutral-500 mb-1">
                    {t('expenses.recurringExpected', { defaultValue: 'Expected amount' })}
                  </label>
                  <input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="0.01"
                    value={editing.expected_amount}
                    onChange={(e) => setEditing({ ...editing, expected_amount: e.target.value })}
                    className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-white focus:border-brand-500 focus:outline-none min-h-[40px]"
                  />
                </div>
                <div>
                  <label className="block text-xs uppercase tracking-wider text-neutral-500 mb-1">
                    {t('expenses.recurringVariance', { defaultValue: 'Alert if off by (%)' })}
                  </label>
                  <input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    max={100}
                    step="1"
                    value={editing.variance_threshold_pct}
                    onChange={(e) => setEditing({ ...editing, variance_threshold_pct: e.target.value })}
                    className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-white focus:border-brand-500 focus:outline-none min-h-[40px]"
                  />
                </div>
                <div>
                  <label className="block text-xs uppercase tracking-wider text-neutral-500 mb-1">
                    {t('expenses.recurringFrequency', { defaultValue: 'Frequency' })}
                  </label>
                  <select
                    value={editing.frequency}
                    onChange={(e) => setEditing({ ...editing, frequency: e.target.value as DraftRule['frequency'] })}
                    className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-white focus:border-brand-500 focus:outline-none min-h-[40px]"
                  >
                    {FREQUENCIES.map((f) => (
                      <option key={f} value={f}>
                        {t(`expenses.frequencies.${f}`, { defaultValue: f })}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs uppercase tracking-wider text-neutral-500 mb-1">
                    {t('expenses.payee')}
                  </label>
                  <input
                    type="text"
                    placeholder={t('expenses.payeePlaceholder')}
                    value={editing.payee}
                    onChange={(e) => setEditing({ ...editing, payee: e.target.value })}
                    className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-white placeholder-neutral-500 focus:border-brand-500 focus:outline-none min-h-[40px]"
                  />
                </div>
              </div>

              <div className="flex gap-2 pt-1">
                <button
                  onClick={() => setEditing(null)}
                  className="flex-1 py-2 bg-neutral-800 text-white font-semibold rounded-lg hover:bg-neutral-700 transition-colors"
                >
                  {t('common:buttons.cancel')}
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving || !editing.label.trim() || !editing.expected_amount}
                  className="flex-1 py-2 bg-brand-600 text-white font-semibold rounded-lg hover:bg-brand-700 transition-colors disabled:opacity-50"
                >
                  {saving ? t('common:states.loading') : t('common:buttons.save')}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setEditing(blankDraft())}
              className="w-full flex items-center justify-center gap-1.5 py-2.5 bg-neutral-800 hover:bg-neutral-700 text-white font-semibold rounded-lg transition-colors min-h-[40px]"
            >
              <Plus size={16} />
              {t('expenses.addRecurring', { defaultValue: 'Add recurring expense' })}
            </button>
          )}

          <div className="space-y-2 pt-2">
            {loading ? (
              <div className="text-center text-neutral-500 text-sm py-6">
                {t('common:states.loading')}
              </div>
            ) : rules.length === 0 ? (
              <div className="text-center text-neutral-500 text-sm py-6 border border-dashed border-neutral-800 rounded-xl">
                {t('expenses.noRecurring', { defaultValue: 'No recurring expenses configured yet.' })}
              </div>
            ) : (
              rules.map((rule) => (
                <RecurringRow
                  key={rule.id}
                  rule={rule}
                  onEdit={() => startEdit(rule)}
                  onDelete={() => handleDelete(rule.id)}
                />
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

interface RowProps {
  rule: RecurringExpense;
  onEdit: () => void;
  onDelete: () => void;
}

const RecurringRow: React.FC<RowProps> = ({ rule, onEdit, onDelete }) => {
  const { t } = useTranslation('admin');
  return (
    <div className={`flex items-center justify-between gap-3 rounded-xl border p-3 ${
      rule.active
        ? 'border-neutral-800 bg-neutral-950'
        : 'border-neutral-900 bg-neutral-950/40 opacity-60'
    }`}>
      <button onClick={onEdit} className="flex-1 text-left min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-white font-medium truncate">{rule.label}</span>
          {!rule.active && (
            <span className="text-[10px] uppercase tracking-wider text-neutral-500">
              {t('expenses.inactive', { defaultValue: 'inactive' })}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-neutral-400">
          <span>{t(`expenses.categories.${rule.category}`, rule.category)}</span>
          <span className="text-neutral-600">·</span>
          <span>{formatPrice(rule.expected_amount)} / {t(`expenses.frequencies.${rule.frequency}`, { defaultValue: rule.frequency })}</span>
          <span className="text-neutral-600">·</span>
          <span className="flex items-center gap-0.5">
            <AlertTriangle size={11} className="text-cockpit-yellow" />
            ±{rule.variance_threshold_pct}%
          </span>
        </div>
      </button>
      <button
        onClick={onDelete}
        className="p-2 text-neutral-500 hover:text-cockpit-red/90 transition-colors"
        aria-label={t('common:buttons.delete', { defaultValue: 'Delete' })}
      >
        <Trash2 size={14} />
      </button>
    </div>
  );
};

export default RecurringExpensesModal;
