import React from 'react';
import { ChevronLeft, ShoppingBag, Utensils } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useKioskBinding } from '../context/KioskBindingContext';
import { useKioskCart, type KioskFulfillmentType } from '../context/KioskCartContext';
import { useIdleTimer } from '../hooks/useIdleTimer';
import LanguageToggle from '../components/LanguageToggle';
import { BuilderIcon } from '../lib/builderIcons';

const KioskFulfillmentScreen: React.FC = () => {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { kioskMode } = useKioskBinding();
  const { setFulfillmentType } = useKioskCart();

  const { warning } = useIdleTimer(() => navigate('/'), 60_000);

  // Wizard mode asks this at the END of the flow, after the cart (D11), so the
  // answer rides on the finished order and the next stop is the call-out name.
  // Grid mode still asks it first and continues to name-only identify.
  const wizard = kioskMode === 'wizard';

  const choose = (type: KioskFulfillmentType) => {
    setFulfillmentType(type);
    if (wizard) {
      navigate('/name');
      return;
    }
    // Both Para Aquí and Para Llevar: name-only identify → menu. Loyalty phone
    // enrollment is deferred to the post-payment QR on the confirmation screen.
    navigate('/identify');
  };

  if (wizard) {
    return (
      <div className="h-full w-full bg-neutral-950 text-neutral-50 flex flex-col">
        <header className="flex items-center justify-between gap-3 px-4 py-3 pt-safe border-b border-neutral-800 flex-shrink-0">
          <div className="min-w-0">
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-neutral-500 mb-0.5">
              {t('wizard.fulfillK')}
            </p>
            <h1 className="text-[clamp(22px,4.5vw,40px)] font-black leading-[1.05] truncate">
              {t('wizard.fulfillQ')}
            </h1>
          </div>
          <div className="flex gap-2 flex-shrink-0">
            <LanguageToggle />
            <button
              onClick={() => navigate('/cart')}
              className="h-11 px-3.5 rounded-[10px] bg-neutral-800 active:bg-neutral-700 text-sm font-extrabold inline-flex items-center gap-1.5"
            >
              <ChevronLeft className="h-4 w-4" />
              {t('wizard.back')}
            </button>
          </div>
        </header>

        <main className="flex-1 min-h-0 overflow-y-auto p-4">
          <div className="grid grid-cols-2 gap-4 max-w-[700px] mx-auto mt-[6vh]">
            {([
              { key: 'for_here' as const, icon: 'utensils' as const, label: t('wizard.forHere') },
              { key: 'to_go' as const, icon: 'bag' as const, label: t('wizard.toGo') },
            ]).map((o) => (
              <button
                key={o.key}
                onClick={() => choose(o.key)}
                className="min-h-[230px] rounded-2xl border-2 border-neutral-800 bg-neutral-900 p-[18px_14px] flex flex-col items-center justify-center gap-2 text-center active:scale-[0.96] transition-transform touch-manipulation"
              >
                <BuilderIcon name={o.icon} className="h-[72px] w-[72px] text-brand-300" />
                <span className="text-[clamp(20px,3.5vw,28px)] font-black leading-[1.15]">{o.label}</span>
              </button>
            ))}
          </div>
        </main>

        {warning}
      </div>
    );
  }

  return (
    <div className="h-full w-full bg-neutral-950 text-white flex flex-col">
      <main className="flex-1 px-5 py-6 sm:px-10 sm:py-10 flex flex-col items-center justify-center pt-safe pb-safe">
        <h1 className="text-3xl sm:text-5xl xl:text-6xl font-black text-center leading-tight sm:leading-none mb-6 sm:mb-10">
          {t('fulfillment.howDoYouWantIt')}
        </h1>

        {/* Two side-by-side 360px-tall boxes were designed for the tablet's
            wide viewport. On a phone, stack them so each still reads as a big
            tap target instead of squeezing two into ~150px each. */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6 w-full max-w-4xl">
          <button
            onClick={() => choose('for_here')}
            className="min-h-[140px] sm:min-h-[360px] rounded-lg bg-brand-600 active:bg-brand-700 text-white touch-manipulation flex flex-col items-center justify-center gap-3 sm:gap-7 px-6"
          >
            <Utensils className="h-10 w-10 sm:h-24 sm:w-24" />
            <span className="text-2xl sm:text-4xl xl:text-5xl font-black leading-none text-center">{t('fulfillment.forHere')}</span>
          </button>

          <button
            onClick={() => choose('to_go')}
            className="min-h-[140px] sm:min-h-[360px] rounded-lg bg-neutral-800 active:bg-neutral-700 text-white touch-manipulation flex flex-col items-center justify-center gap-3 sm:gap-7 px-6"
          >
            <ShoppingBag className="h-10 w-10 sm:h-24 sm:w-24" />
            <span className="text-2xl sm:text-4xl xl:text-5xl font-black leading-none text-center">{t('fulfillment.toGo')}</span>
          </button>
        </div>
      </main>
      {warning}
    </div>
  );
};

export default KioskFulfillmentScreen;
