import React, { useEffect, useRef, useState } from 'react';
import { Hand } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useKioskBinding } from '../context/KioskBindingContext';
import { useKioskCustomer } from '../context/KioskCustomerContext';
import { useKioskCart } from '../context/KioskCartContext';
import { resetKioskLanguage } from '../i18n';
import LanguageToggle from '../components/LanguageToggle';
import BuilderPhoto from '../components/BuilderPhoto';
import { iconPreviewOn, previewFavoritoIcon } from '../lib/builderPreview';
import { fetchBuilderMenu, type BuilderMenu } from '../lib/kioskApi';
import { BuilderIcon, type BuilderIconName } from '../lib/builderIcons';
import { PRESET_ICON, proteinLabel } from '../lib/builderMeta';
import { choiceGroup, proteinPrice, stylePrice, pesos } from '../lib/builderPricing';
import type { WizardPreset } from './BuilderWizardScreen';

/**
 * House favoritos, mirroring the prototype's PRESETS[] (v15) including order.
 *
 * v15 trimmed the roster to six: Pollos Hermanos, Surf-N-Turf and Carne Asada
 * Fries are gone, and Cerveza Fría is the new drink favorite. Six cards is what
 * fills the 3×2 grid on the portrait tablet.
 *
 * `builder` presets pre-fill the wizard. `fixed` presets are whole menu items:
 * they go straight into the order and land on the add-ons step as the upsell.
 * Birria / Cochinita / Rollbertos exist ONLY here — they are not proteins on
 * the builder grid (D2). `drink` is Cerveza Fría: it adds a live drinks addon,
 * so its qty merges with a beer added later from the Bebidas section.
 *
 * No prices live in this table. Every number is computed from the fetched
 * builder data so a price edit in Menu Management can't leave the attract
 * screen advertising a stale one (D6).
 */
type Favorito =
  | { id: string; kind: 'builder'; proteins: string[]; estilo: string; ask?: { protein: string } }
  | { id: string; kind: 'fixed'; slug: string; hasChoice?: boolean }
  | { id: string; kind: 'drink'; match: RegExp };

const FAVORITOS: Favorito[] = [
  { id: 'california', kind: 'builder', proteins: ['asada'], estilo: 'California' },
  { id: 'breakfast', kind: 'builder', proteins: ['huevo'], estilo: 'California', ask: { protein: 'chorizo' } },
  { id: 'birria', kind: 'fixed', slug: 'birria' },
  { id: 'cochinita', kind: 'fixed', slug: 'cochinita' },
  { id: 'rollbertos', kind: 'fixed', slug: 'rollbertos', hasChoice: true },
  { id: 'cervezafria', kind: 'drink', match: /^cerveza$/i },
];

/** Loose fallback when the curated drinks list has no plain "Cerveza" row. */
const BEER_FALLBACK = /cerveza|beer|chela/i;

const CHOICE_ICON: Record<string, BuilderIconName> = {
  'Con birria': 'soup',
  'Con cochinita': 'pig',
};

