import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatPrice } from '../utils/currency';
import { CartItem } from '../types';

interface SplitPaymentModalProps {
  orderTotal: number;
  items: CartItem[];
  onSplitPayment: (splits: Array<{ payment_method: 'card' | 'cash'; amount: number; tip: number; item_ids?: number[] }>) => void;
  onClose: () => void;
  isProcessing: boolean;
}

type SplitMode = 'even' | 'by_item' | 'custom';

export default function SplitPaymentModal({
  orderTotal,
  items,
  onSplitPayment,
  onClose,
  isProcessing,
}: SplitPaymentModalProps) {
  const { t } = useTranslation('pos');
  const [mode, setMode] = useState<SplitMode | null>(null);
  const [numPeople, setNumPeople] = useState(2);
  const [splits, setSplits] = useState<Array<{ amount: number; method: 'card' | 'cash'; tip: number }>>([]);
  const [itemAssignments, setItemAssignments] = useState<Record<string, number>>({}); // cart_id -> split_index

  // Initialize even splits
  const initEvenSplits = (count: number) => {
    const perPerson = Math.floor(orderTotal / count * 100) / 100;
    const remainder = Math.round((orderTotal - perPerson * count) * 100) / 100;
    const newSplits = Array.from({ length: count }, (_, i) => ({
      amount: i === 0 ? perPerson + remainder : perPerson,
      method: 'card' as const,
      tip: 0,
    }));
    setSplits(newSplits);
  };

  const handleSelectMode = (selectedMode: SplitMode) => {
    setMode(selectedMode);
    if (selectedMode === 'even') {
      initEvenSplits(numPeople);
    } else if (selectedMode === 'by_item') {
      setSplits([
        { amount: 0, method: 'card', tip: 0 },
        { amount: 0, method: 'card', tip: 0 },
      ]);
    } else {
      setSplits([
        { amount: 0, method: 'card', tip: 0 },
        { amount: 0, method: 'card', tip: 0 },
      ]);
    }
  };

  const updateSplitMethod = (index: number, method: 'card' | 'cash') => {
    setSplits((prev) => prev.map((s, i) => (i === index ? { ...s, method } : s)));
  };

  const updateSplitTip = (index: number, tip: number) => {
    setSplits((prev) => prev.map((s, i) => (i === index ? { ...s, tip } : s)));
  };

  const updateCustomAmount = (index: number, amount: number) => {
    setSplits((prev) => prev.map((s, i) => (i === index ? { ...s, amount } : s)));
  };

  const assignItemToSplit = (cartId: string, splitIndex: number) => {
    setItemAssignments((prev) => ({ ...prev, [cartId]: splitIndex }));
    // Recalculate split amounts
    const newAmounts = splits.map(() => 0);
    items.forEach((item) => {
      const idx = cartId === item.cart_id ? splitIndex : (itemAssignments[item.cart_id] ?? 0);
      newAmounts[idx] = (newAmounts[idx] || 0) + item.unit_price * item.quantity;
    });
    setSplits((prev) => prev.map((s, i) => ({ ...s, amount: Math.round(newAmounts[i] * 100) / 100 })));
  };

  const totalAssigned = splits.reduce((sum, s) => sum + s.amount, 0);
  const isBalanced = Math.abs(totalAssigned - orderTotal) < 0.02;

  const handleConfirm = () => {
    const result = splits.map((s) => ({
      payment_method: s.method,
      amount: s.amount,
      tip: s.tip,
    }));
    onSplitPayment(result);
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-neutral-900 rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-hidden border border-neutral-800 flex flex-col">
        <div className="bg-brand-600 text-white p-5 flex-shrink-0">
          <h2 className="text-2xl font-bold">{t('splitPayment.title')}</h2>
          <p className="text-brand-200">{t('splitPayment.total', { amount: formatPrice(orderTotal) })}</p>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {!mode ? (
            <div className="space-y-3">
              <p className="text-white font-semibold mb-4">{t('splitPayment.howToSplit')}</p>
              <button
                onClick={() => handleSelectMode('even')}
                className="w-full p-4 bg-neutral-800 border border-neutral-700 rounded-lg hover:border-brand-600 transition-all text-left"
              >
                <h3 className="text-lg font-bold text-white">{t('splitPayment.splitEvenly')}</h3>
                <p className="text-sm text-neutral-400">{t('splitPayment.splitEvenlyDesc')}</p>
              </button>
              <button
                onClick={() => handleSelectMode('by_item')}
                className="w-full p-4 bg-neutral-800 border border-neutral-700 rounded-lg hover:border-brand-600 transition-all text-left"
              >
                <h3 className="text-lg font-bold text-white">{t('splitPayment.splitByItem')}</h3>
                <p className="text-sm text-neutral-400">{t('splitPayment.splitByItemDesc')}</p>
              </button>
              <button
                onClick={() => handleSelectMode('custom')}
                className="w-full p-4 bg-neutral-800 border border-neutral-700 rounded-lg hover:border-brand-600 transition-all text-left"
              >
                <h3 className="text-lg font-bold text-white">{t('splitPayment.customAmount')}</h3>
                <p className="text-sm text-neutral-400">{t('splitPayment.customAmountDesc')}</p>
              </button>
            </div>
          ) : mode === 'even' ? (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <p className="text-white font-semibold">{t('splitPayment.numberOfPeople')}</p>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => { const n = Math.max(2, numPeople - 1); setNumPeople(n); initEvenSplits(n); }}
                    className="w-10 h-10 bg-neutral-700 text-white font-bold rounded-lg"
                  >
                    −
                  </button>
                  <span className="w-10 text-center font-bold text-white text-xl">{numPeople}</span>
                  <button
                    onClick={() => { const n = Math.min(10, numPeople + 1); setNumPeople(n); initEvenSplits(n); }}
                    className="w-10 h-10 bg-neutral-700 text-white font-bold rounded-lg"
                  >
                    +
                  </button>
                </div>
              </div>

              {splits.map((split, i) => (
                <div key={i} className="bg-neutral-800 rounded-lg p-3 border border-neutral-700">
                  <div className="flex items-center justify-between mb-2">
                    <p className="font-bold text-white">{t('splitPayment.person', { number: i + 1 })}</p>
                    <p className="font-bold text-brand-500">{formatPrice(split.amount)}</p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => updateSplitMethod(i, 'card')}
                      className={`flex-1 py-2 rounded-lg text-sm font-bold ${split.method === 'card' ? 'bg-brand-600 text-white' : 'bg-neutral-700 text-neutral-400'}`}
                    >
                      {t('splitPayment.card')}
                    </button>
                    <button
                      onClick={() => updateSplitMethod(i, 'cash')}
                      className={`flex-1 py-2 rounded-lg text-sm font-bold ${split.method === 'cash' ? 'bg-green-600 text-white' : 'bg-neutral-700 text-neutral-400'}`}
                    >
                      {t('splitPayment.cash')}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : mode === 'custom' ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between mb-2">
                <p className="text-white font-semibold">{t('splitPayment.customSplits')}</p>
                <button
                  onClick={() => setSplits((prev) => [...prev, { amount: 0, method: 'card', tip: 0 }])}
                  className="text-sm text-brand-400 font-bold"
                >
                  {t('splitPayment.addSplit')}
                </button>
              </div>

              {splits.map((split, i) => (
                <div key={i} className="bg-neutral-800 rounded-lg p-3 border border-neutral-700 space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="font-bold text-white">{t('splitPayment.split', { number: i + 1 })}</p>
                    {splits.length > 2 && (
                      <button
                        onClick={() => setSplits((prev) => prev.filter((_, idx) => idx !== i))}
                        className="text-brand-500 text-sm font-bold"
                      >
                        {t('splitPayment.remove')}
                      </button>
                    )}
                  </div>
                  <input
                    type="number"
                    value={split.amount || ''}
                    onChange={(e) => updateCustomAmount(i, parseFloat(e.target.value) || 0)}
                    placeholder={t('splitPayment.amountPlaceholder')}
                    className="w-full bg-neutral-700 border border-neutral-600 rounded-lg p-2 text-white text-center font-bold focus:outline-none focus:border-brand-600"
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={() => updateSplitMethod(i, 'card')}
                      className={`flex-1 py-2 rounded-lg text-sm font-bold ${split.method === 'card' ? 'bg-brand-600 text-white' : 'bg-neutral-700 text-neutral-400'}`}
                    >
                      {t('splitPayment.card')}
                    </button>
                    <button
                      onClick={() => updateSplitMethod(i, 'cash')}
                      className={`flex-1 py-2 rounded-lg text-sm font-bold ${split.method === 'cash' ? 'bg-green-600 text-white' : 'bg-neutral-700 text-neutral-400'}`}
                    >
                      {t('splitPayment.cash')}
                    </button>
                  </div>
                </div>
              ))}

              <div className="bg-neutral-800 p-3 rounded-lg text-center">
                <p className={`font-bold ${isBalanced ? 'text-green-400' : 'text-brand-400'}`}>
                  {t('splitPayment.assigned', { assigned: formatPrice(totalAssigned), total: formatPrice(orderTotal) })}
                  {!isBalanced && ` (${formatPrice(Math.abs(orderTotal - totalAssigned))} ${totalAssigned > orderTotal ? t('splitPayment.over') : t('splitPayment.remaining')})`}
                </p>
              </div>
            </div>
          ) : (
            // by_item mode
            <div className="space-y-4">
              <p className="text-white font-semibold">{t('splitPayment.assignItems')}</p>
              {items.map((item) => (
                <div key={item.cart_id} className="bg-neutral-800 rounded-lg p-3 border border-neutral-700">
                  <div className="flex items-center justify-between mb-2">
                    <div>
                      <p className="font-bold text-white">{item.item_name}</p>
                      <p className="text-sm text-neutral-400">{item.quantity}x {formatPrice(item.unit_price)}</p>
                    </div>
                    <p className="font-bold text-white">{formatPrice(item.unit_price * item.quantity)}</p>
                  </div>
                  <div className="flex gap-2">
                    {splits.map((_, i) => (
                      <button
                        key={i}
                        onClick={() => assignItemToSplit(item.cart_id, i)}
                        className={`flex-1 py-1 rounded text-sm font-bold ${
                          (itemAssignments[item.cart_id] ?? 0) === i
                            ? 'bg-brand-600 text-white'
                            : 'bg-neutral-700 text-neutral-400'
                        }`}
                      >
                        {t('splitPayment.person', { number: i + 1 })}
                      </button>
                    ))}
                  </div>
                </div>
              ))}

              <div className="space-y-2">
                {splits.map((split, i) => (
                  <div key={i} className="flex items-center justify-between bg-neutral-800 p-2 rounded-lg">
                    <span className="text-white font-bold">{t('splitPayment.person', { number: i + 1 })}: {formatPrice(split.amount)}</span>
                    <div className="flex gap-1">
                      <button
                        onClick={() => updateSplitMethod(i, 'card')}
                        className={`px-2 py-1 rounded text-xs font-bold ${split.method === 'card' ? 'bg-brand-600 text-white' : 'bg-neutral-700 text-neutral-400'}`}
                      >
                        {t('splitPayment.card')}
                      </button>
                      <button
                        onClick={() => updateSplitMethod(i, 'cash')}
                        className={`px-2 py-1 rounded text-xs font-bold ${split.method === 'cash' ? 'bg-green-600 text-white' : 'bg-neutral-700 text-neutral-400'}`}
                      >
                        {t('splitPayment.cash')}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="border-t border-neutral-800 p-4 flex-shrink-0 space-y-2">
          {mode && (
            <button
              onClick={handleConfirm}
              disabled={isProcessing || (mode !== 'even' && !isBalanced)}
              className="w-full py-4 bg-brand-600 text-white text-lg font-bold rounded-lg hover:bg-brand-700 disabled:bg-neutral-700 disabled:text-neutral-500 transition-all"
            >
              {isProcessing ? t('splitPayment.processing') : t('splitPayment.processPayments', { count: splits.length })}
            </button>
          )}
          <button
            onClick={mode ? () => setMode(null) : onClose}
            className="w-full py-3 bg-neutral-800 text-neutral-400 font-bold rounded-lg hover:bg-neutral-700 transition-all"
          >
            {mode ? t('splitPayment.back') : t('common:buttons.cancel')}
          </button>
        </div>
      </div>
    </div>
  );
}
