import React from 'react';
import { Languages } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * ES/EN toggle. `large` sits on the AttractScreen; `compact` lives in the
 * KioskMenuScreen header. One tap flips the whole kiosk UI — AttractScreen
 * resets back to Spanish for the next customer (see i18n/resetKioskLanguage).
 */
const LanguageToggle: React.FC<{ size?: 'large' | 'compact' }> = ({ size = 'compact' }) => {
  const { i18n } = useTranslation();
  const isEs = i18n.language.startsWith('es');

  const flip = (e: React.MouseEvent) => {
    // The attract screen wraps the whole viewport in a "start order" button —
    // don't let a language tap start an order.
    e.stopPropagation();
    void i18n.changeLanguage(isEs ? 'en' : 'es');
  };

  if (size === 'large') {
    return (
      <button
        type="button"
        onClick={flip}
        aria-label={isEs ? 'Switch to English' : 'Cambiar a español'}
        className="h-20 px-8 rounded-2xl bg-white/15 active:bg-white/25 border-2 border-white/45 text-white text-2xl font-black touch-manipulation inline-flex items-center gap-3"
      >
        <Languages className="h-8 w-8" />
        {isEs ? 'English' : 'Español'}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={flip}
      aria-label={isEs ? 'Switch to English' : 'Cambiar a español'}
      className="h-16 px-5 rounded-lg bg-neutral-800 active:bg-neutral-700 text-lg font-bold touch-manipulation inline-flex items-center gap-2 shrink-0"
    >
      <Languages className="h-6 w-6" />
      <span>
        <span className={isEs ? 'text-white' : 'text-neutral-500'}>ES</span>
        <span className="text-neutral-600"> / </span>
        <span className={isEs ? 'text-neutral-500' : 'text-white'}>EN</span>
      </span>
    </button>
  );
};

export default LanguageToggle;
