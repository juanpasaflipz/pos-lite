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
import { PRESET_ICONS } from '../lib/builderIcons';

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
  const presets: Array<{ id: string; label: string; sub: string; price: string; preset: WizardPreset }> = [
    { id: 'california', label: en ? 'The California'   : 'El California',       sub: en ? 'Carne Asada, California style'  : 'Carne Asada, estilo California', price: '$250', preset: { slug: 'asada',      estiloName: 'California' } },
    { id: 'pollos',     label: 'Pollos Hermanos',                                 sub: en ? 'Grilled Chicken, Mission'       : 'Pollo Asado, estilo Mission',    price: '$219', preset: { slug: 'pollo',      estiloName: 'Mission' } },
    { id: 'breakfast',  label: 'Breakfast',                                       sub: en ? 'Egg, California'                : 'Huevo, estilo California',       price: '$180', preset: { slug: 'huevo',      estiloName: 'California' } },
    { id: 'surfnturf',  label: 'Surf-N-Turf',                                     sub: en ? 'Asada + Shrimp, Mission'        : 'Asada + Camarón, Mission',       price: '$340', preset: { slug: 'asada',      estiloName: 'Mission', segundaName: 'Camarón' } },
    { id: 'asadafries', label: 'Carne Asada Fries',                               sub: en ? 'Asada over fries'               : 'Asada sobre papas',              price: '$299', preset: { slug: 'asada',      estiloName: 'Fries' } },
    { id: 'birria',     label: en ? 'Birria Burrito'    : 'Burrito de Birria',    sub: en ? 'Beef birria'                    : 'Res deshebrada',                 price: '$99',  preset: { slug: 'birria' } },
    { id: 'cochinita',  label: en ? 'Cochinita Burrito' : 'Burrito Cochinita',    sub: en ? 'Yucatán-style pork'             : 'Cerdo estilo Yucatán',           price: '$99',  preset: { slug: 'cochinita' } },
    { id: 'rollbertos', label: 'Rollbertos',                                      sub: en ? 'Rolled cheese taquitos'         : 'Taquitos dorados de queso',      price: '$139', preset: { slug: 'rollbertos' } },
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
    <div
      className="relative h-full w-full text-white flex flex-col pt-safe pb-safe px-4 sm:px-6 overflow-y-auto"
      // Prototype's radial burst — brand tint fading up from the bottom edge.
      style={{ background: 'radial-gradient(ellipse at 50% 120%, var(--brand-900, #452010) 0%, #0A0A0A 60%)' }}
    >
      {/* Header — logo + tagline, language toggle floats right */}
      <div className="flex items-start justify-between pt-4 pb-2">
        <div className="flex-1 min-w-0">
          {tenantName && (
            <div className="text-xs sm:text-sm text-brand-300 uppercase tracking-widest font-black mb-1">
              {tenantName}
            </div>
          )}
          <div className="text-3xl sm:text-5xl font-black leading-none tracking-tight">
            {t('wizardAttract.title')}
          </div>
          <div className="text-sm sm:text-base text-neutral-400 font-bold mt-2">
            {t('wizardAttract.tagline')}
          </div>
        </div>
        <LanguageToggle />
      </div>

      {/* Favorites label */}
      <div className="text-xs font-black uppercase tracking-[0.14em] text-brand-300 mt-6 mb-3">
        {t('wizardAttract.favorites')}
      </div>

      {/* Preset grid — 2/3/4 columns, prototype-style cards with emoji + name + sub + price */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 auto-rows-min">
        {presets.map((p) => (
          <button
            key={p.id}
            onClick={() => startPreset(p.preset)}
            className="bg-neutral-900 border-2 border-neutral-800 hover:border-brand-400 active:scale-95 rounded-2xl px-3 py-4 flex flex-col items-center text-center gap-1 touch-manipulation transition-transform"
          >
            <div className="text-3xl leading-none mb-1">{PRESET_ICONS[p.id] || '🌯'}</div>
            <div className="text-sm sm:text-base font-black leading-tight">{p.label}</div>
            <div className="text-[11px] sm:text-xs font-bold text-neutral-400 leading-snug">{p.sub}</div>
            <div className="text-sm font-black text-brand-300 mt-1">{p.price}</div>
          </button>
        ))}
      </div>

      {/* OR divider */}
      <div className="flex items-center gap-3 my-5 text-neutral-500 text-xs font-black tracking-widest uppercase">
        <div className="flex-1 h-px bg-neutral-800" />
        {en ? 'OR' : 'O'}
        <div className="flex-1 h-px bg-neutral-800" />
      </div>

      {/* Build from scratch — bigger, prototype-style primary button */}
      <div className="pb-4">
        <button
          onClick={startFromScratch}
          className="w-full py-5 bg-brand-600 active:bg-brand-700 rounded-2xl text-xl sm:text-2xl font-black flex items-center justify-center gap-3 touch-manipulation shadow-lg shadow-brand-900/40"
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
