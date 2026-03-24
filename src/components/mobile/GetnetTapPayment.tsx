import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { getGetnetTapPlugin, GetnetTapResult } from '../../plugins/GetnetTapPlugin';
import { formatPrice } from '../../utils/currency';

interface GetnetTapPaymentProps {
  amount: number;
  orderId: number;
  onSuccess: (result: GetnetTapResult) => void;
  onCancel: () => void;
  onError: (error: string) => void;
}

const GetnetTapPayment: React.FC<GetnetTapPaymentProps> = ({
  amount,
  orderId,
  onSuccess,
  onCancel,
  onError,
}) => {
  const { t } = useTranslation('pos');
  const [status, setStatus] = useState<'ready' | 'waiting' | 'success' | 'error'>('ready');
  const [isAvailable, setIsAvailable] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    const plugin = getGetnetTapPlugin();
    if (plugin) {
      plugin.isAvailable().then(({ available }) => setIsAvailable(available));
    }
  }, []);

  const handleStartPayment = async () => {
    const plugin = getGetnetTapPlugin();
    if (!plugin) {
      onError(t('getnetTap.notAvailable'));
      return;
    }

    setStatus('waiting');
    setErrorMessage('');

    try {
      const result = await plugin.startPayment({
        amount: Math.round(amount * 100), // centavos
        orderId: String(orderId),
        description: t('getnetTap.orderNumber', { id: orderId }),
      });

      if (result.success) {
        setStatus('success');
        onSuccess(result);
      } else {
        setStatus('error');
        setErrorMessage(result.error || t('getnetTap.paymentDeclined'));
        onError(result.error || t('getnetTap.paymentDeclined'));
      }
    } catch (err) {
      setStatus('error');
      const msg = err instanceof Error ? err.message : t('getnetTap.processingError');
      setErrorMessage(msg);
      onError(msg);
    }
  };

  const handleCancel = async () => {
    const plugin = getGetnetTapPlugin();
    if (plugin && status === 'waiting') {
      try { await plugin.cancelPayment(); } catch { /* best effort */ }
    }
    setStatus('ready');
    onCancel();
  };

  if (!isAvailable) {
    return (
      <div className="text-center p-4">
        <p className="text-neutral-400 text-sm">
          {t('getnetTap.nfcRequired')}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {status === 'ready' && (
        <button
          onClick={handleStartPayment}
          className="w-full py-4 bg-red-600 text-white text-xl font-bold rounded-lg hover:bg-red-700 transition-all touch-manipulation"
        >
          {t('getnetTap.tapToPay')} — {formatPrice(amount)}
        </button>
      )}

      {status === 'waiting' && (
        <div className="bg-red-600/10 border border-red-600/30 rounded-lg p-5 text-center space-y-3">
          <div className="flex items-center justify-center gap-2">
            <div className="w-3 h-3 bg-red-600 rounded-full animate-pulse" />
            <p className="text-red-500 font-bold text-lg">{t('getnetTap.waitingForCard')}</p>
          </div>
          <p className="text-neutral-400 text-sm">
            {t('getnetTap.bringCardCloser')}
          </p>
          <button
            onClick={handleCancel}
            className="text-red-400 text-sm font-semibold hover:text-red-300 transition-colors"
          >
            {t('common:buttons.cancel')}
          </button>
        </div>
      )}

      {status === 'success' && (
        <div className="bg-green-600/10 border border-green-600/30 rounded-lg p-5 text-center">
          <div className="w-16 h-16 rounded-full bg-green-600 flex items-center justify-center mx-auto mb-3">
            <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <p className="text-green-400 font-bold text-lg">{t('getnetTap.paymentConfirmed')}</p>
        </div>
      )}

      {status === 'error' && errorMessage && (
        <div className="text-center">
          <p className="text-red-400 text-sm font-medium mb-2">{errorMessage}</p>
          <button
            onClick={() => setStatus('ready')}
            className="text-brand-400 text-sm font-semibold hover:text-brand-300"
          >
            {t('getnetTap.tryAgain')}
          </button>
        </div>
      )}
    </div>
  );
};

export default GetnetTapPayment;
