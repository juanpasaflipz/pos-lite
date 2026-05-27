import React, { useState } from 'react';
import { Trash2, X } from 'lucide-react';

interface VoidReasonModalProps {
  itemName: string;
  onConfirm: (reason: string) => void;
  onClose: () => void;
}

// Quick reasons cover ~95% of void cases — three taps and done. The free-text
// fallback exists for the long tail (e.g., "cliente alérgico", "se cayó").
// Backend requires min 2 chars; all canned strings clear that bar.
const QUICK_REASONS = [
  'No hay',
  'Cliente cambió',
  'Error de captura',
];

const VoidReasonModal: React.FC<VoidReasonModalProps> = ({ itemName, onConfirm, onClose }) => {
  const [custom, setCustom] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = (reason: string) => {
    const trimmed = reason.trim();
    if (trimmed.length < 2 || submitting) return;
    setSubmitting(true);
    onConfirm(trimmed);
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[70] p-4">
      <div className="bg-neutral-900 rounded-2xl shadow-2xl w-full max-w-md border border-neutral-800">
        <div className="bg-cockpit-red text-white p-5 rounded-t-2xl flex items-center gap-3">
          <Trash2 className="w-5 h-5" />
          <div className="flex-1 min-w-0">
            <h2 className="text-lg font-bold">Cancelar producto</h2>
            <p className="text-white/80 text-xs truncate">{itemName}</p>
          </div>
          <button
            onClick={onClose}
            disabled={submitting}
            className="p-1 text-white/70 hover:text-white disabled:opacity-50"
            aria-label="Cerrar"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-5 space-y-4">
          <p className="text-sm text-neutral-400 font-semibold">¿Por qué se cancela?</p>
          <div className="grid grid-cols-1 gap-2">
            {QUICK_REASONS.map((reason) => (
              <button
                key={reason}
                onClick={() => submit(reason)}
                disabled={submitting}
                className="h-14 rounded-lg bg-neutral-800 hover:bg-neutral-700 active:bg-neutral-600 disabled:opacity-40 text-white text-lg font-bold touch-manipulation transition-colors"
              >
                {reason}
              </button>
            ))}
          </div>

          <div className="relative">
            <div className="absolute inset-0 flex items-center" aria-hidden="true">
              <div className="w-full border-t border-neutral-800" />
            </div>
            <div className="relative flex justify-center">
              <span className="bg-neutral-900 px-2 text-xs text-neutral-500 font-bold uppercase tracking-wider">
                u otra razón
              </span>
            </div>
          </div>

          <input
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && custom.trim().length >= 2) submit(custom);
            }}
            placeholder="Escribe la razón…"
            maxLength={120}
            className="w-full h-12 rounded-lg bg-neutral-950 border border-neutral-700 focus:border-cockpit-red outline-none px-4 text-white"
          />

          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={onClose}
              disabled={submitting}
              className="h-12 rounded-lg bg-neutral-700 text-white text-sm font-bold hover:bg-neutral-600 disabled:opacity-50 transition-colors"
            >
              Cancelar
            </button>
            <button
              onClick={() => submit(custom)}
              disabled={submitting || custom.trim().length < 2}
              className="h-12 rounded-lg bg-cockpit-red text-white text-sm font-bold hover:bg-cockpit-red/90 disabled:opacity-40 transition-colors"
            >
              {submitting ? '…' : 'Confirmar'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default VoidReasonModal;
