import React, { useState } from 'react';
import { Check, Coins, Loader2, X } from 'lucide-react';
import { addCashTip } from '../../api';

interface CashTipModalProps {
  orderId: number;
  orderNumber: string;
  subtotal: number;
  existingTip: number;
  onClose: () => void;
  onAdded: (added: number) => void;
}

// Quick-add modal for cash tips left after the order was already closed.
// Peso quick-keys mirror the in-checkout PaymentModal fixed-tip presets so
// muscle memory carries across.
const CASH_TIP_PRESETS = [10, 20, 50];

const CashTipModal: React.FC<CashTipModalProps> = ({
  orderId,
  orderNumber,
  subtotal,
  existingTip,
  onClose,
  onAdded,
}) => {
  const [raw, setRaw] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const amount = Number(raw) || 0;
  const overSubtotal = amount > 0 && amount > subtotal;
  const canSubmit = amount > 0 && !overSubtotal && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await addCashTip(orderId, amount);
      onAdded(res.tip_added);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo registrar la propina');
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/80 z-[60] flex items-center justify-center p-4">
      <div className="bg-neutral-950 rounded-2xl shadow-2xl w-full max-w-sm border border-cockpit-green/60 p-5">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <div className="h-10 w-10 rounded-full bg-cockpit-green/20 flex items-center justify-center">
              <Coins className="w-5 h-5 text-cockpit-in-text" />
            </div>
            <div>
              <h3 className="text-lg font-black text-white">Propina en efectivo</h3>
              <p className="text-xs text-neutral-400">Orden #{orderNumber}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-neutral-400 hover:text-white p-1 rounded"
            aria-label="Cerrar"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {existingTip > 0 && (
          <p className="text-xs text-neutral-400 mb-3">
            Propina ya registrada: <span className="text-white font-bold">${existingTip.toFixed(2)}</span>
          </p>
        )}

        <div className="grid grid-cols-3 gap-2 mb-3">
          {CASH_TIP_PRESETS.map((peso) => (
            <button
              key={peso}
              type="button"
              onClick={() => setRaw(String(peso))}
              disabled={submitting}
              className={`h-12 rounded-lg font-bold text-white transition-colors ${
                amount === peso
                  ? 'bg-cockpit-green/40 border border-cockpit-green'
                  : 'bg-neutral-800 hover:bg-neutral-700 border border-neutral-700'
              }`}
            >
              ${peso}
            </button>
          ))}
        </div>

        <label className="text-xs text-neutral-400 block mb-1">Cantidad</label>
        <input
          type="number"
          inputMode="decimal"
          min="0"
          step="0.01"
          autoFocus
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          placeholder="0.00"
          disabled={submitting}
          className="w-full h-12 px-3 rounded-lg bg-neutral-900 border border-neutral-700 text-white text-xl font-bold placeholder:text-neutral-600 focus:outline-none focus:border-cockpit-green"
        />

        {overSubtotal && (
          <p className="text-xs text-cockpit-out-text mt-2">
            La propina no puede ser mayor al subtotal (${subtotal.toFixed(2)}).
          </p>
        )}
        {error && (
          <p className="text-xs text-cockpit-out-text mt-2">{error}</p>
        )}

        <div className="flex gap-2 mt-4">
          <button
            onClick={onClose}
            disabled={submitting}
            className="flex-1 h-12 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-white font-bold"
          >
            Cancelar
          </button>
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="flex-1 h-12 rounded-lg bg-cockpit-green hover:brightness-110 disabled:opacity-50 text-neutral-900 font-black inline-flex items-center justify-center gap-1.5"
          >
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
            Agregar propina
          </button>
        </div>
      </div>
    </div>
  );
};

export default CashTipModal;
