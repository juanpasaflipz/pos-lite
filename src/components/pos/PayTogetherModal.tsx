import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { formatPrice } from '../../utils/currency';
import { usePlan } from '../../context/PlanContext';
import { payTogether, cancelPayTogether, getPaymentGroupStatus, type PayTogetherShare } from '../../api';
import type { Order } from '../../types';

interface PayTogetherModalProps {
  orders: Order[];
  onCancel: () => void;
  onSuccess: (paymentGroupId: number) => void;
}

const PayTogetherModal: React.FC<PayTogetherModalProps> = ({ orders, onCancel, onSuccess }) => {
  const { t } = useTranslation('pos');
  const { isMpConnected } = usePlan();

  const subtotalSum = orders.reduce((s, o) => s + Number(o.total || 0), 0);

  const [tip, setTip] = useState(0);
  const [customTip, setCustomTip] = useState('');
  const [showCustomInput, setShowCustomInput] = useState(false);
  const [showCashInput, setShowCashInput] = useState(false);
  const [amountReceived, setAmountReceived] = useState('');
  const [terminalPending, setTerminalPending] = useState(false);
  const [terminalSuccess, setTerminalSuccess] = useState(false);
  const [terminalError, setTerminalError] = useState('');
  const [paymentGroupId, setPaymentGroupId] = useState<number | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const finalTotal = subtotalSum + tip;
  const receivedNum = parseFloat(amountReceived) || 0;
  const changeDue = Math.max(0, receivedNum - finalTotal);

  const handleTipSelect = (pct: number) => {
    setTip(Math.round((subtotalSum * pct) / 100 * 100) / 100);
    setShowCustomInput(false);
  };
  const handleFixedTip = (amt: number) => { setTip(amt); setShowCustomInput(false); };
  const handleCustomTip = () => {
    setTip(parseFloat(customTip) || 0);
    setShowCustomInput(false);
  };

  const startPolling = useCallback((groupId: number) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const s = await getPaymentGroupStatus(groupId);
        if (s.status === 'paid') {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          setTerminalSuccess(true);
          setTimeout(() => onSuccess(groupId), 1200);
        } else if (s.status === 'failed' || s.status === 'cancelled') {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          setTerminalPending(false);
          setTerminalError(t('payment.terminalDeclined'));
        }
      } catch {
        // keep polling on transient errors
      }
    }, 2000);
  }, [onSuccess, t]);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const handleTerminal = async () => {
    setIsProcessing(true);
    setTerminalError('');
    try {
      const resp = await payTogether({
        order_ids: orders.map((o) => o.id),
        payment_method: 'mp_terminal',
        tip,
      });
      setPaymentGroupId(resp.payment_group_id);
      setTerminalPending(true);
      startPolling(resp.payment_group_id);
    } catch (err) {
      setTerminalError(err instanceof Error ? err.message : t('payment.terminalSendError'));
    } finally {
      setIsProcessing(false);
    }
  };

  const handleCancelTerminal = async () => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
    if (paymentGroupId) {
      try {
        const result = await cancelPayTogether(paymentGroupId);
        if (result.paid) {
          setTerminalSuccess(true);
          setTimeout(() => onSuccess(paymentGroupId), 1200);
          return;
        }
      } catch {
        // best effort
      }
    }
    setTerminalPending(false);
    setPaymentGroupId(null);
    setTerminalError('');
  };

  const handleCash = async () => {
    if (receivedNum < finalTotal) return;
    setIsProcessing(true);
    try {
      const resp = await payTogether({
        order_ids: orders.map((o) => o.id),
        payment_method: 'cash',
        tip,
        cash_received: receivedNum,
      });
      setTerminalSuccess(true);
      setTimeout(() => onSuccess(resp.payment_group_id), 900);
    } catch (err) {
      setTerminalError(err instanceof Error ? err.message : t('payment.terminalSendError'));
      setIsProcessing(false);
    }
  };

  // Preview per-order share (proportional, matches server-side math)
  const shares: PayTogetherShare[] = (() => {
    const tipCents = Math.round(tip * 100);
    const grand = subtotalSum;
    const raw = orders.map((o) => grand > 0 ? Math.round((Number(o.total) / grand) * tipCents) : 0);
    if (orders.length > 0) {
      const largestIdx = orders.reduce((mi, o, i, arr) => (Number(o.total) > Number(arr[mi].total) ? i : mi), 0);
      const delta = tipCents - raw.reduce((a, b) => a + b, 0);
      raw[largestIdx] += delta;
    }
    return orders.map((o, i) => ({
      order_id: o.id,
      subtotal: Number(o.subtotal) || 0,
      tax: Number(o.tax) || 0,
      total: Number(o.total) || 0,
      tip_share: raw[i] / 100,
      charge_share: Number(o.total) + raw[i] / 100,
    }));
  })();

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-neutral-900 rounded-2xl shadow-2xl w-full max-w-lg border border-neutral-800 max-h-[90vh] overflow-y-auto relative">
        {terminalSuccess && (
          <div className="absolute inset-0 bg-neutral-900/95 z-10 flex flex-col items-center justify-center rounded-2xl">
            <div className="w-20 h-20 rounded-full bg-cockpit-green flex items-center justify-center mb-4 animate-pulse">
              <svg className="w-10 h-10 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <p className="text-white text-xl font-bold">{t('payment.confirmed')}</p>
            <p className="text-neutral-400 text-sm mt-1">
              {t('cart.cobrarJuntas', { defaultValue: 'Cobrar juntas' })} · {orders.length}
            </p>
          </div>
        )}

        <div className="bg-brand-600 text-white p-6 rounded-t-2xl text-center">
          <h2 className="text-2xl font-black mb-1">{t('cart.cobrarJuntas', { defaultValue: 'Cobrar Juntas' })}</h2>
          <p className="text-brand-200 text-sm">{t('cart.ticketCount', { defaultValue: '{{n}} pedidos', n: orders.length })}</p>
          <p className="text-3xl font-bold mt-2">{formatPrice(subtotalSum)}</p>
        </div>

        <div className="p-4 space-y-4">
          {/* Per-ticket breakdown */}
          <div className="bg-neutral-800 rounded-lg divide-y divide-neutral-700 max-h-40 overflow-y-auto">
            {shares.map((s, i) => {
              const o = orders[i];
              return (
                <div key={s.order_id} className="flex items-center justify-between px-3 py-2 text-sm">
                  <div className="min-w-0">
                    <p className="text-white font-bold">#{o.order_number}</p>
                    {o.customer_name && <p className="text-neutral-400 text-xs truncate">{o.customer_name}</p>}
                  </div>
                  <div className="text-right">
                    <p className="text-white font-mono">{formatPrice(s.total)}</p>
                    {tip > 0 && <p className="text-neutral-500 text-xs">+ {formatPrice(s.tip_share)} tip</p>}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Tip */}
          {!terminalPending && (
            <div>
              <p className="text-sm font-semibold text-white mb-2">{t('payment.selectTip')}</p>
              <div className="grid grid-cols-4 gap-2">
                {[10, 15, 20].map((pct) => {
                  const val = Math.round((subtotalSum * pct) / 100 * 100) / 100;
                  const active = tip === val && !showCustomInput;
                  return (
                    <button
                      key={pct}
                      onClick={() => handleTipSelect(pct)}
                      className={`py-2 text-sm font-bold rounded-lg transition-all ${active ? 'bg-brand-600 text-white' : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700'}`}
                    >
                      {pct}%
                    </button>
                  );
                })}
                <button
                  onClick={() => setShowCustomInput(true)}
                  className={`py-2 text-sm font-bold rounded-lg transition-all ${showCustomInput ? 'bg-brand-600 text-white' : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700'}`}
                >
                  {t('payment.customTip')}
                </button>
              </div>
              <div className="grid grid-cols-4 gap-2 mt-2">
                {[10, 20, 50, 100].map((amt) => (
                  <button
                    key={amt}
                    onClick={() => handleFixedTip(amt)}
                    className={`py-2 text-sm font-bold rounded-lg transition-all ${tip === amt && !showCustomInput ? 'bg-brand-600 text-white' : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700'}`}
                  >
                    ${amt}
                  </button>
                ))}
              </div>
              {showCustomInput && (
                <div className="flex gap-2 mt-2">
                  <input
                    type="number"
                    value={customTip}
                    onChange={(e) => setCustomTip(e.target.value)}
                    placeholder="$0.00"
                    className="flex-1 bg-neutral-800 border border-neutral-700 rounded-lg p-2 text-white focus:outline-none focus:border-brand-600"
                  />
                  <button onClick={handleCustomTip} className="px-4 bg-brand-600 text-white font-bold rounded-lg">
                    {t('common:buttons.ok')}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Totals */}
          <div className="bg-neutral-800 p-3 rounded-lg text-center">
            <p className="text-neutral-400 text-xs">{t('payment.tipAmount', { amount: formatPrice(tip) })}</p>
            <p className="text-2xl font-bold text-brand-500">
              {t('payment.totalWithTip', { amount: formatPrice(finalTotal) })}
            </p>
          </div>

          {/* Cash input */}
          {showCashInput && !terminalPending && (
            <div className="bg-neutral-800 p-3 rounded-lg space-y-2">
              <p className="text-sm font-semibold text-white">{t('payment.amountReceived')}</p>
              <input
                type="number"
                value={amountReceived}
                onChange={(e) => setAmountReceived(e.target.value)}
                placeholder={formatPrice(finalTotal)}
                className="w-full bg-neutral-700 border border-neutral-600 rounded-lg p-2 text-xl text-white text-center font-bold focus:outline-none focus:border-cockpit-green"
                autoFocus
              />
              <div className="grid grid-cols-4 gap-2">
                {[100, 200, 500, 1000].map((amt) => (
                  <button
                    key={amt}
                    onClick={() => setAmountReceived(String(amt))}
                    className="py-2 bg-neutral-600 text-white font-bold rounded-lg hover:bg-neutral-500"
                  >
                    ${amt}
                  </button>
                ))}
              </div>
              {receivedNum > 0 && (
                <div className="text-center pt-2 border-t border-neutral-700">
                  <p className="text-neutral-400 text-xs">{t('payment.changeDue')}</p>
                  <p className="text-xl font-bold text-cockpit-in-text">{formatPrice(changeDue)}</p>
                </div>
              )}
            </div>
          )}

          {terminalPending && (
            <div className="bg-[#009ee3]/10 border border-[#009ee3]/30 rounded-lg p-4 text-center space-y-2">
              <div className="flex items-center justify-center gap-2">
                <div className="w-3 h-3 bg-[#009ee3] rounded-full animate-pulse" />
                <p className="text-[#009ee3] font-bold">{t('payment.terminalWaiting')}</p>
              </div>
              <p className="text-neutral-400 text-sm">{t('payment.terminalReaderPrompt')}</p>
              <button
                onClick={handleCancelTerminal}
                className="text-cockpit-out-text text-sm font-semibold hover:text-cockpit-out-text/90"
              >
                {t('payment.cancelCharge')}
              </button>
            </div>
          )}

          {terminalError && !terminalPending && (
            <p className="text-cockpit-out-text text-sm text-center font-medium">{terminalError}</p>
          )}

          {/* Actions */}
          {!terminalPending && (
            <div className="space-y-2">
              {isMpConnected && (
                <button
                  onClick={handleTerminal}
                  disabled={isProcessing}
                  className="w-full py-3 bg-[#009ee3] text-white text-lg font-bold rounded-lg hover:bg-[#0082c0] disabled:bg-neutral-700"
                >
                  {t('payment.sendToMPTerminal')}
                </button>
              )}
              {showCashInput ? (
                <button
                  onClick={handleCash}
                  disabled={isProcessing || receivedNum < finalTotal}
                  className="w-full py-3 bg-cockpit-green text-white text-lg font-bold rounded-lg disabled:bg-neutral-700"
                >
                  {isProcessing ? t('payment.processing') : t('payment.confirmCash', { change: formatPrice(changeDue) })}
                </button>
              ) : (
                <button
                  onClick={() => setShowCashInput(true)}
                  disabled={isProcessing}
                  className="w-full py-3 bg-neutral-700 text-white text-lg font-bold rounded-lg hover:bg-neutral-600"
                >
                  {t('payment.cashPayment')}
                </button>
              )}
              <button
                onClick={onCancel}
                disabled={isProcessing}
                className="w-full py-3 bg-neutral-800 text-neutral-400 text-sm font-bold rounded-lg hover:bg-neutral-700"
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

export default PayTogetherModal;
