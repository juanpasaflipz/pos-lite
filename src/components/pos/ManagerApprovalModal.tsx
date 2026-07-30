import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Lock } from 'lucide-react';
import { managerApprove } from '../../api';

export interface ManagerApprovalResult {
  employee_id: number;
  employee_name: string;
  /** One-shot signed approval for routes that accept X-Approval-Token. */
  approval_token: string;
}

interface ManagerApprovalModalProps {
  permission: string;
  title?: string;
  message?: string;
  onApproved: (result: ManagerApprovalResult) => void;
  onClose: () => void;
}

const ManagerApprovalModal: React.FC<ManagerApprovalModalProps> = ({
  permission,
  title,
  message,
  onApproved,
  onClose,
}) => {
  const { t } = useTranslation('pos');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!pin || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await managerApprove(pin, permission);
      onApproved({
        employee_id: result.employee_id,
        employee_name: result.employee_name,
        approval_token: result.approval_token,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('managerApproval.invalidPin');
      setError(msg);
      setPin('');
    } finally {
      setSubmitting(false);
    }
  };

  const append = (digit: string) => setPin((p) => (p.length < 8 ? p + digit : p));
  const backspace = () => setPin((p) => p.slice(0, -1));

  // Portaled at z-70: this pad is always the top layer, and it can be raised
  // from inside another portaled modal (the receipt's Facturar flow), where an
  // in-tree z-60 would land underneath whichever overlay mounted last.
  return createPortal(
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[70] p-4">
      <div className="bg-neutral-900 rounded-2xl shadow-2xl w-full max-w-sm border border-neutral-800">
        <div className="bg-cockpit-yellow text-neutral-900 p-5 rounded-t-2xl flex items-center gap-3">
          <Lock className="w-5 h-5" />
          <div>
            <h2 className="text-lg font-bold">{title || t('managerApproval.title')}</h2>
            <p className="text-cockpit-attention-text text-xs">{message || t('managerApproval.subtitle')}</p>
          </div>
        </div>
        <div className="p-5 space-y-4">
          <div className="flex justify-center gap-2">
            {Array.from({ length: Math.max(4, pin.length) }).map((_, i) => (
              <div
                key={i}
                className={`w-3 h-3 rounded-full ${i < pin.length ? 'bg-cockpit-yellow' : 'bg-neutral-700'}`}
              />
            ))}
          </div>
          {error && (
            <p className="text-cockpit-out-text text-sm text-center">{error}</p>
          )}
          <div className="grid grid-cols-3 gap-2">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
              <button
                key={d}
                onClick={() => append(d)}
                disabled={submitting}
                className="py-4 bg-neutral-800 text-white text-xl font-bold rounded-lg hover:bg-neutral-700 disabled:opacity-50 transition-all touch-manipulation"
              >
                {d}
              </button>
            ))}
            <button
              onClick={backspace}
              disabled={submitting || !pin.length}
              className="py-4 bg-neutral-800 text-white text-sm font-bold rounded-lg hover:bg-neutral-700 disabled:opacity-30 transition-all touch-manipulation"
            >
              {t('managerApproval.delete')}
            </button>
            <button
              onClick={() => append('0')}
              disabled={submitting}
              className="py-4 bg-neutral-800 text-white text-xl font-bold rounded-lg hover:bg-neutral-700 disabled:opacity-50 transition-all touch-manipulation"
            >
              0
            </button>
            <button
              onClick={submit}
              disabled={submitting || !pin}
              className="py-4 bg-cockpit-yellow text-neutral-900 text-sm font-bold rounded-lg hover:bg-cockpit-yellow/90 disabled:opacity-50 transition-all touch-manipulation"
            >
              {submitting ? '…' : t('managerApproval.approve')}
            </button>
          </div>
          <button
            onClick={onClose}
            className="w-full py-3 bg-neutral-700 text-white text-sm font-semibold rounded-lg hover:bg-neutral-600 transition-all"
          >
            {t('common:buttons.cancel')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default ManagerApprovalModal;