const AttractScreen: React.FC = () => {
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const { tenantName, kioskMode, tenantId, kioskToken } = useKioskBinding();
  const { clearSession } = useKioskCustomer();
  const { clearCart, addItem } = useKioskCart();

  // The attract screen is the start of every order — reset any leftover
  // customer session, cart, or language choice from a previous interaction.
  useEffect(() => {
    clearSession();
    clearCart();
    resetKioskLanguage();
    // Wizard hand-off keys are per-order, never per-session.
    sessionStorage.removeItem('kiosk-wizard-preset');
    sessionStorage.removeItem('kiosk-wizard-edit');
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

  // Favorito prices and the fixed-item add-to-cart both need live builder data.
  // Guarded on wizard mode so a grid device makes no extra request — hooks
  // can't be conditional, but the fetch inside one can.
  const [menu, setMenu] = useState<BuilderMenu | null>(null);
  const [overlay, setOverlay] = useState<Favorito | null>(null);
  useEffect(() => {
    if (kioskMode !== 'wizard' || !tenantId || !kioskToken) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const data = await fetchBuilderMenu({ tenantId, kioskToken });
        if (!cancelled) setMenu(data);
      } catch {
        // Leave prices blank rather than showing a wrong one; the wizard
        // itself surfaces the real load error when the guest goes in.
      }
    })();
    return () => { cancelled = true; };
  }, [kioskMode, tenantId, kioskToken]);

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

  // ── Wizard mode ───────────────────────────────────────────────────────────
  // D11: NOTHING is interposed before the order. Tapping a favorito or "Arma tu
  // burrito" goes straight into the wizard — the para aquí / para llevar
  // question and the name capture both moved to the END of the flow, after the
  // cart. /identify is out of the wizard path entirely; the post-payment
  // loyalty QR is the loyalty touchpoint. Grid mode's routing is untouched.
  const en = i18n.language.startsWith('en');
  const items = menu?.items || [];
  const itemBySlug = new Map(items.map((i) => [i.slug || '', i]));

  /** The live drinks addon a `drink` favorito stands for, or null if unseeded. */
  const drinkFor = (f: Favorito) => {
    if (f.kind !== 'drink') return null;
    const drinks = menu?.addons.drinks || [];
    return drinks.find((d) => f.match.test(d.name)) || drinks.find((d) => BEER_FALLBACK.test(d.name)) || null;
  };

  const startBuilder = (proteins: string[], estilo: string) => {
    const preset: WizardPreset = { proteins, estiloName: estilo };
    sessionStorage.setItem('kiosk-wizard-preset', JSON.stringify(preset));
    navigate('/wizard');
  };

  const startFromScratch = () => {
    sessionStorage.removeItem('kiosk-wizard-preset');
    navigate('/wizard');
  };

  /** Fixed favorito → straight into the order, then the add-ons upsell. */
  const addFixed = (slug: string, modifierIds: { id: number; name: string; price_adjustment: number }[] = [], nameSuffix = '') => {
    const item = itemBySlug.get(slug);
    if (!item) return;
    const label = (en && item.name_en ? item.name_en : item.name) + nameSuffix;
    addItem(
      {
        id: item.id,
        name: label,
        name_en: null,
        price: item.price,
        description: null,
        description_en: null,
        image_url: null,
        category_id: 0,
        active: true,
      },
      modifierIds,
    );
    sessionStorage.removeItem('kiosk-wizard-preset');
    navigate('/wizard?mode=addons');
  };

  /** Cerveza Fría → the beer joins the cart as a normal drink line, then the
   *  same "¿Deseas agregar algo?" upsell every fixed favorito lands on. */
  const addDrink = (f: Favorito) => {
    const drink = drinkFor(f);
    if (!drink) return;
    addItem({
      id: drink.id,
      name: en && drink.name_en ? drink.name_en : drink.name,
      name_en: null,
      price: drink.price,
      description: null,
      description_en: null,
      image_url: drink.image_url,
      category_id: 0,
      active: true,
    });
    sessionStorage.removeItem('kiosk-wizard-preset');
    navigate('/wizard?mode=addons');
  };

  const favPrice = (f: Favorito): string | null => {
    if (!menu) return null;
    if (f.kind === 'drink') {
      const drink = drinkFor(f);
      return drink ? pesos(drink.price) : null;
    }
    if (f.kind === 'fixed') {
      const item = itemBySlug.get(f.slug);
      return item ? pesos(item.price) : null;
    }
    return pesos(stylePrice(f.proteins, f.estilo, items));
  };

  const favSub = (f: Favorito): string => {
    if (f.kind !== 'builder') return t(`wizardAttract.presets.${f.id}Sub`);
    // "Carne Asada · California" / "Carne Asada + Camarón · Mission"
    return `${f.proteins.map((s) => proteinLabel(s, en)).join(' + ')} · ${f.estilo}`;
  };

  /** The card's food photo: builder/fixed favoritos wear their base item's
   *  menu photo, the drink favorito wears its addon's. Null → BuilderPhoto's
   *  gradient+glyph fallback, which is the pre-photo look of this screen.
   *  Icon preview (device-local, set from terminal settings) swaps every card
   *  to its bundled illustrated icon so the owner can evaluate the look. */
  const preview = iconPreviewOn();
  const favImage = (f: Favorito): string | null => {
    if (preview) return previewFavoritoIcon(f.id);
    if (f.kind === 'drink') return drinkFor(f)?.image_url || null;
    const slug = f.kind === 'fixed' ? f.slug : f.proteins[0];
    return itemBySlug.get(slug)?.image_url || null;
  };

  const onFavorito = (f: Favorito) => {
    if (f.kind === 'drink') { addDrink(f); return; }
    if (f.kind === 'fixed') {
      // Every fixed favorito confirms before touching the cart — the silent
      // add-and-jump to the upsell read as "what just happened?" (owner
      // feedback, 2026-08-06). Rollbertos confirms via its either/or; Birria
      // and Cochinita get a plain "¿Lo agregamos?".
      setOverlay(f);
      return;
    }
    if (f.ask) { setOverlay(f); return; }
    startBuilder(f.proteins, f.estilo);
  };

  // A drink favorito with nothing behind it would be a dead card, so it drops
  // out once we know the tenant's curated drinks don't include a beer. It stays
  // while the menu is still loading — the grid shouldn't reflow on arrival.
  const favoritos = FAVORITOS.filter((f) => f.kind !== 'drink' || !menu || drinkFor(f));

  // The terracotta 'S is the brand mark. A tenant whose name already ends in
  // apostrophe-s (Juanberto's) supplies its own — recolor it instead of
  // appending a second one.
  const title = tenantName || 'JUANBERTO';
  const ownS = title.match(/^(.*)(['’][sS])$/);

  return (
    <div
      className="relative h-full w-full text-neutral-50 flex flex-col items-center gap-5 text-center px-6 py-6 pt-safe pb-safe overflow-y-auto bg-[radial-gradient(ellipse_at_50%_120%,rgb(var(--brand-900))_0%,rgb(var(--n-950))_60%)] [@media(min-height:900px)]:justify-evenly [@media(min-height:900px)]:gap-0 [@media(min-height:900px)]:py-7"
    >
      <div>
        <div className="text-[clamp(30px,6vw,60px)] [@media(min-height:900px)]:text-[clamp(44px,9vw,84px)] font-black leading-none tracking-[-0.02em]">
          {ownS ? ownS[1] : title}
          <em className="not-italic text-brand-300">{ownS ? ownS[2] : "'S"}</em>
        </div>
        <p className="text-[clamp(14px,2.6vw,19px)] [@media(min-height:900px)]:text-[clamp(17px,3vw,24px)] font-bold text-neutral-300 mt-1">
          {t('wizardAttract.tagline')}
        </p>
      </div>

      <p className="text-[15px] [@media(min-height:900px)]:text-[18px] font-black uppercase tracking-[0.16em] text-brand-300">
        {t('wizardAttract.favorites')}
      </p>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 [@media(min-height:900px)]:gap-[18px] w-full max-w-[720px] [@media(min-height:900px)]:max-w-[860px] auto-rows-min">
        {favoritos.map((f) => (
          <button
            key={f.id}
            onClick={() => onFavorito(f)}
            className="bg-neutral-900 border-2 border-neutral-800 active:scale-95 active:border-brand-400 rounded-[18px] [@media(min-height:900px)]:rounded-[22px] overflow-hidden flex flex-col items-stretch touch-manipulation transition-transform shadow-[0_4px_18px_rgba(0,0,0,0.35)]"
          >
            <BuilderPhoto
              src={favImage(f)}
              alt={t(`wizardAttract.presets.${f.id}`)}
              fallbackIcon={PRESET_ICON[f.id] || 'burrito'}
              className="aspect-[4/3] w-full"
              iconClassName="h-[46px] w-[46px] [@media(min-height:900px)]:h-16 [@media(min-height:900px)]:w-16"
              fit={preview ? 'icon' : 'cover'}
            />
            <span className="flex flex-col items-center gap-1 [@media(min-height:900px)]:gap-1.5 px-3 pt-2.5 pb-3 [@media(min-height:900px)]:px-4 [@media(min-height:900px)]:pt-3.5 [@media(min-height:900px)]:pb-4">
            <span className="text-[18px] [@media(min-height:900px)]:text-[23px] font-black leading-[1.1]">{t(`wizardAttract.presets.${f.id}`)}</span>
            <span className="text-[12px] [@media(min-height:900px)]:text-[14px] font-bold text-neutral-400">{favSub(f)}</span>
            <span className="text-[17px] [@media(min-height:900px)]:text-[21px] font-black text-brand-300">{favPrice(f) ?? ' '}</span>
            </span>
          </button>
        ))}
      </div>

      <div className="flex items-center gap-3 w-full max-w-[640px] [@media(min-height:900px)]:max-w-[860px] text-neutral-500 text-xs [@media(min-height:900px)]:text-sm font-black tracking-[0.12em] uppercase">
        <span className="flex-1 h-px bg-neutral-800" />
        {t('wizardAttract.or')}
        <span className="flex-1 h-px bg-neutral-800" />
      </div>

      <button
        onClick={startFromScratch}
        className="w-full max-w-[640px] [@media(min-height:900px)]:max-w-[860px] min-h-[80px] [@media(min-height:900px)]:min-h-[112px] rounded-[14px] bg-brand-600 active:bg-brand-700 text-[clamp(19px,3.6vw,28px)] [@media(min-height:900px)]:text-[clamp(24px,4vw,34px)] font-black flex flex-col items-center justify-center gap-1 touch-manipulation shadow-[0_12px_40px_rgba(168,84,42,0.35)] flex-shrink-0 px-5 py-3"
      >
        <span className="flex items-center gap-2.5">
          <BuilderIcon name="burrito" className="h-[1.05em] w-[1.05em]" />
          {t('wizardAttract.title')}
        </span>
        <small className="text-sm font-bold opacity-80">{t('wizardAttract.startSub')}</small>
      </button>

      <button
        onClick={() => { sessionStorage.removeItem('kiosk-wizard-preset'); navigate('/wizard?mode=addons'); }}
        className="w-full max-w-[640px] [@media(min-height:900px)]:max-w-[860px] min-h-[60px] [@media(min-height:900px)]:min-h-[80px] rounded-[14px] bg-transparent border-2 border-neutral-700 text-neutral-100 text-[17px] [@media(min-height:900px)]:text-[21px] font-black flex items-center justify-center gap-2.5 touch-manipulation flex-shrink-0 px-5 py-3"
      >
        <BuilderIcon name="cupsoda" className="h-[1.05em] w-[1.05em]" />
        {t('wizardAttract.drinksJump')}
      </button>

      <LanguageToggle />

      <button
        type="button"
        aria-label="Admin"
        onClick={onAdminTap}
        className="absolute top-0 right-0 w-32 h-32 sm:w-48 sm:h-48 flex items-start justify-end p-3 pt-safe"
      >
        <span className="block w-2 h-2 rounded-full bg-white/30" aria-hidden="true" />
      </button>

      {overlay && (
        <FavoritoOverlay
          favorito={overlay}
          menu={menu}
          en={en}
          onClose={() => setOverlay(null)}
          onBuilder={startBuilder}
          onFixed={addFixed}
        />
      )}
    </div>
  );
};

/**
 * The one-tap question a favorito can ask before entering the flow:
 *  · Breakfast — optional second protein ("¿Con chorizo?"), the "with" option
 *    leading because most guests take it.
 *  · Rollbertos — a required either/or at the same price, so the kitchen knows
 *    what goes on top before the item reaches the cart.
 */
const FavoritoOverlay: React.FC<{
  favorito: Favorito;
  menu: BuilderMenu | null;
  en: boolean;
  onClose: () => void;
  onBuilder: (proteins: string[], estilo: string) => void;
  onFixed: (slug: string, modifiers: { id: number; name: string; price_adjustment: number }[], nameSuffix: string) => void;
}> = ({ favorito, menu, en, onClose, onBuilder, onFixed }) => {
  const { t } = useTranslation();
  const items = menu?.items || [];

  if (favorito.kind === 'builder' && favorito.ask) {
    const extra = favorito.ask.protein;
    const label = proteinLabel(extra, en).toLowerCase();
    const withProteins = [...favorito.proteins, extra];
    const withPrice = proteinPrice(withProteins, items);
    const plain = proteinPrice(favorito.proteins, items);
    const delta = withPrice - plain;
    return (
      <AskBox
        icons={[PRESET_ICON[favorito.id] || 'burrito', 'sausage']}
        title={t('wizardAttract.askTitle', { item: label })}
        sub={t(`wizardAttract.presets.${favorito.id}`)}
        onClose={onClose}
        buttons={[
          {
            key: 'yes',
            label: t('wizardAttract.askWith', { item: label }),
            note: `+${pesos(delta)} · ${pesos(withPrice)}`,
            onClick: () => onBuilder(withProteins, favorito.estilo),
          },
          {
            key: 'no',
            variant: 'ghost',
            label: t('wizardAttract.askWithout', { item: label }),
            note: pesos(plain),
            onClick: () => onBuilder(favorito.proteins, favorito.estilo),
          },
        ]}
      />
    );
  }

  if (favorito.kind === 'fixed' && favorito.hasChoice) {
    const item = items.find((i) => i.slug === favorito.slug) || null;
    const group = choiceGroup(item);
    return (
      <AskBox
        icons={[PRESET_ICON[favorito.id] || 'taquitos']}
        title={t('wizardAttract.rollbertosQuestion')}
        sub={`${t(`wizardAttract.presets.${favorito.id}`)} · ${t(`wizardAttract.presets.${favorito.id}Sub`)}${item ? ` · ${pesos(item.price)}` : ''}`}
        onClose={onClose}
        buttons={(group?.options || []).map((o) => ({
          key: String(o.id),
          icon: CHOICE_ICON[o.name],
          label: o.name === 'Con cochinita' ? t('wizardAttract.withCochinita') : t('wizardAttract.withBirria'),
          note: item ? pesos(item.price) : undefined,
          onClick: () => onFixed(favorito.slug, [o], ` — ${o.name.toLowerCase()}`),
        }))}
      />
    );
  }

  if (favorito.kind === 'fixed') {
    const item = items.find((i) => i.slug === favorito.slug) || null;
    return (
      <AskBox
        icons={[PRESET_ICON[favorito.id] || 'burrito']}
        title={t('wizardAttract.confirmAdd')}
        sub={`${t(`wizardAttract.presets.${favorito.id}`)} · ${t(`wizardAttract.presets.${favorito.id}Sub`)}`}
        onClose={onClose}
        buttons={[
          {
            key: 'add',
            label: t('wizardAttract.addToOrder'),
            note: item ? pesos(item.price) : undefined,
            onClick: () => onFixed(favorito.slug, [], ''),
          },
        ]}
      />
    );
  }
  return null;
};

const AskBox: React.FC<{
  icons: BuilderIconName[];
  title: string;
  sub: string;
  onClose: () => void;
  buttons: Array<{
    key: string;
    label: string;
    note?: string;
    icon?: BuilderIconName;
    variant?: 'primary' | 'ghost';
    onClick: () => void;
  }>;
}> = ({ icons, title, sub, onClose, buttons }) => {
  const { t } = useTranslation();
  return (
    <div className="fixed inset-0 z-[60] bg-black/[0.82] flex items-center justify-center p-5">
      <div className="w-full max-w-[440px] rounded-[24px] bg-neutral-900 border border-neutral-800 p-[28px_24px] text-center flex flex-col gap-4">
        <span className="inline-flex gap-1.5 justify-center text-brand-300">
          {icons.map((n) => (
            <BuilderIcon key={n} name={n} className="h-[52px] w-[52px]" />
          ))}
        </span>
        <h2 className="text-[28px] font-black m-0">{title}</h2>
        <p className="-mt-2 text-sm font-bold text-neutral-400 m-0">{sub}</p>
        {buttons.map((b) => (
          <button
            key={b.key}
            onClick={b.onClick}
            className={`w-full min-h-[56px] rounded-[14px] px-5 py-3 text-[18px] font-black text-white flex items-center justify-between gap-2.5 active:scale-[0.98] transition-transform ${
              b.variant === 'ghost' ? 'bg-neutral-800 active:bg-neutral-700' : 'bg-brand-600 active:bg-brand-700'
            }`}
          >
            <span className="flex items-center gap-2.5">
              {b.icon && <BuilderIcon name={b.icon} className="h-[1.2em] w-[1.2em] flex-shrink-0" />}
              {b.label}
            </span>
            {b.note && <small className="text-sm font-bold opacity-80">{b.note}</small>}
          </button>
        ))}
        <button
          onClick={onClose}
          className="h-11 px-3.5 self-center rounded-[10px] bg-neutral-800 active:bg-neutral-700 text-sm font-extrabold"
        >
          {t('wizard.back')}
        </button>
      </div>
    </div>
  );
};

export default AttractScreen;
