import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Mail, Check, Loader2, AlertCircle } from 'lucide-react';
import { resendCfdiInvoiceEmail } from '../../api';
import type { CfdiInvoice } from '../../types';

interface ResendEmailModalProps {
  invoice: CfdiInvoice;
  onClose: () => void;
  onResent: (invoice: CfdiInvoice) => void;
}

type State = 'form' | 'sending' | 'success' | 'error';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function ResendEmailModal({ invoice, onClose, onResent }: ResendEmailModalProps) {
  const { t } = useTranslation('pos');
  const [email, setEmail] = useState(invoice.receptor_email || '');
  const [state, setState] = useState<State>('form');
  const [errorMessage, setErrorMessage] = useState('');

  const trimmed = email.trim();
  const isValid = EMAIL_RE.test(trimmed);

  const handleResend = useCallback(async () => {
    setState('sending');
    setErrorMessage('');
    try {
      const updated = await resendCfdiInvoiceEmail(invoice.id, trimmed);
      onResent(updated);
      setState('success');
    } catch (err: any) {
      setErrorMessage(err?.message || t('invoice.resendError'));
      setState('error');
    }
  }, [invoice.id, trimmed, onResent, t]);

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-neutral-900 border border-neutral-700 rounded-2xl shadow-2xl w-full max-w-sm">
        <div className="flex items-center justify-between p-4 border-b border-neutral-700">
          <div className="flex items-center gap-2">
            <Mail className="w-5 h-5 text-brand-400" />
            <h2 className="text-base font-bold text-white">{t('invoice.resendTitle')}</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-neutral-800 text-neutral-400 hover:text-white transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {state === 'form' && (
          <div className="p-4 space-y-4">
            <div className="text-xs text-neutral-400">
              {t('invoice.folio')} <span className="text-white font-medium">{invoice.series}{invoice.folio}</span>
            </div>
            <div>
              <label className="block text-xs font-medium text-neutral-400 mb-1">{t('invoice.email')}</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t('invoice.emailPlaceholder')}
                autoFocus
                className="w-full px-3 py-2 bg-neutral-800 border border-neutral-600 rounded-lg text-white placeholder-neutral-500 text-sm focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
              />
            </div>
            <button
              onClick={handleResend}
              disabled={!isValid}
              className="w-full py-2.5 rounded-lg font-bold text-sm bg-brand-600 hover:bg-brand-700 text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {t('invoice.resendSend')}
            </button>
          </div>
        )}

        {state === 'sending' && (
          <div className="p-8 flex flex-col items-center gap-3">
            <Loader2 className="w-8 h-8 text-brand-400 animate-spin" />
            <p className="text-neutral-300 text-sm">{t('invoice.resending')}</p>
          </div>
        )}

        {state === 'success' && (
          <div className="p-4 space-y-4">
            <div className="flex flex-col items-center gap-2 py-2">
              <div className="w-12 h-12 rounded-full bg-cockpit-green/20 flex items-center justify-center">
                <Check className="w-6 h-6 text-cockpit-in-text" />
              </div>
              <p className="text-cockpit-in-text font-bold text-sm text-center">
                {t('invoice.resentTo', { email: trimmed })}
              </p>
            </div>
            <button
              onClick={onClose}
              className="w-full py-2.5 rounded-lg font-bold text-sm bg-neutral-800 hover:bg-neutral-700 text-white transition-colors"
            >
              {t('common:buttons.close')}
            </button>
          </div>
        )}

        {state === 'error' && (
          <div className="p-4 space-y-4">
            <div className="flex flex-col items-center gap-2 py-2">
              <div className="w-12 h-12 rounded-full bg-cockpit-red/20 flex items-center justify-center">
                <AlertCircle className="w-6 h-6 text-cockpit-out-text" />
              </div>
              <p className="text-cockpit-out-text text-sm text-center break-words">{errorMessage}</p>
            </div>
            <div className="space-y-2">
              <button
                onClick={() => setState('form')}
                className="w-full py-2.5 rounded-lg font-bold text-sm bg-brand-600 hover:bg-brand-700 text-white transition-colors"
              >
                {t('invoice.retry')}
              </button>
              <button
                onClick={onClose}
                className="w-full py-2.5 rounded-lg font-bold text-sm text-neutral-400 hover:text-white transition-colors"
              >
                {t('common:buttons.close')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
