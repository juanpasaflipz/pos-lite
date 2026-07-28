// Burrito-builder wizard (Phase 2). Renders when the effective kiosk mode is
// 'wizard'. Walks the customer through protein → estilo → segunda → quitar →
// extras → cart-review, then hands off to the existing name-capture + pay
// flow via useKioskCart.addItem(). No changes to the cart, hold, or payment
// pipelines — this is UI over the same data model.
//
// State machine is local (useState) rather than routed so the customer can
// back-arrow without losing wizard picks and the whole flow fits in one file
// while the shape is still being iterated on. Presets from the attract screen
// pre-seed state via location.state.preset.

import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, X, Check, ShoppingCart } from 'lucide-react';
import { useKioskBinding } from '../context/KioskBindingContext';
import { useKioskCart } from '../context/KioskCartContext';
import { fetchBuilderMenu, type BuilderItem, type BuilderModifier } from '../lib/kioskApi';
import LanguageToggle from '../components/LanguageToggle';

type WizardStep = 'protein' | 'estilo' | 'segunda' | 'quitar' | 'extras' | 'review';

export interface WizardPreset {
  slug: string;               // e.g. 'asada' | 'birria'
  estiloName?: string;        // e.g. 'California' | 'Mission' | 'Fries'
  segundaName?: string;       // e.g. 'Camarón'
  rollbertosChoiceName?: string; // 'Con birria' | 'Con cochinita'
}

function fmt(n: number): string {
  return `$${n.toFixed(0)}`;
}

// Ingredient set per style — used to filter Quitar options client-side so a
// California burrito can't have "Sin arroz" removed (it doesn't have any).
const STYLE_INGREDIENT_MAP: Record<string, string[]> = {
  California: ['Sin papas a la francesa', 'Sin queso', 'Sin guacamole', 'Sin pico de gallo', 'Sin crema'],
  Mission:    ['Sin arroz', 'Sin frijoles', 'Sin queso', 'Sin guacamole', 'Sin pico de gallo', 'Sin crema'],
  Fries:      ['Sin queso', 'Sin guacamole', 'Sin pico de gallo', 'Sin crema'],
};

