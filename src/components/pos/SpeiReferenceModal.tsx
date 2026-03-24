import React from 'react';
import { useTranslation } from 'react-i18next';
import { formatPrice } from '../../utils/currency';

interface SpeiReferenceModalProps {
  clabe: string;
  bank: string;
  amount: number;
  expiresAt: string;
  onClose: () => void;
}

const SpeiReferenceModal: React.FC<SpeiReferenceModalProps> = ({
  clabe,
  bank,
  amount,
  expiresAt,
  onClose,
}) => {
  const { t } = useTranslation('pos');
  const expiresDate = new Date(expiresAt);
  const formattedExpiry = expiresDate.toLocaleDateString('es-MX', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  const handleCopy = () => {
    navigator.clipboard.writeText(clabe).catch(() => {});
  };

  // Format CLABE with spaces for readability (groups of 4)
  const formattedClabe = clabe.replace(/(.{4})/g, '$1 ').trim();

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-neutral-900 rounded-2xl shadow-2xl w-full max-w-md border border-neutral-800 max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="bg-blue-600 text-white p-6 rounded-t-2xl text-center">
          <div className="flex items-center justify-center gap-2 mb-2">
            <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
            </svg>
            <h2 className="text-2xl font-bold">{t('spei.title')}</h2>
          </div>
          <p className="text-xl font-bold">{formatPrice(amount)}</p>
        </div>

        <div className="p-6 space-y-5">
          {/* CLABE */}
          <div className="bg-neutral-800 p-4 rounded-lg text-center">
            <p className="text-neutral-400 text-sm mb-2">{t('spei.clabe')}</p>
            <p className="text-2xl font-mono font-bold text-white tracking-wider select-all">
              {formattedClabe}
            </p>
          </div>

          {/* Bank + Amount */}
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-neutral-800 p-3 rounded-lg text-center">
              <p className="text-neutral-400 text-sm">{t('spei.bank')}</p>
              <p className="text-white font-semibold">{bank}</p>
            </div>
            <div className="bg-neutral-800 p-3 rounded-lg text-center">
              <p className="text-neutral-400 text-sm">{t('spei.exactAmount')}</p>
              <p className="text-white font-semibold">{formatPrice(amount)}</p>
            </div>
          </div>

          {/* Expiration */}
          <div className="bg-neutral-800 p-3 rounded-lg text-center">
            <p className="text-neutral-400 text-sm">{t('spei.expiresOn')}</p>
            <p className="text-white font-semibold">{formattedExpiry}</p>
          </div>

          {/* Instructions */}
          <div className="bg-blue-900/30 border border-blue-700/50 p-4 rounded-lg">
            <p className="text-blue-300 text-sm font-semibold mb-2">{t('spei.instructions')}</p>
            <ol className="text-blue-200/80 text-sm space-y-1 list-decimal list-inside">
              <li>{t('spei.step1')}</li>
              <li>{t('spei.step2')}</li>
              <li>{t('spei.step3')}</li>
              <li>{t('spei.step4')}</li>
            </ol>
          </div>

          {/* Actions */}
          <div className="space-y-3">
            <button
              onClick={handleCopy}
              className="w-full py-3 bg-blue-600 text-white font-bold rounded-lg hover:bg-blue-700 transition-all"
            >
              {t('spei.copyClabe')}
            </button>
            <button
              onClick={onClose}
              className="w-full py-3 bg-neutral-800 text-neutral-400 font-bold rounded-lg hover:bg-neutral-700 transition-all"
            >
              {t('common:buttons.close')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SpeiReferenceModal;
