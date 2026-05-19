import React, { useState } from 'react';
import { ArrowRight, User, X } from 'lucide-react';

interface Props {
  onSkip: () => void;
  onConfirm: (name: string) => void;
}

const MAX_LEN = 40;

/**
 * Asks anonymous customers for a first name so the cashier can call out the
 * order when it's ready. Strictly optional — Skip continues the flow with no
 * name set. Identified loyalty customers never see this modal (their name
 * already comes from the session).
 */
const KioskCallNameModal: React.FC<Props> = ({ onSkip, onConfirm }) => {
  const [name, setName] = useState('');

  const submit = () => {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
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
            <h2 className="text-3xl font-black leading-tight">¿Cómo te llamamos?</h2>
            <p className="text-neutral-400 text-base font-bold mt-1">
              Te llamamos por tu nombre cuando esté lista tu orden.
            </p>
          </div>
          <button
            onClick={onSkip}
            className="h-12 w-12 rounded-lg bg-neutral-800 active:bg-neutral-700 flex items-center justify-center shrink-0"
            aria-label="Omitir"
          >
            <X className="h-6 w-6" />
          </button>
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
              placeholder="Tu nombre (opcional)"
              className="flex-1 bg-transparent outline-none text-2xl font-black placeholder:text-neutral-600"
            />
          </div>
        </label>

        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={onSkip}
            className="h-16 rounded-lg bg-neutral-800 active:bg-neutral-700 text-xl font-black touch-manipulation"
          >
            Omitir
          </button>
          <button
            onClick={submit}
            className="h-16 rounded-lg bg-brand-600 active:bg-brand-700 text-xl font-black touch-manipulation inline-flex items-center justify-center gap-2"
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
