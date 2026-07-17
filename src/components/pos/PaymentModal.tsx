import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { formatPrice } from '../../utils/currency';
import { usePlan } from '../../context/PlanContext';
import { mpCharge, mpCancelCharge, clipCharge, clipCancelCharge, getPaymentStatus, getMpTerminals, getMpStatus } from '../../api';

type TerminalProvider = 'mp' | 'clip';

// Per-workstation MP Point terminal binding. Stored in localStorage so each
// PC/register keeps its own nearest terminal, independent of the tenant default.
const MP_TERMINAL_STORAGE_KEY = 'dk_mp_terminal_id';

interface MpTerminal {
  id: string;
  external_pos_id: string;
  operating_mode: string;
}

function terminalDisplayName(term: MpTerminal): string {
  if (term.external_pos_id) return term.external_pos_id;
  const parts = term.id.split('__');
  return parts[parts.length - 1] || term.id;
}

export interface PaymentModalProps {
  orderTotal: number;
  orderId?: number;
  onCashPayment: (tip: number, amountReceived: number) => void;
  onGetnetPayment?: (tip: number) => void;
  onTerminalPaymentSuccess?: (orderId: number) => void;
  /** When provided, renders a "Dividir cuenta" entry that hands off to the split flow. */
  onSplitPayment?: () => void;
  onCancel: () => void;
  isProcessing: boolean;
  isOnline: boolean;
  getnetEnabled?: boolean;
}