const BuilderWizardScreen: React.FC = () => {
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const { tenantId, kioskToken } = useKioskBinding();
  const { addItem, count, total } = useKioskCart();

  // Preset (if any) was stashed by the attract screen via sessionStorage so we
  // didn't have to thread router state through /fulfillment + /identify.
  // Read-and-clear at mount so a back-nav to /wizard doesn't re-seed.
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

  // Seed from preset once the menu loads.
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
    const allowed = STYLE_INGREDIENT_MAP[estilo.name];
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
    if (slug === 'birria' || slug === 'cochinita') {
      setStep('review');
    } else if (slug === 'rollbertos') {
      setStep('review'); // rollbertos handled via its dedicated single-select on review
    } else {
      setStep('estilo');
    }
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
    if (isFixed && selectedSlug === 'rollbertos' && !rollbertosChoice) return;

    const modifiers: BuilderModifier[] = [];
    if (estilo) modifiers.push(estilo);
    if (segunda) modifiers.push(segunda);
    modifiers.push(...quitar);
    modifiers.push(...extras);
    if (rollbertosChoice) modifiers.push(rollbertosChoice);

    // Cart takes a KioskMenuItem shape — inline the required fields.
    addItem({
      id: item.id,
      name: (i18n.language.startsWith('en') && item.name_en) ? item.name_en : item.name,
      name_en: item.name_en,
      price: item.price,
      description: item.description,
      description_en: item.description_en,
      image_url: null,
      category_id: 0,
      active: true,
    }, modifiers);
    resetToProtein();
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
        <button onClick={() => navigate('/')} className="px-8 py-4 bg-brand-700 rounded-2xl text-xl font-bold">
          {t('wizard.startOver')}
        </button>
      </div>
    );
  }

  const displayName = (opt: { name: string }) => opt.name; // options are already in the store language

  return (
    <div className="h-full w-full bg-neutral-950 text-white flex flex-col pt-safe pb-safe">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-800">
        <button
          onClick={back}
          className="min-w-[44px] min-h-[44px] flex items-center gap-2 text-neutral-300"
          aria-label={t('wizard.back')}
        >
          <ChevronLeft className="h-6 w-6" />
          <span className="text-lg">{t('wizard.back')}</span>
        </button>
        <div className="text-sm sm:text-base font-bold uppercase tracking-widest text-neutral-400">
          {t(`wizard.step.${step}`)}
        </div>
        <div className="flex items-center gap-3">
          <LanguageToggle />
          <button
            onClick={() => navigate('/cart')}
            className="min-w-[44px] min-h-[44px] flex items-center gap-2 text-white relative"
            aria-label={t('wizard.viewCart')}
          >
            <ShoppingCart className="h-6 w-6" />
            {count > 0 && (
              <span className="text-lg font-bold">{count}</span>
            )}
          </button>
        </div>
      </div>

      {/* Body — routes on step */}
      <div className="flex-1 overflow-y-auto px-6 py-6">
        {step === 'protein' && (
          <div>
            <h1 className="text-3xl sm:text-4xl font-black mb-6">{t('wizard.pickProtein')}</h1>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
              {items.filter((i) => i.slug && ['asada','pollo','porkbelly','huevo','portobello','camaron','pescado'].includes(i.slug)).map((i) => (
                <button
                  key={i.id}
                  onClick={() => pickProtein(i.slug!)}
                  className="p-6 bg-neutral-800 hover:bg-neutral-700 rounded-2xl min-h-[120px] flex flex-col items-start justify-between text-left"
                >
                  <div className="text-xl font-bold">
                    {(i18n.language.startsWith('en') && i.name_en) ? i.name_en : i.name.replace(/^Burrito\s+/i, '')}
                  </div>
                  <div className="text-brand-400 text-2xl font-black">{fmt(Number(i.price))}</div>
                </button>
              ))}
            </div>

            <h2 className="text-2xl font-black mt-10 mb-4 text-neutral-300">{t('wizard.otherOptions')}</h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
              {items.filter((i) => i.slug && ['birria','cochinita','rollbertos'].includes(i.slug)).map((i) => (
                <button
                  key={i.id}
                  onClick={() => pickProtein(i.slug!)}
                  className="p-6 bg-neutral-800 hover:bg-neutral-700 rounded-2xl min-h-[120px] flex flex-col items-start justify-between text-left"
                >
                  <div className="text-xl font-bold">
                    {(i18n.language.startsWith('en') && i.name_en) ? i.name_en : i.name}
                  </div>
                  <div className="text-brand-400 text-2xl font-black">{fmt(Number(i.price))}</div>
                </button>
              ))}
            </div>
          </div>
        )}

        {step === 'estilo' && item && (
          <div>
            <h1 className="text-3xl sm:text-4xl font-black mb-6">{t('wizard.pickEstilo')}</h1>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {(groupsByKind.get('Estilo')?.options || []).map((o) => (
                <button
                  key={o.id}
                  onClick={() => { setEstilo(o); advance(); }}
                  className={`p-6 rounded-2xl min-h-[120px] flex flex-col items-start justify-between text-left ${estilo?.id === o.id ? 'bg-brand-700' : 'bg-neutral-800 hover:bg-neutral-700'}`}
                >
                  <div className="text-2xl font-black">{displayName(o)}</div>
                  <div className={`text-lg font-bold ${o.price_adjustment > 0 ? 'text-brand-300' : 'text-neutral-400'}`}>
                    {o.price_adjustment > 0 ? `+${fmt(o.price_adjustment)}` : t('wizard.included')}
                  </div>
                </button>
              ))}
            </div>
            {estilo?.name === 'Fries' && (
              <div className="mt-6 p-4 bg-yellow-900/30 rounded-xl text-yellow-200 text-lg">
                {t('wizard.friesWarning')}
              </div>
            )}
          </div>
        )}

        {step === 'segunda' && item && (
          <div>
            <h1 className="text-3xl sm:text-4xl font-black mb-2">{t('wizard.pickSegunda')}</h1>
            <p className="text-neutral-400 mb-6">{t('wizard.segundaOptional')}</p>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
              <button
                onClick={() => { setSegunda(null); advance(); }}
                className={`p-6 rounded-2xl min-h-[100px] flex items-center justify-center text-center ${segunda === null ? 'bg-brand-700' : 'bg-neutral-800 hover:bg-neutral-700'}`}
              >
                <div className="text-xl font-bold">{t('wizard.noSegunda')}</div>
              </button>
              {(groupsByKind.get('Segunda proteína')?.options || []).map((o) => (
                <button
                  key={o.id}
                  onClick={() => { setSegunda(o); advance(); }}
                  className={`p-6 rounded-2xl min-h-[100px] flex flex-col items-start justify-between text-left ${segunda?.id === o.id ? 'bg-brand-700' : 'bg-neutral-800 hover:bg-neutral-700'}`}
                >
                  <div className="text-lg font-bold">{displayName(o)}</div>
                  <div className="text-brand-300 font-bold">+{fmt(o.price_adjustment)}</div>
                </button>
              ))}
            </div>
          </div>
        )}

        {step === 'quitar' && item && (
          <div>
            <h1 className="text-3xl sm:text-4xl font-black mb-2">{t('wizard.pickQuitar')}</h1>
            <p className="text-neutral-400 mb-6">{t('wizard.quitarOptional')}</p>
            <div className="flex flex-wrap gap-3">
              {filteredQuitarOptions.map((o) => {
                const on = quitar.some((q) => q.id === o.id);
                return (
                  <button
                    key={o.id}
                    onClick={() => setQuitar((cur) => on ? cur.filter((q) => q.id !== o.id) : [...cur, o])}
                    className={`px-5 py-3 rounded-full text-lg font-bold min-h-[48px] ${on ? 'bg-brand-700 text-white' : 'bg-neutral-800 text-neutral-200 hover:bg-neutral-700'}`}
                  >
                    {on && <Check className="inline h-5 w-5 mr-2" />}
                    {displayName(o)}
                  </button>
                );
              })}
            </div>
            <button
              onClick={advance}
              className="mt-10 w-full py-4 bg-brand-700 rounded-2xl text-xl font-black"
            >
              {t('wizard.continue')}
            </button>
          </div>
        )}

        {step === 'extras' && item && (
          <div>
            <h1 className="text-3xl sm:text-4xl font-black mb-2">{t('wizard.pickExtras')}</h1>
            <p className="text-neutral-400 mb-6">{t('wizard.extrasOptional')}</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {(groupsByKind.get('Extras')?.options || []).map((o) => {
                const on = extras.some((e) => e.id === o.id);
                return (
                  <button
                    key={o.id}
                    onClick={() => setExtras((cur) => on ? cur.filter((e) => e.id !== o.id) : [...cur, o])}
                    className={`px-5 py-4 rounded-2xl flex items-center justify-between min-h-[64px] ${on ? 'bg-brand-700' : 'bg-neutral-800 hover:bg-neutral-700'}`}
                  >
                    <div className="text-lg font-bold flex items-center gap-2">
                      {on && <Check className="h-5 w-5" />}
                      {displayName(o)}
                    </div>
                    <div className="text-brand-300 font-bold">+{fmt(o.price_adjustment)}</div>
                  </button>
                );
              })}
            </div>
            <button
              onClick={advance}
              className="mt-10 w-full py-4 bg-brand-700 rounded-2xl text-xl font-black"
            >
              {t('wizard.reviewOrder')}
            </button>
          </div>
        )}

        {step === 'review' && item && (
          <div>
            <h1 className="text-3xl sm:text-4xl font-black mb-6">{t('wizard.review')}</h1>
            <div className="bg-neutral-900 rounded-2xl p-6 mb-6">
              <div className="flex items-baseline justify-between mb-4">
                <div className="text-2xl font-black">
                  {(i18n.language.startsWith('en') && item.name_en) ? item.name_en : item.name}
                </div>
                <div className="text-2xl font-black text-brand-300">{fmt(linePrice)}</div>
              </div>
              {estilo && (
                <div className="text-neutral-300 mb-1">
                  <span className="font-bold">{t('wizard.step.estilo')}:</span> {estilo.name}
                  {estilo.price_adjustment > 0 && ` (+${fmt(estilo.price_adjustment)})`}
                </div>
              )}
              {segunda && (
                <div className="text-neutral-300 mb-1">
                  <span className="font-bold">{t('wizard.step.segunda')}:</span> {segunda.name} (+{fmt(segunda.price_adjustment)})
                </div>
              )}
              {quitar.length > 0 && (
                <div className="text-neutral-300 mb-1">
                  <span className="font-bold">{t('wizard.step.quitar')}:</span> {quitar.map((q) => q.name).join(', ')}
                </div>
              )}
              {extras.length > 0 && (
                <div className="text-neutral-300 mb-1">
                  <span className="font-bold">{t('wizard.step.extras')}:</span> {extras.map((e) => `${e.name} (+${fmt(e.price_adjustment)})`).join(', ')}
                </div>
              )}
              {selectedSlug === 'rollbertos' && rollbertosGroup && (
                <div className="mt-4">
                  <div className="text-lg font-bold mb-2">{rollbertosGroup.kind}</div>
                  <div className="grid grid-cols-2 gap-3">
                    {rollbertosGroup.options.map((o) => (
                      <button
                        key={o.id}
                        onClick={() => setRollbertosChoice(o)}
                        className={`px-4 py-3 rounded-xl font-bold ${rollbertosChoice?.id === o.id ? 'bg-brand-700' : 'bg-neutral-800 hover:bg-neutral-700'}`}
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
                className="flex-1 py-4 bg-neutral-800 hover:bg-neutral-700 rounded-2xl text-xl font-bold flex items-center justify-center gap-2"
              >
                <X className="h-5 w-5" />
                {t('wizard.editStart')}
              </button>
              <button
                onClick={addToCart}
                disabled={selectedSlug === 'rollbertos' && !rollbertosChoice}
                className="flex-[2] py-4 bg-brand-700 rounded-2xl text-xl font-black disabled:opacity-40"
              >
                {t('wizard.addToCart')} · {fmt(linePrice)}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Footer — running cart total sticky when there's already items in cart */}
      {count > 0 && step !== 'review' && (
        <div className="border-t border-neutral-800 px-6 py-3 flex items-center justify-between">
          <div className="text-neutral-300">
            {t('wizard.cartCount', { count })}
          </div>
          <button
            onClick={() => navigate('/cart')}
            className="px-6 py-3 bg-brand-700 rounded-xl font-bold flex items-center gap-2"
          >
            <ShoppingCart className="h-5 w-5" />
            {fmt(total)}
          </button>
        </div>
      )}
    </div>
  );
};

export default BuilderWizardScreen;
