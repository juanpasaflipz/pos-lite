import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, AlertTriangle, Loader2, RotateCcw, Trash2 } from 'lucide-react';
import {
  getInventoryResetPreview,
  resetInventory,
  InventoryResetMode,
  InventoryResetPreview,
} from '../../api';

interface Props {
  open: boolean;
  isAdmin: boolean;
  onClose: () => void;
  onReset: () => void;
}

export default function InventoryResetModal({ open, isAdmin, onClose, onReset }: Props) {
  const { t } = useTranslation('inventory');
  const [mode, setMode] = useState<InventoryResetMode>('zero');
  const [confirmText, setConfirmText] = useState('');
  const [preview, setPreview] = useState<InventoryResetPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirmWord = t('reset.confirmWord');

  // Fresh state + fresh numbers every time the modal opens — a stale preview
  // on a destructive dialog is worse than no preview.
  useEffect(() => {
    if (!open) return;
    setMode('zero');
    setConfirmText('');
    setError(null);
    setPreview(null);
    setPreviewLoading(true);
    getInventoryResetPreview()
      .then(setPreview)
      .catch((err) => setError(err instanceof Error ? err.message : t('reset.failed')))
      .finally(() => setPreviewLoading(false));
  }, [open, t]);

  if (!open) return null;

  const confirmed = confirmText.trim().toUpperCase() === confirmWord.toUpperCase();
  const canSubmit = confirmed && !submitting && !(mode === 'wipe' && !isAdmin);

  const handleSubmit = async () => {
    if (!canSubmit) return;
    try {
      setSubmitting(true);
      setError(null);
      await resetInventory(mode, confirmWord);
      onReset();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('reset.failed'));
    } finally {
      setSubmitting(false);
    }
  };

  const modeOption = (
    value: InventoryResetMode,
    icon: React.ReactNode,
    title: string,
    description: string,
    disabled = false
  ) => (
    <button
      type="button"
      onClick={() => !disabled && setMode(value)}
      disabled={disabled}
      className={`w-full text-left p-4 rounded-lg border transition-colors min-h-[40px] ${
        mode === value
          ? 'border-brand-500 bg-brand-900/20'
          : 'border-neutral-800 bg-neutral-950 hover:border-neutral-700'
      } ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
    >
      <div className="flex items-start gap-3">
        <span className={mode === value ? 'text-brand-400' : 'text-neutral-500'}>{icon}</span>
        <div>
          <p className="text-white font-semibold text-sm">{title}</p>
          <p className="text-neutral-400 text-xs mt-1 leading-relaxed">{description}</p>
        </div>
      </div>
    </button>
  );

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
      <div className="w-full max-w-lg max-h-[90vh] bg-neutral-900 border border-neutral-800 rounded-lg shadow-2xl flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-neutral-800">
          <div className="flex items-center gap-2">
            <AlertTriangle size={20} className="text-brand-400" />
            <h2 className="text-white font-bold">{t('reset.title')}</h2>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-neutral-400 hover:text-white rounded-lg hover:bg-neutral-800"
          >
            <X size={20} />
          </button>
        </div>

        <div className="p-4 overflow-y-auto space-y-4">
          <p className="text-neutral-300 text-sm">{t('reset.intro')}</p>

          <div className="space-y-2">
            {modeOption(
              'zero',
              <RotateCcw size={18} />,
              t('reset.modes.zero.title'),
              t('reset.modes.zero.description')
            )}
            {modeOption(
              'wipe',
              <Trash2 size={18} />,
              t('reset.modes.wipe.title'),
              isAdmin ? t('reset.modes.wipe.description') : t('reset.modes.wipe.adminOnly'),
              !isAdmin
            )}
          </div>

          <div className="bg-neutral-950 border border-neutral-800 rounded-lg p-3 text-sm">
            {previewLoading ? (
              <span className="text-neutral-500 flex items-center gap-2">
                <Loader2 size={14} className="animate-spin" />
                {t('reset.loadingPreview')}
              </span>
            ) : preview ? (
              <ul className="space-y-1 text-neutral-300">
                {mode === 'zero' ? (
                  <>
                    <li>{t('reset.preview.zeroItems', { count: preview.items_with_stock })}</li>
                    <li>{t('reset.preview.history', { count: preview.history_rows })}</li>
                    <li className="text-neutral-500">{t('reset.preview.keepsCatalog')}</li>
                  </>
                ) : (
                  <>
                    <li>{t('reset.preview.wipeItems', { count: preview.inventory_items })}</li>
                    <li>{t('reset.preview.history', { count: preview.history_rows })}</li>
                    <li className="text-brand-300">
                      {t('reset.preview.recipes', { count: preview.recipe_links })}
                    </li>
                  </>
                )}
              </ul>
            ) : (
              <span className="text-neutral-500">{t('reset.preview.unavailable')}</span>
            )}
          </div>

          <div>
            <label className="block text-neutral-400 text-xs mb-2">
              {t('reset.confirmLabel', { word: confirmWord })}
            </label>
            <input
              type="text"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              autoComplete="off"
              className="w-full px-3 py-2 min-h-[40px] bg-neutral-950 border border-neutral-800 rounded-lg text-white uppercase tracking-widest focus:outline-none focus:border-brand-500"
              placeholder={confirmWord}
            />
          </div>

          {error && (
            <div className="bg-brand-900/30 border border-brand-800 rounded-lg p-3">
              <p className="text-brand-300 text-sm">{error}</p>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 p-4 border-t border-neutral-800">
          <button
            onClick={onClose}
            className="px-4 py-2 min-h-[40px] text-neutral-300 hover:text-white rounded-lg hover:bg-neutral-800 text-sm"
          >
            {t('reset.cancel')}
          </button>
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="px-4 py-2 min-h-[40px] bg-brand-600 hover:bg-brand-500 disabled:bg-neutral-800 disabled:text-neutral-500 text-white rounded-lg text-sm font-semibold flex items-center gap-2"
          >
            {submitting && <Loader2 size={16} className="animate-spin" />}
            {submitting
              ? t('reset.working')
              : mode === 'zero'
                ? t('reset.confirmZero')
                : t('reset.confirmWipe')}
          </button>
        </div>
      </div>
    </div>
  );
}
