import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useKioskCart } from '../context/KioskCartContext';
import { useIdleTimer } from '../hooks/useIdleTimer';

/**
 * Para Comer Aquí identify screen — name only. Loyalty phone entry moved to
 * the end of the order flow (post-menu / pre-payment). Name is the bridge
 * customers use later to come back and pay or add items.
 */
const KioskIdentifyScreen: React.FC = () => {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { setCallName } = useKioskCart();

  const [name, setName] = useState('');

  const { warning } = useIdleTimer(() => navigate('/'), 120_000);

  const onSubmitName = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setCallName(trimmed);
    navigate('/menu');
  };

  return (
    <div className="h-full w-full bg-neutral-950 text-white flex flex-col items-center justify-center px-10 py-8">
      <div className="text-center mb-8">
        <h1 className="text-4xl xl:text-5xl font-black leading-tight">{t('identify.whatsYourName')}</h1>
        <p className="text-xl text-neutral-400 font-bold mt-3 max-w-xl">
          {t('identify.weCallYou')}
        </p>
      </div>

      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSubmitName();
        }}
        placeholder={t('common.yourName')}
        maxLength={40}
        className="w-[520px] max-w-full h-20 rounded-2xl bg-neutral-900 border-2 border-neutral-700 focus:border-brand-500 outline-none text-center text-3xl font-black px-6"
      />

      <button
        onClick={onSubmitName}
        disabled={!name.trim()}
        className="mt-8 w-[520px] max-w-full h-16 rounded-2xl bg-brand-600 active:bg-brand-700 disabled:bg-neutral-800 disabled:text-neutral-600 text-xl font-black touch-manipulation"
      >
        {t('common.continue')}
      </button>
      {warning}
    </div>
  );
};

export default KioskIdentifyScreen;
