// Call-out name keyboard, as a sheet over the cart.
//
// The name used to be its own full-screen step between "¿para aquí o para
// llevar?" and payment. It is optional now and lives on the cart screen, so the
// keyboard only appears for the guests who want to give one.
//
// It is still our own keyboard rather than a plain <input>: the kiosk has no
// hardware keyboard, and the tablet's IME covers half the screen on Android and
// would hide the Pay button the guest is one tap away from.
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';

const ROWS = ['QWERTYUIOP', 'ASDFGHJKLÑ', 'ZXCVBNM'];
export const CALL_NAME_MAX_LEN = 18;
const BACKSPACE = '⌫';

interface Props {
  initial: string;
  /** Called with the trimmed name; an empty string clears it. */
  onDone: (name: string) => void;
  onClose: () => void;
}

const CallNameKeyboard: React.FC<Props> = ({ initial, onDone, onClose }) => {
  const { t } = useTranslation();
  const [name, setName] = useState(initial);

  const press = (key: string) => {
    if (key === BACKSPACE) {
      setName((n) => n.slice(0, -1));
      return;
    }
    setName((n) => (n.length < CALL_NAME_MAX_LEN ? n + key : n));
  };

  const keyClass =
    'flex-1 max-w-16 min-h-14 rounded-lg bg-neutral-800 active:bg-brand-600 text-xl font-black touch-manipulation';

  return (
    <div
      className="fixed inset-0 z-40 bg-black/70 flex flex-col justify-end"
      role="dialog"
      aria-modal="true"
      aria-label={t('cart.nameTitle')}
      onClick={onClose}
    >
      <div
        className="bg-neutral-950 border-t border-neutral-700 rounded-t-2xl px-4 pt-4 pb-4 pb-safe"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="max-w-2xl mx-auto flex flex-col gap-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-2xl sm:text-3xl font-black leading-tight">{t('cart.nameTitle')}</h2>
              <p className="text-sm sm:text-base text-neutral-400 font-bold mt-1">{t('callName.hint')}</p>
            </div>
            <button
              onClick={onClose}
              className="h-11 px-4 rounded-lg bg-neutral-800 active:bg-neutral-700 text-sm font-bold touch-manipulation flex-shrink-0"
            >
              {t('common.cancel')}
            </button>
          </div>

          <div className="min-h-16 rounded-2xl bg-neutral-900 border-2 border-neutral-700 flex items-center justify-center px-4 py-2 text-3xl sm:text-4xl font-black tracking-wide">
            {name}
            <span className="inline-block w-1 h-8 bg-brand-400 ml-1 motion-safe:animate-pulse" aria-hidden="true" />
          </div>

          <div className="flex flex-col gap-2">
            {ROWS.map((row) => (
              <div key={row} className="flex gap-1.5 justify-center">
                {[...row].map((k) => (
                  <button key={k} onClick={() => press(k)} className={keyClass}>
                    {k}
                  </button>
                ))}
              </div>
            ))}
            <div className="flex gap-1.5 justify-center">
              <button
                onClick={() => press(' ')}
                className="flex-[3] min-h-14 rounded-lg bg-neutral-800 active:bg-brand-600 text-sm font-black tracking-widest touch-manipulation"
              >
                {t('callName.space')}
              </button>
              <button onClick={() => press(BACKSPACE)} aria-label={t('callName.erase')} className={keyClass}>
                {BACKSPACE}
              </button>
            </div>
          </div>

          <button
            onClick={() => onDone(name.trim())}
            className="w-full min-h-16 rounded-lg bg-brand-600 active:bg-brand-700 text-xl sm:text-2xl font-black touch-manipulation"
          >
            {name.trim() ? t('callName.done') : t('callName.noName')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default CallNameKeyboard;
