import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { CreditCard, Trash2, Plus } from 'lucide-react';
import {
  getAllExternalTerminals,
  createExternalTerminal,
  updateExternalTerminal,
  deactivateExternalTerminal,
  type ExternalTerminalDto,
} from '../../api';
import { usePlan } from '../../context/PlanContext';

/**
 * External (non-integrated bank) card terminals — Inbursa, BBVA, Banorte...
 * The bank publishes no charge API, so DK only registers the device: its name
 * (shown as a "cobrar en terminal X" button in the POS) and the agreed
 * discount rate (used to ESTIMATE fees in Reports → Comisiones). The cashier
 * still keys the amount into the physical terminal by hand.
 */
const ExternalTerminalsSetup: React.FC = () => {
  const { t } = useTranslation('common');
  const { refresh } = usePlan();
  const [terminals, setTerminals] = useState<ExternalTerminalDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [feePercent, setFeePercent] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const { terminals: list } = await getAllExternalTerminals();
        setTerminals(list);
      } catch {
        // Section renders empty; adding still works
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    const fee = parseFloat(feePercent);
    if (!name.trim() || !Number.isFinite(fee) || fee < 0 || fee > 15) {
      setError(t('account.extTerminals.invalidInput'));
      return;
    }
    setSaving(true);
    setError('');
    try {
      const { terminal } = await createExternalTerminal({ name: name.trim(), fee_percent: fee });
      setTerminals(prev => [...prev, terminal]);
      setName('');
      setFeePercent('');
      setShowForm(false);
      await refresh(); // POS payment modal buttons come from PlanContext
    } catch (err) {
      setError(err instanceof Error ? err.message : t('account.extTerminals.errorSaving'));
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (term: ExternalTerminalDto) => {
    setSaving(true);
    setError('');
    try {
      const { terminal } = await updateExternalTerminal(term.id, { active: !term.active });
      setTerminals(prev => prev.map(x => (x.id === term.id ? terminal : x)));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('account.extTerminals.errorSaving'));
    } finally {
      setSaving(false);
    }
  };

  const handleFeeChange = async (term: ExternalTerminalDto, value: string) => {
    const fee = parseFloat(value);
    if (!Number.isFinite(fee) || fee < 0 || fee > 15 || fee === term.fee_percent) return;
    setSaving(true);
    setError('');
    try {
      const { terminal } = await updateExternalTerminal(term.id, { fee_percent: fee });
      setTerminals(prev => prev.map(x => (x.id === term.id ? terminal : x)));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('account.extTerminals.errorSaving'));
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async (term: ExternalTerminalDto) => {
    setSaving(true);
    setError('');
    try {
      await deactivateExternalTerminal(term.id);
      setTerminals(prev => prev.map(x => (x.id === term.id ? { ...x, active: false } : x)));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('account.extTerminals.errorSaving'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-6">
      <div className="flex items-center gap-3 mb-2">
        <CreditCard className="text-brand-500" size={22} />
        <h2 className="text-lg font-bold text-white">{t('account.extTerminals.title')}</h2>
      </div>
      <p className="text-neutral-400 text-sm mb-4">{t('account.extTerminals.description')}</p>

      {loading ? (
        <p className="text-neutral-500 text-sm">{t('states.loading', 'Cargando...')}</p>
      ) : (
        <div className="space-y-3">
          {terminals.length === 0 && !showForm && (
            <p className="text-neutral-500 text-sm">{t('account.extTerminals.empty')}</p>
          )}

          {terminals.map(term => (
            <div
              key={term.id}
              className={`flex items-center gap-3 bg-neutral-800 rounded-lg p-3 ${term.active ? '' : 'opacity-50'}`}
            >
              <div className="flex-1 min-w-0">
                <p className="text-white font-semibold truncate">{term.name}</p>
                {!term.active && (
                  <p className="text-neutral-500 text-xs">{t('account.extTerminals.inactive')}</p>
                )}
              </div>
              <label className="flex items-center gap-1.5 text-neutral-400 text-sm whitespace-nowrap">
                {t('account.extTerminals.feeLabel')}
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  max="15"
                  defaultValue={term.fee_percent}
                  onBlur={(e) => handleFeeChange(term, e.target.value)}
                  disabled={saving || !term.active}
                  className="w-20 bg-neutral-700 border border-neutral-600 rounded-lg py-1.5 px-2 text-sm text-white text-right focus:outline-none focus:border-brand-600"
                />
                %
              </label>
              {term.active ? (
                <button
                  onClick={() => handleRemove(term)}
                  disabled={saving}
                  className="p-2 text-neutral-500 hover:text-cockpit-out-text transition-colors"
                  title={t('account.extTerminals.deactivate')}
                >
                  <Trash2 size={16} />
                </button>
              ) : (
                <button
                  onClick={() => handleToggleActive(term)}
                  disabled={saving}
                  className="text-xs font-semibold text-brand-500 hover:text-brand-400 transition-colors"
                >
                  {t('account.extTerminals.reactivate')}
                </button>
              )}
            </div>
          ))}

          {showForm ? (
            <form onSubmit={handleAdd} className="bg-neutral-800 rounded-lg p-4 space-y-3">
              <div>
                <label className="block text-neutral-400 text-sm mb-1">{t('account.extTerminals.nameLabel')}</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t('account.extTerminals.namePlaceholder')}
                  maxLength={40}
                  autoFocus
                  className="w-full bg-neutral-700 border border-neutral-600 rounded-lg p-2.5 text-white focus:outline-none focus:border-brand-600"
                />
              </div>
              <div>
                <label className="block text-neutral-400 text-sm mb-1">{t('account.extTerminals.feeInputLabel')}</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  max="15"
                  value={feePercent}
                  onChange={(e) => setFeePercent(e.target.value)}
                  placeholder="1.75"
                  className="w-full bg-neutral-700 border border-neutral-600 rounded-lg p-2.5 text-white focus:outline-none focus:border-brand-600"
                />
                <p className="text-neutral-500 text-xs mt-1">{t('account.extTerminals.feeHint')}</p>
              </div>
              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={saving}
                  className="px-4 py-2 bg-brand-600 text-white text-sm font-semibold rounded-lg hover:bg-brand-700 disabled:opacity-50 transition-colors"
                >
                  {saving ? t('account.extTerminals.saving') : t('account.extTerminals.add')}
                </button>
                <button
                  type="button"
                  onClick={() => { setShowForm(false); setError(''); }}
                  disabled={saving}
                  className="px-4 py-2 bg-neutral-700 text-neutral-300 text-sm font-semibold rounded-lg hover:bg-neutral-600 transition-colors"
                >
                  {t('buttons.cancel')}
                </button>
              </div>
            </form>
          ) : (
            <button
              onClick={() => setShowForm(true)}
              className="flex items-center gap-2 text-brand-500 hover:text-brand-400 text-sm font-semibold transition-colors"
            >
              <Plus size={16} />
              {t('account.extTerminals.addButton')}
            </button>
          )}

          {error && <p className="text-cockpit-out-text text-sm">{error}</p>}
        </div>
      )}
    </div>
  );
};

export default ExternalTerminalsSetup;
