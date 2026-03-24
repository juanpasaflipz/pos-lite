import React, { useState } from 'react';
import { confirmOrderPayment } from '../api';
import { Order, OrderItem } from '../types';
import { formatPrice } from '../utils/currency';

type PaymentMethod = 'cash' | 'card' | 'transfer';

interface PaymentConfirmationModalProps {
  isOpen: boolean;
  onClose: () => void;
  order: { id: number; total: number; order_number?: string; items?: OrderItem[] };
  onPaymentConfirmed: (method: PaymentMethod) => void;
}

const METHODS: { key: PaymentMethod; icon: string; label: string }[] = [
  { key: 'cash', icon: '\uD83D\uDCB5', label: 'Cash' },
  { key: 'card', icon: '\uD83D\uDCB3', label: 'Card' },
  { key: 'transfer', icon: '\uD83D\uDCF2', label: 'Transfer' },
];

const PaymentConfirmationModal: React.FC<PaymentConfirmationModalProps> = ({
  isOpen,
  onClose,
  order,
  onPaymentConfirmed,
}) => {
  const [selectedMethod, setSelectedMethod] = useState<PaymentMethod | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');
  const [reference, setReference] = useState('');

  if (!isOpen) return null;

  const handleConfirm = async () => {
    if (!selectedMethod || loading) return;

    setLoading(true);
    setError('');

    try {
      await confirmOrderPayment(order.id, selectedMethod, reference || undefined);
      setSuccess(true);
      setTimeout(() => {
        onPaymentConfirmed(selectedMethod);
        onClose();
        // Reset state for next usage
        setSelectedMethod(null);
        setSuccess(false);
        setReference('');
      }, 1200);
    } catch (err) {
      setError('Error processing payment. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    if (loading || success) return;
    setSelectedMethod(null);
    setError('');
    setReference('');
    onClose();
  };

  return (
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
      onClick={handleClose}
    >
      <div
        className="bg-neutral-900 rounded-2xl shadow-2xl w-full max-w-[480px] border border-neutral-800 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Success overlay */}
        {success && (
          <div className="absolute inset-0 bg-neutral-900/95 z-10 flex flex-col items-center justify-center rounded-2xl">
            <div className="w-20 h-20 rounded-full bg-green-600 flex items-center justify-center mb-4 animate-pulse">
              <svg className="w-10 h-10 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <p className="text-white text-xl font-bold">Payment confirmed</p>
          </div>
        )}

        {/* Header */}
        <div className="bg-brand-600 text-white p-6 text-center">
          <p className="text-sm text-brand-200 font-semibold mb-1">
            {order.order_number ? `Order #${order.order_number}` : 'Confirm payment'}
          </p>
          <p className="text-5xl font-bold tracking-tight">
            {formatPrice(order.total)}
          </p>
        </div>

        {/* Method buttons */}
        <div className="p-6 space-y-3">
          {METHODS.map((method) => (
            <button
              key={method.key}
              onClick={() => {
                setSelectedMethod(method.key);
                setError('');
              }}
              disabled={loading || success}
              className={`w-full flex items-center gap-4 p-4 rounded-xl border-2 text-left transition-all ${
                selectedMethod === method.key
                  ? 'border-brand-600 bg-brand-600/10 text-white'
                  : 'border-neutral-700 bg-neutral-800 text-neutral-300 hover:border-neutral-600'
              } disabled:opacity-50 disabled:cursor-not-allowed`}
            >
              <span className="text-2xl">{method.icon}</span>
              <span className="text-lg font-bold">{method.label}</span>
              {selectedMethod === method.key && (
                <svg className="w-5 h-5 ml-auto text-brand-400" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                </svg>
              )}
            </button>
          ))}

          {/* Reference field for Transferencia */}
          {selectedMethod === 'transfer' && (
            <input
              type="text"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="Reference (optional)"
              className="w-full px-4 py-3 bg-neutral-800 border border-neutral-700 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:border-brand-600 text-sm"
            />
          )}

          {/* Error message */}
          {error && (
            <p className="text-red-400 text-sm text-center font-medium">{error}</p>
          )}

          {/* Confirm button */}
          <button
            onClick={handleConfirm}
            disabled={!selectedMethod || loading || success}
            className="w-full py-3.5 bg-brand-600 text-white text-lg font-bold rounded-xl hover:bg-brand-700 disabled:bg-neutral-800 disabled:text-neutral-600 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
            style={{ height: 52 }}
          >
            {loading ? (
              <svg className="animate-spin h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
            ) : (
              'Confirm Payment'
            )}
          </button>

          {/* Cancel */}
          <button
            onClick={handleClose}
            disabled={loading || success}
            className="w-full py-3 text-neutral-400 text-sm font-semibold hover:text-white transition-all"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
};

export default PaymentConfirmationModal;
