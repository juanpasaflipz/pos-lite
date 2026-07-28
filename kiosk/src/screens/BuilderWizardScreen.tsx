// Burrito-builder wizard (Phase 2). Renders when the effective kiosk mode is
// 'wizard'. Walks the customer through protein → estilo → segunda → quitar →
// extras → cart-review, then hands off to the existing name-capture + pay
// flow via useKioskCart.addItem(). No changes to the cart, hold, or payment
// pipelines — this is UI over the same data model.
//
// State machine is local (useState) rather than routed so the customer can
// back-arrow without losing wizard picks and the whole flow fits in one file
// while the shape is still being iterated on. Presets from the attract screen
// pre-seed state via sessionStorage.

import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, Check, ShoppingCart, X } from 'lucide-react';
import { useKioskBinding } from '../context/KioskBindingContext';
import { useKioskCart } from '../context/KioskCartContext';
import { fetchBuilderMenu, type BuilderItem, type BuilderModifier } from '../lib/kioskApi';
import LanguageToggle from '../components/LanguageToggle';
import {
  PROTEIN_ICONS,
  INGREDIENT_ICONS,
  STYLE_INFO,
  quitarIcon,
  EXTRA_ICONS,
} from '../lib/builderIcons';

type WizardStep = 'protein' | 'estilo' | 'segunda' | 'quitar' | 'extras' | 'review';

export interface WizardPreset {
  slug: string;
  estiloName?: string;
  segundaName?: string;
  rollbertosChoiceName?: string;
}

const STEP_ORDER: WizardStep[] = ['protein', 'estilo', 'segunda', 'quitar', 'extras', 'review'];

function fmt(n: number): string {
  return `$${n.toFixed(0)}`;
}

// Ingredient set per style, used to filter Quitar options to only what's IN
// the chosen style (California doesn't have rice, so "Sin arroz" is hidden).
const STYLE_ALLOWED_QUITAR: Record<string, string[]> = {
  California: ['Sin papas a la francesa', 'Sin queso', 'Sin guacamole', 'Sin pico de gallo', 'Sin crema'],
  Mission:    ['Sin arroz', 'Sin frijoles', 'Sin queso', 'Sin guacamole', 'Sin pico de gallo', 'Sin crema'],
  Fries:      ['Sin queso', 'Sin guacamole', 'Sin pico de gallo', 'Sin crema'],
};

