import React from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, CheckCircle, XCircle, RotateCcw } from 'lucide-react';

type PaymentState = 'processing' | 'success' | 'error';

interface Props {
  state: PaymentState;
  onRetry: () => void;
  onClose: () => void;
  errorMessage?: string;
}

const MobileCardPayment: React.FC<Props> = ({ state, onRetry, onClose, errorMessage }) => {
  const { t } = useTranslation('pos');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={state !== 'processing' ? onClose : undefined}>
      <div className="bg-neutral-900 rounded-3xl p-8 w-72 flex flex-col items-center gap-4" onClick={(e) => e.stopPropagation()}>
        {state === 'processing' && (
          <>
            <Loader2 className="w-16 h-16 text-brand-500 animate-spin" />
            <p className="text-white font-semibold text-lg">{t('mobilePOS.processing')}</p>
          </>
        )}

        {state === 'success' && (
          <>
            <CheckCircle className="w-16 h-16 text-green-500" />
            <p className="text-white font-semibold text-lg">{t('mobilePOS.orderComplete')}</p>
          </>
        )}

        {state === 'error' && (
          <>
            <XCircle className="w-16 h-16 text-red-500" />
            <p className="text-white font-semibold text-lg">{t('mobilePOS.paymentFailed')}</p>
            {errorMessage && <p className="text-neutral-400 text-sm text-center">{errorMessage}</p>}
            <button
              onClick={onRetry}
              className="flex items-center gap-2 px-6 py-3 bg-brand-600 text-white font-semibold rounded-xl touch-manipulation active:bg-brand-700"
            >
              <RotateCcw className="w-4 h-4" />
              {t('mobilePOS.retryPayment')}
            </button>
          </>
        )}
      </div>
    </div>
  );
};

export default MobileCardPayment;
