import React, { useEffect, useRef } from 'react';
import { Hand } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useKioskBinding } from '../context/KioskBindingContext';
import { useKioskCustomer } from '../context/KioskCustomerContext';
import { useKioskCart } from '../context/KioskCartContext';
import { resetKioskLanguage } from '../i18n';
import LanguageToggle from '../components/LanguageToggle';
import type { WizardPreset } from './BuilderWizardScreen';

const AttractScreen: React.FC = () => {
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const { tenantName, kioskMode } = useKioskBinding();
  const { clearSession } = useKioskCustomer();
  const { clearCart } = useKioskCart();

  // The attract screen is the start of every order — reset any leftover
  // customer session, cart, or language choice from a previous interaction.
  useEffect(() => {
    clearSession();
    clearCart();
    resetKioskLanguage();
  }, [clearSession, clearCart]);

  // Hidden admin gesture: 5 taps in the top-right corner within 3 seconds opens
  // device settings (terminal pairing). Customer-facing taps still go to /home.
  const tapsRef = useRef<number[]>([]);
  const onAdminTap = (e: React.MouseEvent) => {
    e.stopPropagation();
    const now = Date.now();
    tapsRef.current = [...tapsRef.current.filter((t) => now - t < 3000), now];
    if (tapsRef.current.length >= 5) {
      tapsRef.current = [];
      navigate('/terminal-settings');
    }
  };

  // Grid mode — unchanged from before Phase 2. iPad + every non-wizard device
  // sees exactly this UI, byte-for-byte.
  if (kioskMode !== 'wizard') {
    return (
      <div className="relative h-full w-full">
        <button
          onClick={() => navigate('/fulfillment')}
          className="h-full w-full bg-brand-700 flex flex-col items-center justify-center text-white touch-manipulation px-6 sm:px-8 pt-safe pb-safe"
        >
          {tenantName && (
            <div className="text-base sm:text-2xl text-white/75 mb-2 sm:mb-4 uppercase tracking-widest font-black">
              {tenantName}
            </div>
          )}
          <div className="text-5xl sm:text-6xl md:text-7xl lg:text-[96px] font-black tracking-tight mb-3 sm:mb-6 text-center leading-none">
            {t('attract.orderHere')}
          </div>
          <div className="text-xl sm:text-2xl md:text-4xl font-black text-white/85 mb-6 sm:mb-16">{t('attract.tapToStart')}</div>
          <div className="w-20 h-20 sm:w-28 sm:h-28 lg:w-36 lg:h-36 rounded-full border-4 border-white/45 flex items-center justify-center motion-safe:animate-pulse">
            <Hand className="h-10 w-10 sm:h-14 sm:w-14 lg:h-20 lg:w-20" />
          </div>
        </button>
        <div className="absolute bottom-4 left-4 sm:bottom-8 sm:left-8 pb-safe">
          <LanguageToggle size="large" />
        </div>
        <button
          type="button"
          aria-label="Admin"
          onClick={onAdminTap}
          className="absolute top-0 right-0 w-32 h-32 sm:w-48 sm:h-48 flex items-start justify-end p-3 pt-safe"
        >
          <span className="block w-2 h-2 rounded-full bg-white/30" aria-hidden="true" />
        </button>
      </div>
    );
  }

  // Wizard mode — preset tiles + fallback to /wizard from scratch. Preset
  // navigation goes through /fulfillment first (still need for-here/to-go for
  // the kitchen ticket), then hits the wizard with state pre-seeded.
  const en = i18n.language.startsWith('en');
  const presets: Array<{ label: string; sub: string; preset: WizardPreset }> = [
    { label: en ? 'El California'      : 'El California',      sub: en ? 'Carne Asada, California style'  : 'Carne Asada, estilo California', preset: { slug: 'asada',      estiloName: 'California' } },
    { label: en ? 'Pollos Hermanos'    : 'Pollos Hermanos',    sub: en ? 'Grilled Chicken, Mission style' : 'Pollo Asado, estilo Mission',    preset: { slug: 'pollo',      estiloName: 'Mission' } },
    { label: en ? 'Breakfast'          : 'Breakfast',          sub: en ? 'Egg, California style'          : 'Huevo, estilo California',       preset: { slug: 'huevo',      estiloName: 'California' } },
    { label: en ? 'Surf-N-Turf'        : 'Surf-N-Turf',        sub: en ? 'Asada + Shrimp, Mission'        : 'Asada + Camarón, Mission',       preset: { slug: 'asada',      estiloName: 'Mission', segundaName: 'Camarón' } },
    { label: en ? 'Carne Asada Fries'  : 'Carne Asada Fries',  sub: en ? 'Asada over fries'               : 'Asada sobre papas',              preset: { slug: 'asada',      estiloName: 'Fries' } },
    { label: en ? 'Birria Burrito'     : 'Burrito de Birria',  sub: '$99',                                preset: { slug: 'birria' } },
    { label: en ? 'Cochinita Burrito'  : 'Burrito Cochinita',  sub: '$99',                                preset: { slug: 'cochinita' } },
    { label: en ? 'Rollbertos'         : 'Rollbertos',         sub: '$139',                               preset: { slug: 'rollbertos' } },
  ];

  const startPreset = (preset: WizardPreset) => {
    // Stash preset + wizard-destination flag in sessionStorage so the intervening
    // fulfillment + identify screens don't need to forward router state. Read
    // and cleared in BuilderWizardScreen; identify redirects to /wizard when
    // this flag is set instead of the default /menu.
    sessionStorage.setItem('kiosk-wizard-preset', JSON.stringify(preset));
    sessionStorage.setItem('kiosk-post-identify-path', '/wizard');
    navigate('/fulfillment');
  };
  const startFromScratch = () => {
    sessionStorage.removeItem('kiosk-wizard-preset');
    sessionStorage.setItem('kiosk-post-identify-path', '/wizard');
    navigate('/fulfillment');
  };

  return (
    <div className="relative h-full w-full bg-neutral-950 text-white flex flex-col pt-safe pb-safe px-4 sm:px-8">
      <div className="flex items-center justify-between py-4">
        <div>
          {tenantName && (
            <div className="text-sm sm:text-lg text-white/70 uppercase tracking-widest font-black">
              {tenantName}
            </div>
          )}
          <div className="text-2xl sm:text-4xl font-black">{t('wizardAttract.title')}</div>
        </div>
        <LanguageToggle />
      </div>

      {/* Grid: content-start + auto-rows-min keeps tiles at their natural
          height so they don't stretch to fill the remaining vertical space.
          Two rows of four on tablet, one column stacked on phone. */}
      <div className="flex-1 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 sm:gap-4 pb-4 content-start auto-rows-min">
        {presets.map((p) => (
          <button
            key={p.label + p.sub}
            onClick={() => startPreset(p.preset)}
            className="bg-brand-700 hover:bg-brand-800 rounded-2xl p-4 sm:p-5 min-h-[110px] flex flex-col items-start justify-center gap-1 text-left touch-manipulation"
          >
            <div className="text-lg sm:text-xl font-black leading-tight">{p.label}</div>
            <div className="text-sm sm:text-base text-white/75 leading-snug">{p.sub}</div>
          </button>
        ))}
      </div>

      <div className="pb-2">
        <button
          onClick={startFromScratch}
          className="w-full py-4 sm:py-6 bg-neutral-800 hover:bg-neutral-700 rounded-2xl text-xl font-black flex items-center justify-center gap-3 touch-manipulation"
        >
          <Hand className="h-6 w-6" />
          {t('wizardAttract.buildFromScratch')}
        </button>
      </div>

      <button
        type="button"
        aria-label="Admin"
        onClick={onAdminTap}
        className="absolute top-0 right-0 w-32 h-32 sm:w-48 sm:h-48 flex items-start justify-end p-3 pt-safe"
      >
        <span className="block w-2 h-2 rounded-full bg-white/30" aria-hidden="true" />
      </button>
    </div>
  );
};

export default AttractScreen;
