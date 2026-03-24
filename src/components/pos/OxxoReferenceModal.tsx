import React from 'react';
import { useTranslation } from 'react-i18next';
import { formatPrice } from '../../utils/currency';

interface OxxoReferenceModalProps {
  reference: string;
  barcodeUrl: string | null;
  amount: number;
  expiresAt: string;
  onClose: () => void;
}

const OxxoReferenceModal: React.FC<OxxoReferenceModalProps> = ({
  reference,
  barcodeUrl,
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
    navigator.clipboard.writeText(reference).catch(() => {});
  };

  const handlePrint = () => {
    window.print();
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-neutral-900 rounded-2xl shadow-2xl w-full max-w-md border border-neutral-800 max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="bg-orange-600 text-white p-6 rounded-t-2xl text-center">
          <div className="flex items-center justify-center gap-2 mb-2">
            <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
            </svg>
            <h2 className="text-2xl font-bold">{t('oxxo.title')}</h2>
          </div>
          <p className="text-xl font-bold">{formatPrice(amount)}</p>
        </div>

        <div className="p-6 space-y-5">
          {/* Reference */}
          <div className="bg-neutral-800 p-4 rounded-lg text-center">
            <p className="text-neutral-400 text-sm mb-2">{t('oxxo.paymentReference')}</p>
            <p className="text-3xl font-mono font-bold text-white tracking-widest select-all">
              {reference}
            </p>
          </div>

          {/* Barcode */}
          {barcodeUrl && (
            <div className="bg-white p-4 rounded-lg flex justify-center">
              <img src={barcodeUrl} alt="Barcode" className="max-w-full h-20" />
            </div>
          )}

          {/* Expiration */}
          <div className="bg-neutral-800 p-3 rounded-lg text-center">
            <p className="text-neutral-400 text-sm">{t('oxxo.expiresOn')}</p>
            <p className="text-white font-semibold">{formattedExpiry}</p>
          </div>

          {/* Instructions */}
          <div className="bg-orange-900/30 border border-orange-700/50 p-4 rounded-lg">
            <p className="text-orange-300 text-sm font-semibold mb-2">{t('oxxo.instructions')}</p>
            <ol className="text-orange-200/80 text-sm space-y-1 list-decimal list-inside">
              <li>{t('oxxo.step1')}</li>
              <li>{t('oxxo.step2')}</li>
              <li>{t('oxxo.step3')}</li>
              <li>{t('oxxo.step4')}</li>
            </ol>
          </div>

          {/* Actions */}
          <div className="space-y-3">
            <button
              onClick={handleCopy}
              className="w-full py-3 bg-orange-600 text-white font-bold rounded-lg hover:bg-orange-700 transition-all"
            >
              {t('oxxo.copyReference')}
            </button>
            <button
              onClick={handlePrint}
              className="w-full py-3 bg-neutral-700 text-white font-bold rounded-lg hover:bg-neutral-600 transition-all"
            >
              {t('common:buttons.print')}
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

export default OxxoReferenceModal;