const BuilderWizardScreen: React.FC = () => {
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const { tenantId, kioskToken } = useKioskBinding();
  const { addItem, count, total } = useKioskCart();
  const en = i18n.language.startsWith('en');

  const [preset] = useState<WizardPreset | null>(() => {
    try {
      const raw = sessionStorage.getItem('kiosk-wizard-preset');
      if (!raw) return null;
      sessionStorage.removeItem('kiosk-wizard-preset');
      return JSON.parse(raw) as WizardPreset;
    } catch {
      return null;
    }
  });

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<BuilderItem[]>([]);
  const [step, setStep] = useState<WizardStep>('protein');
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [estilo, setEstilo] = useState<BuilderModifier | null>(null);
  const [segunda, setSegunda] = useState<BuilderModifier | null>(null);
  const [quitar, setQuitar] = useState<BuilderModifier[]>([]);
  const [extras, setExtras] = useState<BuilderModifier[]>([]);
  const [rollbertosChoice, setRollbertosChoice] = useState<BuilderModifier | null>(null);

  useEffect(() => {
    if (!tenantId || !kioskToken) return;
    (async () => {
      try {
        const data = await fetchBuilderMenu({ tenantId, kioskToken });
        setItems(data.items);
        setLoading(false);
      } catch (err: any) {
        setError(err?.message || 'Load failed');
        setLoading(false);
      }
    })();
  }, [tenantId, kioskToken]);

  // Seed from preset once the menu loads. Jumps to review with all picks made.
  useEffect(() => {
    if (loading || !preset || !items.length) return;
    const item = items.find((i) => i.slug === preset.slug);
    if (!item) return;
    setSelectedSlug(preset.slug);
    if (preset.estiloName) {
      const g = item.groups.find((g) => g.kind === 'Estilo');
      const opt = g?.options.find((o) => o.name === preset.estiloName);
      if (opt) setEstilo(opt);
    }
    if (preset.segundaName) {
      const g = item.groups.find((g) => g.kind === 'Segunda proteína');
      const opt = g?.options.find((o) => o.name === preset.segundaName);
      if (opt) setSegunda(opt);
    }
    if (preset.rollbertosChoiceName) {
      const g = item.groups.find((g) => g.kind.startsWith('¿Con'));
      const opt = g?.options.find((o) => o.name === preset.rollbertosChoiceName);
      if (opt) setRollbertosChoice(opt);
    }
    setStep('review');
  }, [loading, preset, items]);

  const item = useMemo(() => items.find((i) => i.slug === selectedSlug) || null, [items, selectedSlug]);
  const groupsByKind = useMemo(() => {
    const map = new Map<string, typeof item.groups[number]>();
    if (item) for (const g of item.groups) map.set(g.kind, g);
    return map;
  }, [item]);

  const isFixed = selectedSlug === 'birria' || selectedSlug === 'cochinita' || selectedSlug === 'rollbertos';
  const rollbertosGroup = item?.groups.find((g) => g.kind.startsWith('¿Con')) || null;

  const filteredQuitarOptions = useMemo(() => {
    const g = groupsByKind.get('Quitar');
    if (!g) return [];
    if (!estilo) return g.options;
    const allowed = STYLE_ALLOWED_QUITAR[estilo.name];
    if (!allowed) return g.options;
    return g.options.filter((o) => allowed.includes(o.name));
  }, [groupsByKind, estilo]);

  const linePrice = useMemo(() => {
    if (!item) return 0;
    const mods: BuilderModifier[] = [];
    if (estilo) mods.push(estilo);
    if (segunda) mods.push(segunda);
    mods.push(...quitar);
    mods.push(...extras);
    if (rollbertosChoice) mods.push(rollbertosChoice);
    return mods.reduce((sum, m) => sum + Number(m.price_adjustment), Number(item.price));
  }, [item, estilo, segunda, quitar, extras, rollbertosChoice]);

  // Progress dot count — how many steps deep the customer is (out of 5 shown).
  // We suppress the segunda step for fixed items so the dot count reflects that.
  const stepsShown = isFixed ? ['protein', 'review'] as const : ['protein', 'estilo', 'segunda', 'quitar', 'extras', 'review'] as const;
  const stepIdx = stepsShown.indexOf(step as any);

  const resetToProtein = () => {
    setSelectedSlug(null);
    setEstilo(null);
    setSegunda(null);
    setQuitar([]);
    setExtras([]);
    setRollbertosChoice(null);
    setStep('protein');
  };

  const pickProtein = (slug: string) => {
    setSelectedSlug(slug);
    setEstilo(null); setSegunda(null); setQuitar([]); setExtras([]); setRollbertosChoice(null);
    if (slug === 'birria' || slug === 'cochinita' || slug === 'rollbertos') setStep('review');
    else setStep('estilo');
  };

  const advance = () => {
    if (step === 'estilo')  setStep('segunda');
    else if (step === 'segunda') setStep('quitar');
    else if (step === 'quitar')  setStep('extras');
    else if (step === 'extras')  setStep('review');
  };

  const back = () => {
    if (step === 'review') {
      if (isFixed) setStep('protein');
      else setStep('extras');
    }
    else if (step === 'extras')  setStep('quitar');
    else if (step === 'quitar')  setStep('segunda');
    else if (step === 'segunda') setStep('estilo');
    else if (step === 'estilo')  setStep('protein');
    else navigate('/');
  };

  const addToCart = () => {
    if (!item) return;
    if (!isFixed && !estilo) return;
    if (selectedSlug === 'rollbertos' && !rollbertosChoice) return;

    const modifiers: BuilderModifier[] = [];
    if (estilo) modifiers.push(estilo);
    if (segunda) modifiers.push(segunda);
    modifiers.push(...quitar);
    modifiers.push(...extras);
    if (rollbertosChoice) modifiers.push(rollbertosChoice);

    addItem({
      id: item.id,
      name: (en && item.name_en) ? item.name_en : item.name,
      name_en: item.name_en,
      price: item.price,
      description: item.description,
      description_en: item.description_en,
      image_url: null,
      category_id: 0,
      active: true,
    }, modifiers);
    navigate('/cart');
  };

  if (loading) {
    return (
      <div className="h-full w-full bg-neutral-950 text-white flex items-center justify-center">
        <div className="text-2xl">{t('wizard.loading')}</div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="h-full w-full bg-neutral-950 text-white flex flex-col items-center justify-center px-8">
        <div className="text-2xl mb-4">{t('wizard.loadError')}</div>
        <div className="text-neutral-400 mb-8">{error}</div>
        <button onClick={() => navigate('/')} className="px-8 py-4 bg-brand-600 rounded-2xl text-xl font-bold">
          {t('wizard.startOver')}
        </button>
      </div>
    );
  }

  const stepTitle = t(`wizard.step.${step}`);
  const stepKicker = t(`wizard.stepKicker.${step}`);

  return (
    <div className="h-full w-full bg-neutral-950 text-white flex flex-col pt-safe pb-safe">
      {/* Chrome — back / step kicker / cart */}
      <div className="flex items-center justify-between px-4 sm:px-6 py-3 border-b border-neutral-800 flex-shrink-0">
        <button
          onClick={back}
          className="min-w-[44px] min-h-[44px] flex items-center gap-1 text-neutral-300 active:text-white"
          aria-label={t('wizard.back')}
        >
          <ChevronLeft className="h-6 w-6" />
          <span className="text-base font-bold">{t('wizard.back')}</span>
        </button>
        <div className="text-xs sm:text-sm font-black uppercase tracking-[0.14em] text-neutral-500">
          {stepKicker}
        </div>
        <div className="flex items-center gap-2">
          <LanguageToggle />
          <button
            onClick={() => navigate('/cart')}
            className="relative min-w-[44px] min-h-[44px] flex items-center justify-center text-white active:text-brand-300"
            aria-label={t('wizard.viewCart')}
          >
            <ShoppingCart className="h-6 w-6" />
            {count > 0 && (
              <span className="absolute -top-1 -right-1 min-w-[22px] h-[22px] rounded-full bg-brand-600 text-xs font-black flex items-center justify-center px-1.5">
                {count}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* Progress dots */}
      <div className="flex gap-1.5 px-4 sm:px-6 pt-3 flex-shrink-0">
        {stepsShown.map((s, i) => (
          <span
            key={s}
            className={`h-[5px] flex-1 rounded-full transition-colors ${i <= stepIdx ? 'bg-brand-600' : 'bg-neutral-800'}`}
          />
        ))}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-5">
        {step === 'protein' && (
          <div className="max-w-5xl mx-auto">
            <h1 className="text-3xl sm:text-4xl font-black leading-tight mb-1">{stepTitle}</h1>
            <p className="text-sm text-neutral-400 font-bold mb-5">{t('wizard.proteinHint')}</p>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 sm:gap-4">
              {items.filter((i) => i.slug && ['asada','pollo','porkbelly','huevo','portobello','camaron','pescado'].includes(i.slug)).map((i) => (
                <button
                  key={i.id}
                  onClick={() => pickProtein(i.slug!)}
                  className="bg-neutral-900 border-2 border-neutral-800 hover:border-brand-400 active:scale-95 rounded-2xl p-4 min-h-[132px] flex flex-col items-center justify-center gap-2 text-center transition-transform"
                >
                  <div className="text-4xl leading-none">{PROTEIN_ICONS[i.slug!] || '🌯'}</div>
                  <div className="text-base sm:text-lg font-black leading-tight">
                    {(en && i.name_en) ? i.name_en.replace(/\s*Burrito$/i, '') : i.name.replace(/^Burrito\s+/i, '')}
                  </div>
                  <div className="text-sm font-black text-brand-300">{fmt(Number(i.price))}</div>
                </button>
              ))}
            </div>

            <div className="text-xs font-black uppercase tracking-[0.12em] text-neutral-500 mt-8 mb-3">
              {t('wizard.otherOptions')}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 sm:gap-4">
              {items.filter((i) => i.slug && ['birria','cochinita','rollbertos'].includes(i.slug)).map((i) => (
                <button
                  key={i.id}
                  onClick={() => pickProtein(i.slug!)}
                  className="bg-neutral-900 border-2 border-neutral-800 hover:border-brand-400 active:scale-95 rounded-2xl p-4 min-h-[132px] flex flex-col items-center justify-center gap-2 text-center transition-transform"
                >
                  <div className="text-4xl leading-none">{PROTEIN_ICONS[i.slug!] || '🌯'}</div>
                  <div className="text-base font-black leading-tight">
                    {(en && i.name_en) ? i.name_en : i.name}
                  </div>
                  <div className="text-sm font-black text-brand-300">{fmt(Number(i.price))}</div>
                </button>
              ))}
            </div>
          </div>
        )}

        {step === 'estilo' && item && (
          <div className="max-w-4xl mx-auto">
            <h1 className="text-3xl sm:text-4xl font-black leading-tight mb-5">{stepTitle}</h1>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {(groupsByKind.get('Estilo')?.options || []).map((o) => {
                const info = STYLE_INFO[o.name];
                const isOn = estilo?.id === o.id;
                return (
                  <button
                    key={o.id}
                    onClick={() => { setEstilo(o); advance(); }}
                    className={`text-left rounded-2xl p-5 border-[3px] transition-all ${isOn ? 'border-brand-400 bg-brand-900 shadow-lg shadow-brand-900/30' : 'border-neutral-800 bg-neutral-900 hover:border-brand-500'}`}
                  >
                    {info && (
                      <div className={`inline-block px-3 py-1 rounded-full text-[11px] font-black tracking-widest uppercase mb-3 ${info.isBurrito ? 'bg-brand-600 text-white' : 'bg-neutral-800 text-neutral-100 border border-neutral-600'}`}>
                        {info.badge}
                      </div>
                    )}
                    <h3 className="text-2xl font-black leading-tight mb-1">{o.name}</h3>
                    {info && (
                      <>
                        <p className="text-xs font-black uppercase tracking-widest text-brand-300 mb-3">
                          {en ? info.subEn : info.subEs}
                        </p>
                        <ul className="flex flex-wrap gap-1.5 list-none p-0 m-0">
                          {(en ? info.ingredientsEn : info.ingredientsEs).map((ing) => (
                            <li
                              key={ing}
                              className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-sm font-bold ${isOn ? 'bg-brand-800' : 'bg-neutral-800'}`}
                            >
                              <span>{INGREDIENT_ICONS[en ? info.ingredientsEs[info.ingredientsEn.indexOf(ing)] : ing] || ''}</span>
                              {ing}
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                    <div className={`mt-4 text-lg font-black ${o.price_adjustment > 0 ? 'text-brand-300' : 'text-neutral-400'}`}>
                      {o.price_adjustment > 0 ? `+${fmt(o.price_adjustment)}` : t('wizard.included')}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {step === 'segunda' && item && (
          <div className="max-w-5xl mx-auto">
            <h1 className="text-3xl sm:text-4xl font-black leading-tight mb-1">{stepTitle}</h1>
            <p className="text-sm text-neutral-400 font-bold mb-5">{t('wizard.segundaOptional')}</p>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
              <button
                onClick={() => { setSegunda(null); advance(); }}
                className={`rounded-2xl p-4 min-h-[132px] flex flex-col items-center justify-center gap-2 text-center border-2 transition-all ${segunda === null ? 'border-brand-400 bg-brand-900' : 'border-neutral-800 bg-neutral-900 hover:border-brand-500'}`}
              >
                <div className="text-4xl leading-none">✋</div>
                <div className="text-base font-black leading-tight">{t('wizard.noSegunda')}</div>
                <div className="text-xs font-bold text-neutral-400">{t('wizard.noSegundaSub')}</div>
              </button>
              {(groupsByKind.get('Segunda proteína')?.options || []).map((o) => {
                // Segunda option names come plain: 'Camarón', 'Pollo Asado', 'Chorizo'.
                // Map them back to a slug for the icon by matching the label.
                const slug = ({
                  'Carne Asada': 'asada', 'Pollo Asado': 'pollo', 'Porkbelly': 'porkbelly',
                  'Huevo': 'huevo', 'Portobello': 'portobello', 'Camarón': 'camaron',
                  'Pescado': 'pescado', 'Chorizo': 'chorizo',
                } as Record<string, string>)[o.name];
                const isOn = segunda?.id === o.id;
                return (
                  <button
                    key={o.id}
                    onClick={() => { setSegunda(o); advance(); }}
                    className={`rounded-2xl p-4 min-h-[132px] flex flex-col items-center justify-center gap-2 text-center border-2 transition-all ${isOn ? 'border-brand-400 bg-brand-900' : 'border-neutral-800 bg-neutral-900 hover:border-brand-500'}`}
                  >
                    <div className="text-4xl leading-none">{slug ? PROTEIN_ICONS[slug] : '🌯'}</div>
                    <div className="text-base font-black leading-tight">{o.name}</div>
                    <div className="text-sm font-black text-brand-300">+{fmt(o.price_adjustment)}</div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {step === 'quitar' && item && (
          <div className="max-w-2xl mx-auto">
            <h1 className="text-3xl sm:text-4xl font-black leading-tight mb-1">{stepTitle}</h1>
            <p className="text-sm text-neutral-400 font-bold mb-5">{t('wizard.quitarHint')}</p>
            <div className="flex flex-col gap-2.5">
              {filteredQuitarOptions.map((o) => {
                const on = quitar.some((q) => q.id === o.id);
                return (
                  <button
                    key={o.id}
                    onClick={() => setQuitar((cur) => on ? cur.filter((q) => q.id !== o.id) : [...cur, o])}
                    className={`min-h-[60px] rounded-2xl px-5 py-3 flex items-center justify-between text-left transition-all border-2 ${on ? 'border-brand-500 bg-brand-900' : 'border-neutral-800 bg-neutral-900 hover:border-brand-400'}`}
                  >
                    <div className={`flex items-center gap-3 text-lg font-black ${on ? 'text-brand-200 line-through' : 'text-white'}`}>
                      <span className="text-2xl">{quitarIcon(o.name)}</span>
                      <span>{o.name.replace(/^Sin\s+/i, (m) => '').replace(/^./, (c) => c.toUpperCase())}</span>
                    </div>
                    <div className={`text-xs font-black tracking-widest uppercase ${on ? 'text-brand-300' : 'text-neutral-500'}`}>
                      {on ? t('wizard.quitarStateOff') : t('wizard.quitarStateOn')}
                    </div>
                  </button>
                );
              })}
            </div>
            <button
              onClick={advance}
              className="mt-6 w-full py-4 bg-brand-600 active:bg-brand-700 rounded-2xl text-xl font-black touch-manipulation"
            >
              {t('wizard.continue')}
            </button>
          </div>
        )}

        {step === 'extras' && item && (
          <div className="max-w-3xl mx-auto">
            <h1 className="text-3xl sm:text-4xl font-black leading-tight mb-1">{stepTitle}</h1>
            <p className="text-sm text-neutral-400 font-bold mb-5">{t('wizard.extrasOptional')}</p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {(groupsByKind.get('Extras')?.options || []).map((o) => {
                const on = extras.some((e) => e.id === o.id);
                return (
                  <button
                    key={o.id}
                    onClick={() => setExtras((cur) => on ? cur.filter((e) => e.id !== o.id) : [...cur, o])}
                    className={`rounded-2xl p-4 min-h-[132px] flex flex-col items-center justify-center gap-2 text-center border-2 transition-all ${on ? 'border-brand-400 bg-brand-900' : 'border-neutral-800 bg-neutral-900 hover:border-brand-500'}`}
                  >
                    <div className="text-4xl leading-none">{EXTRA_ICONS[o.name] || '➕'}</div>
                    <div className="text-base font-black leading-tight">{o.name}</div>
                    <div className="text-sm font-black text-brand-300">+{fmt(o.price_adjustment)}</div>
                    {on && (
                      <div className="text-xs font-black tracking-widest uppercase text-brand-300 mt-1 flex items-center gap-1">
                        <Check className="h-3 w-3" /> {t('wizard.added')}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
            <button
              onClick={advance}
              className="mt-6 w-full py-4 bg-brand-600 active:bg-brand-700 rounded-2xl text-xl font-black touch-manipulation"
            >
              {t('wizard.reviewOrder')}
            </button>
          </div>
        )}

        {step === 'review' && item && (
          <div className="max-w-2xl mx-auto">
            <h1 className="text-3xl sm:text-4xl font-black leading-tight mb-5">{stepTitle}</h1>
            <div className="bg-neutral-900 border border-neutral-800 rounded-2xl p-5 mb-5">
              <div className="flex items-start justify-between gap-3 mb-2">
                <div>
                  <div className="text-2xl font-black leading-tight">
                    {(en && item.name_en) ? item.name_en : item.name}
                  </div>
                  {estilo && (
                    <div className="text-xs font-black uppercase tracking-widest text-brand-300 mt-1">
                      {estilo.name} {estilo.price_adjustment > 0 && `(+${fmt(estilo.price_adjustment)})`}
                    </div>
                  )}
                </div>
                <div className="text-2xl font-black text-brand-300 whitespace-nowrap">{fmt(linePrice)}</div>
              </div>
              {(segunda || quitar.length > 0 || extras.length > 0) && (
                <div className="text-sm text-neutral-300 mt-3 leading-relaxed">
                  {segunda && (
                    <div>
                      <span className="font-bold">+ {segunda.name}</span>{' '}
                      <span className="text-brand-300">(+{fmt(segunda.price_adjustment)})</span>
                    </div>
                  )}
                  {quitar.map((q) => (
                    <div key={q.id} className="text-brand-300 font-bold">✗ {q.name}</div>
                  ))}
                  {extras.map((e) => (
                    <div key={e.id}>
                      <span className="font-bold">+ {e.name}</span>{' '}
                      <span className="text-brand-300">(+{fmt(e.price_adjustment)})</span>
                    </div>
                  ))}
                </div>
              )}
              {selectedSlug === 'rollbertos' && rollbertosGroup && (
                <div className="mt-5 pt-5 border-t border-neutral-800">
                  <div className="text-sm font-black uppercase tracking-widest text-neutral-400 mb-3">
                    {rollbertosGroup.kind.replace(/__.*$/, '')}
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    {rollbertosGroup.options.map((o) => (
                      <button
                        key={o.id}
                        onClick={() => setRollbertosChoice(o)}
                        className={`px-4 py-4 rounded-2xl font-black text-lg border-2 transition-all ${rollbertosChoice?.id === o.id ? 'border-brand-400 bg-brand-900' : 'border-neutral-800 bg-neutral-800 hover:border-brand-500'}`}
                      >
                        {o.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="flex flex-col sm:flex-row gap-3">
              <button
                onClick={resetToProtein}
                className="sm:flex-1 py-4 bg-neutral-800 active:bg-neutral-700 rounded-2xl text-lg font-black flex items-center justify-center gap-2 touch-manipulation"
              >
                <X className="h-5 w-5" />
                {t('wizard.editStart')}
              </button>
              <button
                onClick={addToCart}
                disabled={selectedSlug === 'rollbertos' && !rollbertosChoice}
                className="sm:flex-[2] py-4 bg-brand-600 active:bg-brand-700 disabled:bg-neutral-800 disabled:text-neutral-500 rounded-2xl text-xl font-black flex items-center justify-between px-6 touch-manipulation"
              >
                <span>{t('wizard.addToCart')}</span>
                <span>{fmt(linePrice)}</span>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Sticky footer: running cart summary when there are already items */}
      {count > 0 && step !== 'review' && (
        <div className="border-t border-neutral-800 px-4 sm:px-6 py-3 flex items-center justify-between flex-shrink-0">
          <div className="text-sm text-neutral-300 font-bold">
            {t('wizard.cartCount', { count })}
          </div>
          <button
            onClick={() => navigate('/cart')}
            className="px-5 py-2.5 bg-brand-600 active:bg-brand-700 rounded-xl font-black flex items-center gap-2 text-sm"
          >
            <ShoppingCart className="h-4 w-4" />
            {fmt(total)}
          </button>
        </div>
      )}
    </div>
  );
};

export default BuilderWizardScreen;
