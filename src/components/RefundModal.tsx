import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { getOrder, refundPayment } from '../api';
import { Order, OrderItem } from '../types';
import { formatPrice } from '../utils/currency';
import { X, RotateCcw } from 'lucide-react';

interface RefundModalProps {
  orderId: number;
  onClose: () => void;
  onRefunded: () => void;
}

type RefundMode = 'full' | 'by_items' | 'by_amount';

export default function RefundModal({ orderId, onClose, onRefunded }: RefundModalProps) {
  const { t } = useTranslation('pos');
  const [order, setOrder] = useState<Order | null>(null);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<RefundMode>('full');
  const [reason, setReason] = useState('customer_complaint');
  const [customAmount, setCustomAmount] = useState('');
  const [selectedItems, setSelectedItems] = useState<Record<number, number>>({});

  const REASONS = [
    { value: 'customer_complaint', label: t('refund.reasons.customer_complaint') },
    { value: 'wrong_order', label: t('refund.reasons.wrong_order') },
    { value: 'quality_issue', label: t('refund.reasons.quality_issue') },
    { value: 'duplicate_charge', label: t('refund.reasons.duplicate_charge') },
    { value: 'other', label: t('refund.reasons.other') },
  ];

  useEffect(() => {
    getOrder(orderId)
      .then(setOrder)
      .catch(() => setError(t('refund.failedToLoad')))
      .finally(() => setLoading(false));
  }, [orderId]);

  const refundTotal = order ? order.total - ((order as any).refund_total || 0) : 0;

  const calculateItemsRefundAmount = () => {
    if (!order?.items) return 0;
    let total = 0;
    for (const [itemId, qty] of Object.entries(selectedItems)) {
      const item = order.items.find((i) => i.id === Number(itemId));
      if (item && qty > 0) {
        total += item.unit_price * qty;
      }
    }
    return total;
  };

  const getRefundAmount = () => {
    switch (mode) {
      case 'full':
        return refundTotal;
      case 'by_items':
        return calculateItemsRefundAmount();
      case 'by_amount':
        return parseFloat(customAmount) || 0;
    }
  };

  const toggleItem = (itemId: number, maxQty: number) => {
    setSelectedItems((prev) => {
      const current = prev[itemId] || 0;
      if (current >= maxQty) {
        const { [itemId]: _, ...rest } = prev;
        return rest;
      }
      return { ...prev, [itemId]: current + 1 };
    });
  };

  const handleRefund = async () => {
    if (!order) return;

    const amount = getRefundAmount();
    if (amount <= 0) {
      setError(t('refund.amountMustBePositive'));
      return;
    }
    if (amount > refundTotal) {
      setError(t('refund.amountExceeds', { max: formatPrice(refundTotal) }));
      return;
    }

    setProcessing(true);
    setError(null);

    try {
      const data: any = { order_id: orderId, reason };

      if (mode === 'by_items') {
        data.items = Object.entries(selectedItems)
          .filter(([_, qty]) => qty > 0)
          .map(([id, qty]) => ({ order_item_id: Number(id), quantity: qty }));
      } else if (mode === 'by_amount') {
        data.amount = parseFloat(customAmount);
      }

      await refundPayment(data);
      onRefunded();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('refund.refundFailed'));
    } finally {
      setProcessing(false);
    }
  };

  if (loading) {
    return (
      <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
        <div className="bg-neutral-900 rounded-xl p-8 text-white">{t('refund.loadingOrder')}</div>
      </div>
    );
  }

  if (!order) {
    return (
      <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
        <div className="bg-neutral-900 rounded-xl p-8 text-white">
          <p className="text-brand-400">{error || t('refund.orderNotFound')}</p>
          <button onClick={onClose} className="mt-4 px-4 py-2 bg-neutral-700 rounded-lg">{t('refund.close')}</button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-neutral-900 rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto border border-neutral-800">
        <div className="bg-brand-600 text-white p-6 rounded-t-2xl flex items-center justify-between">
          <div className="flex items-center gap-3">
            <RotateCcw size={24} />
            <div>
              <h2 className="text-2xl font-bold">{t('refund.title')}</h2>
              <p className="text-brand-100">#{order.order_number}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-brand-700 rounded-lg">
            <X size={20} />
          </button>
        </div>

        <div className="p-6 space-y-6">
          <div className="flex justify-between text-sm">
            <span className="text-neutral-400">{t('refund.orderTotal')}</span>
            <span className="text-white font-bold">{formatPrice(order.total)}</span>
          </div>
          {(order as any).refund_total > 0 && (
            <div className="flex justify-between text-sm">
              <span className="text-neutral-400">{t('refund.alreadyRefunded')}</span>
              <span className="text-brand-400 font-bold">{formatPrice((order as any).refund_total)}</span>
            </div>
          )}
          <div className="flex justify-between text-sm border-t border-neutral-700 pt-2">
            <span className="text-neutral-400">{t('refund.refundable')}</span>
            <span className="text-white font-bold">{formatPrice(refundTotal)}</span>
          </div>

          {/* Refund Mode */}
          <div>
            <p className="text-sm font-semibold text-white mb-2">{t('refund.refundType')}</p>
            <div className="grid grid-cols-3 gap-2">
              {(['full', 'by_items', 'by_amount'] as RefundMode[]).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={`py-2 px-3 text-sm font-bold rounded-lg transition-colors ${
                    mode === m ? 'bg-brand-600 text-white' : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700'
                  }`}
                >
                  {m === 'full' ? t('refund.full') : m === 'by_items' ? t('refund.byItems') : t('refund.byAmount')}
                </button>
              ))}
            </div>
          </div>

          {/* Item Selection */}
          {mode === 'by_items' && order.items && (
            <div className="space-y-2">
              <p className="text-sm font-semibold text-white">{t('refund.selectItems')}</p>
              {order.items.map((item) => (
                <div
                  key={item.id}
                  onClick={() => toggleItem(item.id!, item.quantity)}
                  className={`flex items-center justify-between p-3 rounded-lg cursor-pointer transition-colors ${
                    selectedItems[item.id!] ? 'bg-brand-900/30 border border-brand-700' : 'bg-neutral-800 border border-neutral-700'
                  }`}
                >
                  <div>
                    <p className="text-white font-medium">{item.item_name}</p>
                    <p className="text-neutral-400 text-sm">
                      {formatPrice(item.unit_price)} x {item.quantity}
                    </p>
                  </div>
                  <div className="text-right">
                    {selectedItems[item.id!] ? (
                      <span className="bg-brand-600 text-white px-3 py-1 rounded-full text-sm font-bold">
                        x{selectedItems[item.id!]}
                      </span>
                    ) : (
                      <span className="text-neutral-500 text-sm">{t('refund.tapToSelect')}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Custom Amount */}
          {mode === 'by_amount' && (
            <div>
              <p className="text-sm font-semibold text-white mb-2">{t('refund.refundAmountMXN')}</p>
              <input
                type="number"
                value={customAmount}
                onChange={(e) => setCustomAmount(e.target.value)}
                placeholder="0.00"
                min="0"
                max={refundTotal}
                step="0.01"
                className="w-full bg-neutral-800 border border-neutral-700 rounded-lg p-3 text-white text-lg focus:outline-none focus:border-brand-600"
              />
            </div>
          )}

          {/* Reason */}
          <div>
            <p className="text-sm font-semibold text-white mb-2">{t('refund.reason')}</p>
            <select
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="w-full bg-neutral-800 border border-neutral-700 rounded-lg p-3 text-white focus:outline-none focus:border-brand-600"
            >
              {REASONS.map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
          </div>

          {error && (
            <p className="text-brand-400 text-sm bg-brand-900/20 p-3 rounded-lg">{error}</p>
          )}

          {/* Summary */}
          <div className="bg-neutral-800 rounded-lg p-4 text-center">
            <p className="text-neutral-400 text-sm">{t('refund.refundAmount')}</p>
            <p className="text-3xl font-bold text-brand-400">{formatPrice(getRefundAmount())}</p>
          </div>

          {/* Actions */}
          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="flex-1 py-3 bg-neutral-700 text-white font-bold rounded-lg hover:bg-neutral-600 transition-colors"
            >
              {t('common:buttons.cancel')}
            </button>
            <button
              onClick={handleRefund}
              disabled={processing || getRefundAmount() <= 0}
              className="flex-1 py-3 bg-brand-600 text-white font-bold rounded-lg hover:bg-brand-700 disabled:bg-neutral-700 disabled:text-neutral-500 transition-colors"
            >
              {processing ? t('refund.processing') : t('refund.processRefund')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
