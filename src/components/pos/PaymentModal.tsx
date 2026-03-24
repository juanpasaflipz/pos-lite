import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { formatPrice } from '../../utils/currency';
import { usePlan } from '../../context/PlanContext';
import { mpCharge, mpCancelCharge, getPaymentStatus } from '../../api';

export interface PaymentModalProps {
  orderTotal: number;
  orderId?: number;
  onCardPayment: (tip: number) => void;
  onCashPayment: (tip: number, amountReceived: number) => void;
  onOxxoPayment?: (tip: number) => void;
  onSpeiPayment?: (tip: number) => void;
  onGetnetPayment?: (tip: number) => void;
  onTerminalPaymentSuccess?: () => void;
  onCancel: () => void;
  isProcessing: boolean;
  isOnline: boolean;
  conektaConfigured?: boolean;
  getnetEnabled?: boolean;
}

const PaymentModal: React.FC<PaymentModalProps> = ({
  orderTotal,
  orderId,
  onCardPayment,
  onCashPayment,
  onOxxoPayment,
  onSpeiPayment,
  onGetnetPayment,
  onTerminalPaymentSuccess,
  onCancel,
  isProcessing,
  isOnline,
  conektaConfigured,
  getnetEnabled,
}) => {
  const { t } = useTranslation('pos');
  const { isMpConnected } = usePlan();
  const [tip, setTip] = useState(0);
  const [customTip, setCustomTip] = useState('');
  const [showCustomInput, setShowCustomInput] = useState(false);
  const [showCashInput, setShowCashInput] = useState(false);
  const [amountReceived, setAmountReceived] = useState('');

  // Terminal payment state
  const [terminalPending, setTerminalPending] = useState(false);
  const [terminalSuccess, setTerminalSuccess] = useState(false);
  const [terminalError, setTerminalError] = useState('');
  const [terminalOrderId, setTerminalOrderId] = useState<number | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const handleTipSelect = (percentage: number) => {
    const tipAmount = Math.round((orderTotal * percentage) / 100 * 100) / 100;
    setTip(tipAmount);
    setShowCustomInput(false);
  };

  const handleCustomTip = () => {
    const customAmount = parseFloat(customTip) || 0;
    setTip(customAmount);
    setShowCustomInput(false);
  };

  const finalTotal = orderTotal + tip;
  const receivedNum = parseFloat(amountReceived) || 0;
  const changeDue = Math.max(0, receivedNum - finalTotal);

  // Poll for terminal payment completion
  const startPolling = useCallback((oid: number) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const status = await getPaymentStatus(oid);
        if (status.payment_status === 'paid') {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          setTerminalSuccess(true);
          setTimeout(() => {
            if (onTerminalPaymentSuccess) {
              onTerminalPaymentSuccess();
            }
            onCancel();
          }, 1200);
        } else if (status.payment_status === 'failed') {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          setTerminalPending(false);
          setTerminalError(t('payment.terminalDeclined'));
        }
      } catch {
        // Keep polling on network errors
      }
    }, 2000);
  }, [onTerminalPaymentSuccess, onCancel]);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const handleTerminalPayment = async () => {
    if (!orderId) return;
    setTerminalPending(true);
    setTerminalError('');
    try {
      await mpCharge(orderId);
      setTerminalOrderId(orderId);
      startPolling(orderId);
    } catch (err) {
      setTerminalPending(false);
      setTerminalError(err instanceof Error ? err.message : t('payment.terminalSendError'));
    }
  };

  const handleCancelTerminal = async () => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
    if (terminalOrderId) {
      try {
        await mpCancelCharge(terminalOrderId);
      } catch {
        // Best effort
      }
    }
    setTerminalPending(false);
    setTerminalOrderId(null);
    setTerminalError('');
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-neutral-900 rounded-2xl shadow-2xl w-full max-w-md border border-neutral-800 max-h-[90vh] overflow-y-auto relative">
        {/* Terminal success overlay */}
        {terminalSuccess && (
          <div className="absolute inset-0 bg-neutral-900/95 z-10 flex flex-col items-center justify-center rounded-2xl">
            <div className="w-20 h-20 rounded-full bg-green-600 flex items-center justify-center mb-4 animate-pulse">
              <svg className="w-10 h-10 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <p className="text-white text-xl font-bold">{t('payment.confirmed')}</p>
          </div>
        )}

        <div className="bg-brand-600 text-white p-6 rounded-t-2xl text-center">
          <h2 className="text-3xl font-bold mb-2">{t('payment.title')}</h2>
          <p className="text-2xl">{t('payment.total', { amount: formatPrice(orderTotal) })}</p>
        </div>
        <div className="p-6 space-y-6">
          {/* Tip Selection */}
          <div>
            <p className="text-lg font-semibold text-white mb-3">{t('payment.selectTip')}</p>
            <div className="grid grid-cols-4 gap-2">
              <button
                onClick={() => handleTipSelect(10)}
                className={`py-3 px-2 text-lg font-bold rounded-lg transition-all ${
                  tip === Math.round((orderTotal * 10) / 100 * 100) / 100 &&
                  !showCustomInput
                    ? 'bg-brand-600 text-white'
                    : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700'
                }`}
              >
                10%
              </button>
              <button
                onClick={() => handleTipSelect(15)}
                className={`py-3 px-2 text-lg font-bold rounded-lg transition-all ${
                  tip === Math.round((orderTotal * 15) / 100 * 100) / 100 &&
                  !showCustomInput
                    ? 'bg-brand-600 text-white'
                    : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700'
                }`}
              >
                15%
              </button>
              <button
                onClick={() => handleTipSelect(20)}
                className={`py-3 px-2 text-lg font-bold rounded-lg transition-all ${
                  tip === Math.round((orderTotal * 20) / 100 * 100) / 100 &&
                  !showCustomInput
                    ? 'bg-brand-600 text-white'
                    : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700'
                }`}
              >
                20%
              </button>
              <button
                onClick={() => setShowCustomInput(true)}
                className={`py-3 px-2 text-lg font-bold rounded-lg transition-all ${
                  showCustomInput
                    ? 'bg-brand-600 text-white'
                    : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700'
                }`}
              >
                {t('payment.customTip')}
              </button>
            </div>
          </div>

          {/* Custom Tip Input */}
          {showCustomInput && (
            <div className="flex gap-2">
              <input
                type="number"
                value={customTip}
                onChange={(e) => setCustomTip(e.target.value)}
                placeholder="$0.00"
                className="flex-1 bg-neutral-800 border border-neutral-700 rounded-lg p-3 text-lg text-white focus:outline-none focus:border-brand-600"
              />
              <button
                onClick={handleCustomTip}
                className="px-4 py-3 bg-brand-600 text-white font-bold rounded-lg hover:bg-brand-700 transition-all"
              >
                {t('common:buttons.ok')}
              </button>
            </div>
          )}

          {/* Total Display */}
          <div className="bg-neutral-800 p-4 rounded-lg text-center">
            <p className="text-neutral-400 text-sm mb-1">{t('payment.tipAmount', { amount: formatPrice(tip) })}</p>
            <p className="text-3xl font-bold text-brand-500">
              {t('payment.totalWithTip', { amount: formatPrice(finalTotal) })}
            </p>
          </div>

          {/* Cash Amount Received Input */}
          {showCashInput && (
            <div className="bg-neutral-800 p-4 rounded-lg space-y-3">
              <p className="text-lg font-semibold text-white">{t('payment.amountReceived')}</p>
              <input
                type="number"
                value={amountReceived}
                onChange={(e) => setAmountReceived(e.target.value)}
                placeholder={formatPrice(finalTotal)}
                className="w-full bg-neutral-700 border border-neutral-600 rounded-lg p-3 text-2xl text-white text-center focus:outline-none focus:border-green-500 font-bold"
                autoFocus
              />
              <div className="grid grid-cols-4 gap-2">
                {[50, 100, 200, 500].map((amt) => (
                  <button
                    key={amt}
                    onClick={() => setAmountReceived(String(amt))}
                    className="py-2 bg-neutral-600 text-white font-bold rounded-lg hover:bg-neutral-500 transition-all"
                  >
                    ${amt}
                  </button>
                ))}
              </div>
              {receivedNum > 0 && (
                <div className="text-center pt-2 border-t border-neutral-700">
                  <p className="text-neutral-400 text-sm">{t('payment.changeDue')}</p>
                  <p className="text-2xl font-bold text-green-400">{formatPrice(changeDue)}</p>
                </div>
              )}
            </div>
          )}

          {/* Terminal Waiting State */}
          {terminalPending && (
            <div className="bg-[#009ee3]/10 border border-[#009ee3]/30 rounded-lg p-5 text-center space-y-3">
              <div className="flex items-center justify-center gap-2">
                <div className="w-3 h-3 bg-[#009ee3] rounded-full animate-pulse" />
                <p className="text-[#009ee3] font-bold text-lg">{t('payment.terminalWaiting')}</p>
              </div>
              <p className="text-neutral-400 text-sm">
                {t('payment.terminalReaderPrompt')}
              </p>
              <button
                onClick={handleCancelTerminal}
                className="text-red-400 text-sm font-semibold hover:text-red-300 transition-colors"
              >
                {t('payment.cancelCharge')}
              </button>
            </div>
          )}

          {terminalError && (
            <p className="text-red-400 text-sm text-center font-medium">{terminalError}</p>
          )}

          {/* Payment Buttons */}
          {!terminalPending && (
            <div className="space-y-3">
              {/* Mercado Pago Terminal — only for Pro+ with MP connected */}
              {isMpConnected && orderId && (
                <button
                  onClick={handleTerminalPayment}
                  disabled={isProcessing || !isOnline}
                  className="w-full py-4 bg-[#009ee3] text-white text-xl font-bold rounded-lg hover:bg-[#0082c0] disabled:bg-neutral-700 disabled:text-neutral-400 transition-all touch-manipulation"
                  title={!isOnline ? t('offline.cardUnavailable') : undefined}
                >
                  {!isOnline ? t('offline.cardUnavailable') : t('payment.sendToMPTerminal')}
                </button>
              )}
              <button
                onClick={() => onCardPayment(tip)}
                disabled={isProcessing || !isOnline}
                className="w-full py-4 bg-brand-600 text-white text-xl font-bold rounded-lg hover:bg-brand-700 disabled:bg-neutral-700 disabled:text-neutral-400 transition-all touch-manipulation"
                title={!isOnline ? t('offline.cardUnavailable') : undefined}
              >
                {!isOnline ? t('offline.cardUnavailable') : isProcessing ? t('payment.processing') : t('payment.payWithCard')}
              </button>
              {showCashInput ? (
                <button
                  onClick={() => onCashPayment(tip, receivedNum)}
                  disabled={isProcessing || receivedNum < finalTotal}
                  className="w-full py-4 bg-green-600 text-white text-xl font-bold rounded-lg hover:bg-green-700 disabled:bg-neutral-700 transition-all touch-manipulation"
                >
                  {isProcessing ? t('payment.processing') : t('payment.confirmCash', { change: formatPrice(changeDue) })}
                </button>
              ) : (
                <button
                  onClick={() => setShowCashInput(true)}
                  disabled={isProcessing}
                  className="w-full py-4 bg-neutral-700 text-white text-xl font-bold rounded-lg hover:bg-neutral-600 disabled:bg-neutral-800 transition-all touch-manipulation"
                >
                  {t('payment.cashPayment')}
                </button>
              )}
              {/* Getnet — only when enabled */}
              {getnetEnabled && onGetnetPayment && (
                <button
                  onClick={() => onGetnetPayment(tip)}
                  disabled={isProcessing || !isOnline}
                  className="w-full py-4 bg-red-600 text-white text-xl font-bold rounded-lg hover:bg-red-700 disabled:bg-neutral-700 disabled:text-neutral-400 transition-all touch-manipulation"
                >
                  {isProcessing ? t('payment.processing') : t('payment.payWithGetnet')}
                </button>
              )}
              {/* Conekta OXXO + SPEI — only when Conekta is configured */}
              {conektaConfigured && onOxxoPayment && (
                <button
                  onClick={() => onOxxoPayment(tip)}
                  disabled={isProcessing || !isOnline}
                  className="w-full py-4 bg-orange-600 text-white text-xl font-bold rounded-lg hover:bg-orange-700 disabled:bg-neutral-700 disabled:text-neutral-400 transition-all touch-manipulation"
                >
                  {isProcessing ? t('payment.processing') : t('payment.payAtOxxo')}
                </button>
              )}
              {conektaConfigured && onSpeiPayment && (
                <button
                  onClick={() => onSpeiPayment(tip)}
                  disabled={isProcessing || !isOnline}
                  className="w-full py-4 bg-blue-600 text-white text-xl font-bold rounded-lg hover:bg-blue-700 disabled:bg-neutral-700 disabled:text-neutral-400 transition-all touch-manipulation"
                >
                  {isProcessing ? t('payment.processing') : t('payment.speiTransfer')}
                </button>
              )}
              <button
                onClick={onCancel}
                disabled={isProcessing}
                className="w-full py-4 bg-neutral-800 text-neutral-400 text-lg font-bold rounded-lg hover:bg-neutral-700 disabled:bg-neutral-900 transition-all"
              >
                {t('common:buttons.cancel')}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default PaymentModal;
