import React, { useState } from 'react';
import { ArrowRight, User, X } from 'lucide-react';

interface Props {
  onSkip: () => void;
  onConfirm: (name: string) => void;
  /** When true, hides skip/X — the cashier needs a name to find this order at the register. */
  required?: boolean;
  title?: string;
  subtitle?: string;
}

const MAX_LEN = 40;

/**
 * Asks anonymous customers for a first name. When `required`, the cashier
 * needs the name to call out the order at pickup — no skip option. Identified
 * loyalty customers never see this modal (their name comes from the session).
 */
const KioskCallNameModal: React.FC<Props> = ({ onSkip, onConfirm, required = false, title, subtitle }) => {
  const [name, setName] = useState('');
  const trimmed = name.trim();
  const canSubmit = required ? trimmed.length > 0 : true;

  const submit = () => {
    if (trimmed.length === 0) {
      if (required) return;
      onSkip();
      return;
    }
    onConfirm(trimmed.slice(0, MAX_LEN));
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-end justify-center sm:items-center z-50 p-4">
      <div className="bg-neutral-900 rounded-xl border border-neutral-800 shadow-2xl w-full max-w-[560px] p-6 sm:p-8 space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-3xl font-black leading-tight">{title || '¿Cómo te llamamos?'}</h2>
            <p className="text-neutral-400 text-base font-bold mt-1">
              {subtitle || 'Te llamamos por tu nombre cuando esté lista tu orden.'}
            </p>
          </div>
          {!required && (
            <button
              onClick={onSkip}
              className="h-12 w-12 rounded-lg bg-neutral-800 active:bg-neutral-700 flex items-center justify-center shrink-0"
              aria-label="Omitir"
            >
              <X className="h-6 w-6" />
            </button>
          )}
        </div>

        <label className="block">
          <span className="sr-only">Tu nombre</span>
          <div className="flex items-center gap-3 bg-neutral-950 border border-neutral-700 rounded-lg px-4 py-3 focus-within:border-brand-500">
            <User className="h-6 w-6 text-neutral-500 shrink-0" />
            <input
              autoFocus
              type="text"
              inputMode="text"
              maxLength={MAX_LEN}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit();
              }}
              placeholder={required ? 'Tu nombre' : 'Tu nombre (opcional)'}
              className="flex-1 bg-transparent outline-none text-2xl font-black placeholder:text-neutral-600"
            />
          </div>
        </label>

        <div className={required ? '' : 'grid grid-cols-2 gap-3'}>
          {!required && (
            <button
              onClick={onSkip}
              className="h-16 rounded-lg bg-neutral-800 active:bg-neutral-700 text-xl font-black touch-manipulation"
            >
              Omitir
            </button>
          )}
          <button
            onClick={submit}
            disabled={!canSubmit}
            className="h-16 w-full rounded-lg bg-brand-600 active:bg-brand-700 disabled:opacity-40 text-xl font-black touch-manipulation inline-flex items-center justify-center gap-2"
          >
            Continuar
            <ArrowRight className="h-6 w-6" />
          </button>
        </div>
      </div>
    </div>
  );
};

export default KioskCallNameModal;