const PaymentModal: React.FC<PaymentModalProps> = ({
  orderTotal,
  orderId,
  onCashPayment,
  onGetnetPayment,
  onTerminalPaymentSuccess,
  onSplitPayment,
  onCancel,
  isProcessing,
  isOnline,
  getnetEnabled,
}) => {
  const { t } = useTranslation('pos');
  const { isMpConnected, isClipConfigured } = usePlan();
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
  const [terminalProvider, setTerminalProvider] = useState<TerminalProvider | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Per-workstation MP terminal binding + failover
  const [terminals, setTerminals] = useState<MpTerminal[]>([]);
  const [boundTerminalId, setBoundTerminalId] = useState<string>(
    () => localStorage.getItem(MP_TERMINAL_STORAGE_KEY) || ''
  );
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null);
  const [failoverAvailable, setFailoverAvailable] = useState(false);
  const [failoverBusy, setFailoverBusy] = useState(false);
  const failoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!isMpConnected || !orderId) return;
    let cancelled = false;
    (async () => {
      try {
        const [{ terminals: list }, status] = await Promise.all([getMpTerminals(), getMpStatus()]);
        if (cancelled) return;
        setTerminals(list);
        setBoundTerminalId(prev => {
          if (prev && list.some(term => term.id === prev)) return prev;
          const fallback =
            (status.mp_default_terminal_id && list.some(term => term.id === status.mp_default_terminal_id)
              ? status.mp_default_terminal_id
              : list[0]?.id) || '';
          return fallback;
        });
      } catch {
        // Non-fatal: charge falls back to the tenant default terminal server-side
      }
    })();
    return () => { cancelled = true; };
  }, [isMpConnected, orderId]);

  const handleTerminalSelect = (termId: string) => {
    setBoundTerminalId(termId);
    localStorage.setItem(MP_TERMINAL_STORAGE_KEY, termId);
  };

  const otherTerminal = terminals.find(
    term => term.id !== (activeTerminalId || boundTerminalId)
  ) || null;

  const handleTipSelect = (percentage: number) => {
    const tipAmount = Math.round((orderTotal * percentage) / 100 * 100) / 100;
    setTip(tipAmount);
    setShowCustomInput(false);
  };

  /** Fixed peso amount tip — common in MX where customers leave round bills. */
  const handleFixedTipSelect = (amount: number) => {
    setTip(amount);
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

  const stopFailoverTimer = useCallback(() => {
    if (failoverTimerRef.current) clearTimeout(failoverTimerRef.current);
    failoverTimerRef.current = null;
  }, []);

  // 20s of no response from the bound terminal surfaces the one-tap
  // "send to the other terminal" retry (charge stays pending until resolved).
  const startFailoverTimer = useCallback(() => {
    stopFailoverTimer();
    setFailoverAvailable(false);
    failoverTimerRef.current = setTimeout(() => setFailoverAvailable(true), 20000);
  }, [stopFailoverTimer]);

  // Poll for terminal payment completion
  const startPolling = useCallback((oid: number) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const status = await getPaymentStatus(oid);
        if (status.payment_status === 'paid') {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          stopFailoverTimer();
          setFailoverAvailable(false);
          setTerminalSuccess(true);
          setTimeout(() => {
            if (onTerminalPaymentSuccess) {
              onTerminalPaymentSuccess(oid);
            }
            onCancel();
          }, 1200);
        } else if (status.payment_status === 'failed') {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          stopFailoverTimer();
          setTerminalPending(false);
          setTerminalError(t('payment.terminalDeclined'));
          setFailoverAvailable(true);
        }
      } catch {
        // Keep polling on network errors
      }
    }, 2000);
  }, [onTerminalPaymentSuccess, onCancel, stopFailoverTimer, t]);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (failoverTimerRef.current) clearTimeout(failoverTimerRef.current);
    };
  }, []);

  const handleTerminalPayment = async (provider: TerminalProvider, terminalId?: string) => {
    if (!orderId) return;
    setTerminalProvider(provider);
    setTerminalPending(true);
    setTerminalError('');
    const targetTerminal = terminalId || boundTerminalId || undefined;
    try {
      if (provider === 'mp') {
        const result = await mpCharge(orderId, targetTerminal, tip);
        setActiveTerminalId(result.terminal_id || targetTerminal || null);
        startFailoverTimer();
      } else {
        await clipCharge(orderId);
      }
      setTerminalOrderId(orderId);
      startPolling(orderId);
    } catch (err) {
      setTerminalPending(false);
      setTerminalProvider(null);
      setTerminalError(err instanceof Error ? err.message : t('payment.terminalSendError'));
      // On MP send failure, offer the other terminal right away
      if (provider === 'mp') setFailoverAvailable(true);
    }
  };

  const handleCancelTerminal = async () => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
    stopFailoverTimer();
    if (terminalOrderId && terminalProvider) {
      try {
        if (terminalProvider === 'mp') {
          await mpCancelCharge(terminalOrderId, activeTerminalId || undefined);
        } else {
          await clipCancelCharge(terminalOrderId);
        }
      } catch {
        // Best effort
      }
    }
    setTerminalPending(false);
    setTerminalOrderId(null);
    setTerminalProvider(null);
    setActiveTerminalId(null);
    setTerminalError('');
    setFailoverAvailable(false);
  };

  // One-tap failover: cancel the pending intent on the unresponsive MP terminal
  // (never leave two live intents), then re-send to the other terminal.
  const handleFailover = async () => {
    if (!orderId || !otherTerminal || failoverBusy) return;
    setFailoverBusy(true);
    try {
      if (terminalPending && terminalOrderId) {
        // Race guard: if the customer already paid on the original terminal, let the poller finish it.
        try {
          const status = await getPaymentStatus(terminalOrderId);
          if (status.payment_status === 'paid') {
            setFailoverAvailable(false);
            return;
          }
        } catch {
          // Status check failed — proceed with cancel, which is itself guarded
        }
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = null;
        stopFailoverTimer();
        try {
          await mpCancelCharge(orderId, activeTerminalId || undefined);
        } catch {
          const recheck = await getPaymentStatus(orderId).catch(() => null);
          if (recheck?.payment_status === 'paid') {
            startPolling(orderId);
            setFailoverAvailable(false);
            return;
          }
          setTerminalError(t('payment.terminalSendError'));
          setTerminalPending(false);
          return;
        }
      }
      setTerminalError('');
      await handleTerminalPayment('mp', otherTerminal.id);
    } catch (err) {
      setTerminalPending(false);
      setTerminalError(err instanceof Error ? err.message : t('payment.terminalSendError'));
    } finally {
      setFailoverBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-neutral-900 rounded-2xl shadow-2xl w-full max-w-md border border-neutral-800 max-h-[90vh] overflow-y-auto relative">
        {/* Terminal success overlay */}
        {terminalSuccess && (
          <div className="absolute inset-0 bg-neutral-900/95 z-10 flex flex-col items-center justify-center rounded-2xl">
            <div className="w-20 h-20 rounded-full bg-cockpit-green flex items-center justify-center mb-4 animate-pulse">
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
            {/* Fixed peso tip amounts — common in MX (round bills) */}
            <div className="grid grid-cols-4 gap-2 mt-2">
              {[10, 20, 50, 100].map((amt) => (
                <button
                  key={amt}
                  onClick={() => handleFixedTipSelect(amt)}
                  className={`py-3 px-2 text-lg font-bold rounded-lg transition-all ${
                    tip === amt && !showCustomInput
                      ? 'bg-brand-600 text-white'
                      : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700'
                  }`}
                >
                  ${amt}
                </button>
              ))}
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
                className="w-full bg-neutral-700 border border-neutral-600 rounded-lg p-3 text-2xl text-white text-center focus:outline-none focus:border-cockpit-green font-bold"
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
                  <p className="text-2xl font-bold text-cockpit-in-text">{formatPrice(changeDue)}</p>
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
              {failoverAvailable && otherTerminal && terminalProvider === 'mp' && (
                <div className="pt-2 border-t border-[#009ee3]/20 space-y-2">
                  <p className="text-neutral-400 text-sm">{t('payment.terminalNotResponding')}</p>
                  <button
                    onClick={handleFailover}
                    disabled={failoverBusy}
                    className="w-full py-3 bg-[#009ee3] text-white font-bold rounded-lg hover:bg-[#0082c0] disabled:bg-neutral-700 disabled:text-neutral-400 transition-all touch-manipulation"
                  >
                    {failoverBusy
                      ? t('payment.processing')
                      : t('payment.sendToOtherTerminal', { name: terminalDisplayName(otherTerminal) })}
                  </button>
                </div>
              )}
              <button
                onClick={handleCancelTerminal}
                className="text-cockpit-out-text text-sm font-semibold hover:text-cockpit-out-text/90 transition-colors"
              >
                {t('payment.cancelCharge')}
              </button>
            </div>
          )}

          {terminalError && (
            <div className="space-y-2">
              <p className="text-cockpit-out-text text-sm text-center font-medium">{terminalError}</p>
              {!terminalPending && failoverAvailable && otherTerminal && (
                <button
                  onClick={handleFailover}
                  disabled={failoverBusy}
                  className="w-full py-3 bg-[#009ee3] text-white font-bold rounded-lg hover:bg-[#0082c0] disabled:bg-neutral-700 disabled:text-neutral-400 transition-all touch-manipulation"
                >
                  {failoverBusy
                    ? t('payment.processing')
                    : t('payment.sendToOtherTerminal', { name: terminalDisplayName(otherTerminal) })}
                </button>
              )}
            </div>
          )}

          {/* Payment Buttons */}
          {!terminalPending && (
            <div className="space-y-3">
              {/* Mercado Pago Terminal — only for Pro+ with MP connected */}
              {isMpConnected && orderId && (
                <div className="space-y-2">
                  {/* Per-workstation terminal binding — remembered on this device */}
                  {terminals.length > 1 && (
                    <div className="flex items-center gap-2">
                      <label className="text-neutral-400 text-sm whitespace-nowrap">
                        {t('payment.terminalLabel')}
                      </label>
                      <select
                        value={boundTerminalId}
                        onChange={(e) => handleTerminalSelect(e.target.value)}
                        className="flex-1 bg-neutral-800 border border-neutral-700 rounded-lg py-2 px-3 text-sm text-white focus:outline-none focus:border-[#009ee3]"
                      >
                        {terminals.map(term => (
                          <option key={term.id} value={term.id}>
                            {terminalDisplayName(term)}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  <button
                    onClick={() => handleTerminalPayment('mp')}
                    disabled={isProcessing || !isOnline}
                    className="w-full py-4 bg-[#009ee3] text-white text-xl font-bold rounded-lg hover:bg-[#0082c0] disabled:bg-neutral-700 disabled:text-neutral-400 transition-all touch-manipulation"
                    title={!isOnline ? t('offline.cardUnavailable') : undefined}
                  >
                    {!isOnline ? t('offline.cardUnavailable') : t('payment.sendToMPTerminal')}
                  </button>
                </div>
              )}
              {/* Clip Terminal — only when Clip credentials are configured */}
              {isClipConfigured && orderId && (
                <button
                  onClick={() => handleTerminalPayment('clip')}
                  disabled={isProcessing || !isOnline}
                  className="w-full py-4 bg-[#FF5A1F] text-white text-xl font-bold rounded-lg hover:bg-[#e64e16] disabled:bg-neutral-700 disabled:text-neutral-400 transition-all touch-manipulation"
                  title={!isOnline ? t('offline.cardUnavailable') : undefined}
                >
                  {!isOnline ? t('offline.cardUnavailable') : t('payment.sendToClipTerminal')}
                </button>
              )}
              {showCashInput ? (
                <button
                  onClick={() => onCashPayment(tip, receivedNum)}
                  disabled={isProcessing || receivedNum < finalTotal}
                  className="w-full py-4 bg-cockpit-green text-white text-xl font-bold rounded-lg hover:bg-cockpit-green/90 disabled:bg-neutral-700 transition-all touch-manipulation"
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
                  className="w-full py-4 bg-cockpit-red text-white text-xl font-bold rounded-lg hover:bg-cockpit-red/90 disabled:bg-neutral-700 disabled:text-neutral-400 transition-all touch-manipulation"
                >
                  {isProcessing ? t('payment.processing') : t('payment.payWithGetnet')}
                </button>
              )}
              {/* Split-the-bill — only when the caller wires it (existing-order Cobrar). */}
              {onSplitPayment && (
                <button
                  onClick={onSplitPayment}
                  disabled={isProcessing}
                  className="w-full py-4 bg-neutral-700 text-white text-xl font-bold rounded-lg hover:bg-neutral-600 disabled:bg-neutral-800 transition-all touch-manipulation border border-neutral-600"
                >
                  {t('payment.splitBill', 'Dividir cuenta')}
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
