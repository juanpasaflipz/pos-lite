import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Delete, X } from 'lucide-react';
import { formatPrice } from '../../utils/currency';

interface OpenAmountModalProps {
  onClose: () => void;
  onConfirm: (amount: number, label: string) => void;
}

// Mirrors the server's OPEN_AMOUNT_MAX so the cashier is stopped at the keypad
// rather than by a 400 after they've already turned to the customer.
const MAX_AMOUNT = 999999.99;

// Centavo-first entry, the way every card terminal and every calculator-style
// POS keypad behaves: digits push in from the right, so "4" "5" "0" "0" reads
// $45.00. Typing a decimal point is the thing cashiers get wrong under
// pressure, so there isn't one.
const pushDigit = (digits: string, next: string) =>
  (digits + next).replace(/^0+/, '').slice(0, 8);

export default function OpenAmountModal({ onClose, onConfirm }: OpenAmountModalProps) {
  const { t } = useTranslation('pos');
  const [digits, setDigits] = useState('');
  const [label, setLabel] = useState('');

  const amount = Number(digits || '0') / 100;
  const canSubmit = amount > 0 && amount <= MAX_AMOUNT;

  const handleConfirm = () => {
    if (!canSubmit) return;
    onConfirm(amount, label.trim());
  };

  const keys = ['7', '8', '9', '4', '5', '6', '1', '2', '3', '0', '00'];

  return (
    <div className="fixed inset-0 bg-black/80 z-[60] flex items-center justify-center p-4">
      <div className="bg-neutral-950 rounded-2xl shadow-2xl w-full max-w-sm border border-neutral-700 p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-black text-white">{t('openAmount.title')}</h3>
          <button
            onClick={onClose}
            className="text-neutral-400 hover:text-white p-1 rounded"
            aria-label={t('openAmount.close')}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="rounded-xl bg-neutral-900 border border-neutral-800 px-4 py-5 mb-3 text-right">
          <span className={`text-4xl font-black tabular-nums ${amount > 0 ? 'text-white' : 'text-neutral-600'}`}>
            {formatPrice(amount)}
          </span>
        </div>

        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value.slice(0, 60))}
          placeholder={t('openAmount.labelPlaceholder')}
          className="w-full h-11 px-3 mb-3 rounded-lg bg-neutral-900 border border-neutral-700 text-white text-sm placeholder:text-neutral-600 focus:outline-none focus:border-brand-500"
        />

        <div className="grid grid-cols-3 gap-2">
          {keys.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setDigits((d) => pushDigit(d, key))}
              className="h-14 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-white text-xl font-bold transition-colors touch-manipulation"
            >
              {key}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setDigits((d) => d.slice(0, -1))}
            aria-label={t('openAmount.backspace')}
            className="h-14 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-white transition-colors touch-manipulation flex items-center justify-center"
          >
            <Delete className="w-5 h-5" />
          </button>
        </div>

        <div className="flex gap-2 mt-4">
          <button
            onClick={onClose}
            className="flex-1 h-12 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-white font-bold"
          >
            {t('openAmount.cancel')}
          </button>
          <button
            onClick={handleConfirm}
            disabled={!canSubmit}
            className="flex-1 h-12 rounded-lg bg-brand-500 hover:brightness-110 disabled:bg-neutral-800 disabled:text-neutral-600 text-white font-black inline-flex items-center justify-center gap-1.5"
          >
            <Check className="w-4 h-4" />
            {t('openAmount.add')}
          </button>
        </div>
      </div>
    </div>
  );
}
