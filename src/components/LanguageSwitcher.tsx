import React from 'react';
import { useTranslation } from 'react-i18next';

interface LanguageSwitcherProps {
  variant?: 'login' | 'nav';
}

const LanguageSwitcher: React.FC<LanguageSwitcherProps> = ({ variant = 'nav' }) => {
  const { i18n } = useTranslation();
  const currentLang = i18n.language?.startsWith('es') ? 'es' : 'en';

  const toggle = (lang: 'en' | 'es') => {
    i18n.changeLanguage(lang);
  };

  const isLogin = variant === 'login';
  const baseHeight = isLogin ? 'h-10' : 'h-8';
  const basePx = isLogin ? 'px-5' : 'px-3';
  const textSize = isLogin ? 'text-base' : 'text-xs';

  return (
    <div className={`inline-flex rounded-lg overflow-hidden border border-neutral-700 ${isLogin ? '' : ''}`}>
      <button
        onClick={() => toggle('en')}
        className={`${baseHeight} ${basePx} ${textSize} font-bold transition-colors ${
          currentLang === 'en'
            ? 'bg-brand-600 text-white'
            : 'bg-neutral-800 text-neutral-400 hover:bg-neutral-700'
        }`}
      >
        EN
      </button>
      <button
        onClick={() => toggle('es')}
        className={`${baseHeight} ${basePx} ${textSize} font-bold transition-colors ${
          currentLang === 'es'
            ? 'bg-brand-600 text-white'
            : 'bg-neutral-800 text-neutral-400 hover:bg-neutral-700'
        }`}
      >
        ES
      </button>
    </div>
  );
};

export default LanguageSwitcher;
