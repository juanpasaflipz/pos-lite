import React, { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Check } from 'lucide-react';
import { formatPrice } from '../../utils/currency';
import { tapFeedback, successFeedback } from '../../lib/haptics';

interface Props {
  total: number;
  onConfirm: (amountReceived: number) => void;
  onClose: () => void;
  isProcessing: boolean;
}

const QUICK_BILLS = [20, 50, 100, 200, 500];

const MobileCashPayment: React.FC<Props> = ({ total, onConfirm, onClose, isProcessing }) => {
  const { t } = useTranslation('pos');
  const [amount, setAmount] = useState('');

  const amountNum = parseFloat(amount) || 0;
  const change = Math.round((amountNum - total) * 100) / 100;
  const isSufficient = amountNum >= total;

  const handleExact = () => {
    tapFeedback();
    setAmount(total.toFixed(2));
  };

  const handleBill = (value: number) => {
    tapFeedback();
    setAmount(value.toString());
  };

  const handleConfirm = () => {
    if (!isSufficient || isProcessing) return;
    successFeedback();
    onConfirm(amountNum);
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div className="relative bg-neutral-900 rounded-t-3xl flex flex-col animate-slide-up" onClick={(e) => e.stopPropagation()}>
        {/* Handle */}
        <div className="flex justify-center pt-3 pb-1">
          <div className="w-10 h-1 rounded-full bg-neutral-700" />
        </div>

        {/* Header */}
        <div className="flex items-center justify-between px-4 pb-3">
          <h2 className="text-lg font-bold text-white">{t('mobilePOS.payWithCash')}</h2>
          <button onClick={onClose} className="p-2 text-neutral-500 touch-manipulation">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-4 pb-4 space-y-4">
          {/* Total display */}
          <div className="text-center py-3 bg-neutral-800 rounded-2xl">
            <p className="text-neutral-400 text-sm">{t('mobilePOS.total')}</p>
            <p className="text-3xl font-bold text-white">{formatPrice(total)}</p>
          </div>

          {/* Quick bills */}
          <div className="grid grid-cols-3 gap-2">
            <button
              onClick={handleExact}
              className="py-3 rounded-xl bg-brand-600/20 text-brand-400 font-semibold text-sm touch-manipulation active:bg-brand-600/30"
            >
              {t('mobilePOS.exactAmount')}
            </button>
            {QUICK_BILLS.map((bill) => (
              <button
                key={bill}
                onClick={() => handleBill(bill)}
                className="py-3 rounded-xl bg-neutral-800 text-white font-semibold text-sm touch-manipulation active:bg-neutral-700"
              >
                ${bill}
              </button>
            ))}
          </div>

          {/* Custom amount */}
          <div>
            <label className="text-sm text-neutral-400 mb-1 block">{t('mobilePOS.amountReceived')}</label>
            <input
              type="text"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
              placeholder="0.00"
              autoFocus
              className="w-full bg-neutral-800 border border-neutral-700 rounded-xl p-4 text-2xl text-white text-center font-bold focus:outline-none focus:border-brand-600"
            />
          </div>

          {/* Change display */}
          {amountNum > 0 && (
            <div className={`text-center py-2 rounded-xl ${isSufficient ? 'bg-green-600/10' : 'bg-red-600/10'}`}>
              <p className={`text-lg font-bold ${isSufficient ? 'text-green-400' : 'text-red-400'}`}>
                {isSufficient
                  ? t('mobilePOS.changeDue', { amount: formatPrice(change) })
                  : t('mobilePOS.insufficientAmount')}
              </p>
            </div>
          )}

          {/* Confirm */}
          <button
            onClick={handleConfirm}
            disabled={!isSufficient || isProcessing}
            className="w-full py-4 bg-green-600 text-white text-base font-bold rounded-2xl disabled:bg-neutral-700 disabled:text-neutral-500 active:bg-green-700 transition-colors touch-manipulation flex items-center justify-center gap-2"
            style={{ marginBottom: 'env(safe-area-inset-bottom, 0px)' }}
          >
            {isProcessing ? (
              t('mobilePOS.processing')
            ) : (
              <>
                <Check className="w-5 h-5" />
                {t('mobilePOS.confirmCash')}
              </>
            )}
          </button>
        </div>
      </div>

      <style>{`
        @keyframes slide-up {
          from { transform: translateY(100%); }
          to { transform: translateY(0); }
        }
        .animate-slide-up {
          animation: slide-up 0.25s ease-out;
        }
      `}</style>
    </div>
  );
};

export default MobileCashPayment;
