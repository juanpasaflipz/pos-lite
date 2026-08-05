// Burrito-builder wizard — parity build against design/kiosk-builder-prototype.html
// (v15). Renders only when the effective kiosk mode is 'wizard', which today is
// one device on one tenant; grid mode never mounts this file.
//
// Flow, matching the prototype exactly:
//   protein (multi-select, max 2)
//     → estilo  ── "Así está bien ✓" ──────────────→ agregar
//                └─ "¿Deseas modificar algo?" → quitar → agregar
//   agregar (Para tu burrito / Complementos / Bebidas) → cart
//
// D11: nothing is interposed BEFORE the order — the attract screen comes
// straight here. The commitment questions live at the end, after the cart:
// ¿para aquí o para llevar? → call-out name → pay → thanks + loyalty QR.
//
// One accepted deviation from the prototype, per the parity spec: payment
// itself continues through the existing pipes (hold, MP terminal), where the
// prototype has a 900ms stub. The sequence and copy around it are the
// prototype's.
//
// Everything else — copy, branching, icons, step count, price arithmetic — is
// the prototype's. Prices are derived from live modifier data (see
// builderPricing), never from the prototype's hardcoded tables.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronLeft } from 'lucide-react';
import { useKioskBinding } from '../context/KioskBindingContext';
import { useKioskCart } from '../context/KioskCartContext';
import { useIdleTimer } from '../hooks/useIdleTimer';
import LanguageToggle from '../components/LanguageToggle';
import { fetchBuilderMenu, type BuilderAddon, type BuilderMenu, type BuilderModifier } from '../lib/kioskApi';
import { BuilderIcon } from '../lib/builderIcons';
import {
  PROTEIN_ICON, STYLE_INFO, EXTRA_ICON, addonIcon, quitarIcon, proteinLabel,
} from '../lib/builderMeta';
import {
  MAX_PROTEINS, PROTEIN_SLUGS, HIDDEN_PROTEIN_SLUGS,
  emptyDraft, draftPrice, draftModifiers, decodeDraft, extrasCount, extrasMax,
  estiloOptions, extrasOptions, quitarOptions, resolveSelection,
  proteinPrice, stylePrice, pesos,
  type DraftLine,
} from '../lib/builderPricing';

type Step = 'protein' | 'estilo' | 'quitar' | 'agregar';

/** Stashed by AttractScreen when a favorito pre-fills the wizard (D7). */
export interface WizardPreset {
  proteins: string[];
  estiloName: string;
}

/** Stashed by the summary screen's "Editar" so a committed line can be reopened. */
export interface WizardEdit {
  lineKey: string;
  menuItemId: number;
  modifierIds: number[];
}

const PRESET_KEY = 'kiosk-wizard-preset';
const EDIT_KEY = 'kiosk-wizard-edit';

const BuilderWizardScreen: React.FC = () => {
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const { tenantId, kioskToken } = useKioskBinding();
  const { addItem, decrementLine, lines } = useKioskCart();
  const [params] = useSearchParams();
  const en = i18n.language.startsWith('en');

  // "Solo bebidas y complementos" door — the agregar step with no burrito in
  // hand, so no extras section and no step dots.
  const addonsOnly = params.get('mode') === 'addons';

  const [menu, setMenu] = useState<BuilderMenu | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<Step>(addonsOnly ? 'agregar' : 'protein');
  const [draft, setDraft] = useState<DraftLine>(emptyDraft);
  const [note, setNote] = useState<string | null>(null);
  const noteTimer = useRef<number | null>(null);

  // Every other kiosk ordering screen resets to attract after 2 minutes idle.
  // Without it a guest who walks away mid-build leaves the next guest inside a
  // half-made burrito. Not modelled by the prototype (it models no timeouts).
  useIdleTimer(() => navigate('/'), 120_000);

  const toast = useCallback((msg: string) => {
    setNote(msg);
    if (noteTimer.current) window.clearTimeout(noteTimer.current);
    noteTimer.current = window.setTimeout(() => setNote(null), 1200);
  }, []);

  useEffect(() => () => {
    if (noteTimer.current) window.clearTimeout(noteTimer.current);
  }, []);

  // Read-only: AttractScreen owns this key's lifecycle and every route out of
  // it either writes a fresh preset or clears the old one, so the wizard never
  // consumes it. Consuming it here (in a useState initializer, as this screen
  // used to) breaks under StrictMode — the discarded first mount ate the value
  // and the real mount started from a blank protein grid.
  const preset = useMemo<WizardPreset | null>(() => {
    try {
      const raw = sessionStorage.getItem(PRESET_KEY);
      return raw ? (JSON.parse(raw) as WizardPreset) : null;
    } catch {
      return null;
    }
  }, []);

  // Same read-only contract as the preset: the summary screen owns this key's
  // lifecycle (it writes it on "Editar" and clears it on every other route into
  // the wizard), so a StrictMode double-mount can't consume it.
  const editing = useMemo<WizardEdit | null>(() => {
    try {
      const raw = sessionStorage.getItem(EDIT_KEY);
      return raw ? (JSON.parse(raw) as WizardEdit) : null;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    if (!tenantId || !kioskToken) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await fetchBuilderMenu({ tenantId, kioskToken });
        if (cancelled) return;
        setMenu(data);
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Load failed');
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [tenantId, kioskToken]);

  // D7 — a builder-backed favorito lands on the Estilo step with its protein(s)
  // and style already selected: one tap from "Así está bien ✓", and everything
  // is still changeable (Atrás reaches the protein grid with the selections
  // intact). The prototype's `startPreset` does exactly this — `go('style')`.
  useEffect(() => {
    if (loading || !preset || !menu || addonsOnly) return;
    setDraft({ ...emptyDraft(), proteins: [...preset.proteins], estiloName: preset.estiloName });
    setStep('estilo');
  }, [loading, preset, menu, addonsOnly]);

  // Reopening a committed line ("Editar" on the summary): every choice comes
  // back decoded from the line's modifier ids and the guest lands on the
  // protein step, exactly as the prototype's rSummary edit does.
  useEffect(() => {
    if (loading || !editing || !menu || addonsOnly) return;
    const decoded = decodeDraft(editing.menuItemId, editing.modifierIds, menu.items);
    if (!decoded) return;
    setDraft(decoded);
    setStep('protein');
  }, [loading, editing, menu, addonsOnly]);

  const items = menu?.items || [];
  const selection = useMemo(() => resolveSelection(draft.proteins, items), [draft.proteins, items]);
  const base = selection?.base || null;

  const styleName = draft.estiloName;
  const styleInfo = styleName ? STYLE_INFO[styleName] : null;

  // Quitar rows are filtered to what the chosen style actually contains —
  // California has no rice, so "Sin arroz" never appears (D4).
  const quitarRows = useMemo(() => {
    const all = quitarOptions(base);
    if (!styleInfo) return all;
    const allowed = new Set(styleInfo.ing.map((i) => i.quitar));
    return all.filter((o) => allowed.has(o.name));
  }, [base, styleInfo]);

  const proteinCards = useMemo(() => {
    const order = new Map(PROTEIN_SLUGS.map((s, i) => [s as string, i]));
    return items
      .filter((i) => i.slug && (order.has(i.slug) || (HIDDEN_PROTEIN_SLUGS.includes(i.slug) && draft.proteins.includes(i.slug))))
      .sort((a, b) => (order.get(a.slug!) ?? 99) - (order.get(b.slug!) ?? 99));
  }, [items, draft.proteins]);

  const linePrice = draftPrice(draft, items);
  const cartTotal = lines.reduce((s, l) => s + l.price * l.quantity, 0);

  const toggleProtein = (slug: string) => {
    setDraft((d) => {
      if (d.proteins.includes(slug)) {
        return { ...d, proteins: d.proteins.filter((s) => s !== slug) };
      }
      if (d.proteins.length >= MAX_PROTEINS) {
        toast(t('wizard.maxProteins'));
        return d;
      }
      return { ...d, proteins: [...d.proteins, slug] };
    });
  };

  const pickStyle = (opt: BuilderModifier) => {
    // Changing style resets removals — the ingredient set is different.
    setDraft((d) => ({ ...d, estiloName: opt.name, removed: [] }));
  };

  const toggleQuitar = (opt: BuilderModifier) => {
    setDraft((d) => ({
      ...d,
      removed: d.removed.includes(opt.id)
        ? d.removed.filter((id) => id !== opt.id)
        : [...d.removed, opt.id],
    }));
  };

  const addExtra = (opt: BuilderModifier) => {
    setDraft((d) => {
      // The Extras modifier group carries its own max_selections; exceeding it
      // would fail server validation at hold time, so stop at the ceiling.
      if (extrasCount(d) >= extrasMax(base)) return d;
      return { ...d, extras: { ...d.extras, [opt.id]: (d.extras[opt.id] || 0) + 1 } };
    });
    toast(`${t('wizard.added')} ${opt.name}`);
  };

  const addAddon = (addon: BuilderAddon) => {
    // Name is already resolved for the active language, so the *_en fields are
    // null — the cart line renders `name` verbatim.
    addItem({
      id: addon.id,
      name: en && addon.name_en ? addon.name_en : addon.name,
      name_en: null,
      price: addon.price,
      description: null,
      description_en: null,
      image_url: addon.image_url,
      category_id: 0,
      active: true,
    });
    toast(`${t('wizard.added')} ${en && addon.name_en ? addon.name_en : addon.name}`);
  };

  const finish = () => {
    // Editing replaces one unit of the original line rather than removing it
    // outright, so a "×2 Burrito Carne Asada" line keeps its second burrito.
    // Done here (not on the Editar tap) so abandoning the edit — idle timeout,
    // Empezar de nuevo — leaves the cart exactly as the guest left it.
    // Gated on there being a replacement: if the decode failed (an option was
    // deleted in Menu Management since the line was added) the guest is on a
    // blank protein grid, and decrementing here would silently delete the
    // burrito they were trying to edit.
    if (editing && base && selection) decrementLine(editing.lineKey);
    if (base && selection) {
      addItem(
        {
          id: base.id,
          name: en && base.name_en ? base.name_en : base.name,
          name_en: null,
          price: base.price,
          description: en && base.description_en ? base.description_en : base.description,
          description_en: null,
          image_url: null,
          category_id: 0,
          active: true,
        },
        draftModifiers(draft, items),
      );
    }
    navigate('/cart');
  };

  // Back from the first step returns to wherever the guest came from: the
  // summary when there is already an order in progress ("+ Agregar otro
  // burrito", "Editar"), otherwise the attract screen.
  const exit = () => navigate(lines.length ? '/cart' : '/');

  const goBack = () => {
    if (addonsOnly) { exit(); return; }
    if (step === 'agregar') setStep(draft.removed.length ? 'quitar' : 'estilo');
    else if (step === 'quitar') setStep('estilo');
    else if (step === 'estilo') setStep('protein');
    else exit();
  };

  if (loading) {
    return (
      <div className="h-full w-full bg-neutral-950 text-neutral-50 flex items-center justify-center">
        <div className="text-2xl font-black">{t('wizard.loading')}</div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="h-full w-full bg-neutral-950 text-neutral-50 flex flex-col items-center justify-center px-8 gap-4">
        <div className="text-2xl font-black">{t('wizard.loadError')}</div>
        <div className="text-neutral-400 font-bold">{error}</div>
        <button
          onClick={() => navigate('/')}
          className="mt-4 min-h-[56px] px-8 bg-brand-600 active:bg-brand-700 rounded-2xl text-lg font-black"
        >
          {t('wizard.startOver')}
        </button>
      </div>
    );
  }

  const stepIndex: Record<Step, number> = { protein: 1, estilo: 2, quitar: 3, agregar: 4 };
  const activeStep = addonsOnly ? 0 : stepIndex[step];

  const KICKER: Record<Step, string> = {
    protein: t('wizard.stepProteinK'),
    estilo: t('wizard.stepStyleK'),
    quitar: t('wizard.stepModifyK'),
    agregar: t('wizard.stepAddK'),
  };
  const TITLE: Record<Step, string> = {
    protein: t('wizard.stepProtein'),
    estilo: t('wizard.stepStyle'),
    quitar: t('wizard.stepModify'),
    agregar: t('wizard.stepAdd'),
  };

  // The prototype's protein step has no back chip because the only way in is
  // from the attract screen. Here it is also reachable from the summary
  // ("+ Agregar otro burrito", "Editar"), and the ghost button on that step is
  // "Empezar de nuevo" — which discards the order. Without a back chip a guest
  // adding a second burrito has no non-destructive way out.
  const showBack = addonsOnly || step !== 'protein' || lines.length > 0;

  return (
    <div className="h-full w-full bg-neutral-950 text-neutral-50 flex flex-col">
      {/* Chrome — kicker + title left, language + back right */}
      <header className="flex items-center justify-between gap-3 px-4 py-3 pt-safe border-b border-neutral-800 flex-shrink-0">
        <div className="min-w-0">
          {!addonsOnly && (
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-neutral-500 mb-0.5">
              {KICKER[step]}
            </p>
          )}
          <h1 className="text-[clamp(22px,4.5vw,40px)] font-black leading-[1.05] truncate">
            {addonsOnly ? t('wizard.addOnlyTitle') : TITLE[step]}
          </h1>
        </div>
        <div className="flex gap-2 flex-shrink-0">
          <LanguageToggle />
          {showBack && (
            <button
              onClick={goBack}
              className="h-11 px-3.5 rounded-[10px] bg-neutral-800 active:bg-neutral-700 text-sm font-extrabold inline-flex items-center gap-1.5"
            >
              <ChevronLeft className="h-4 w-4" />
              {t('wizard.back')}
            </button>
          )}
        </div>
      </header>

      {/* Four segments: Proteína / Estilo / Ajustes / Extras */}
      {activeStep > 0 && (
        <div className="flex gap-1.5 px-4 pt-2.5 flex-shrink-0">
          {[1, 2, 3, 4].map((i) => (
            <span
              key={i}
              className={`h-[5px] flex-1 rounded-[3px] transition-colors ${i <= activeStep ? 'bg-brand-600' : 'bg-neutral-800'}`}
            />
          ))}
        </div>
      )}

      <main className="flex-1 min-h-0 overflow-y-auto p-4">
        {step === 'protein' && (
          <>
            <p className="text-center text-neutral-400 font-bold text-sm mb-3.5">{t('wizard.proteinHint')}</p>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-3.5 pb-2">
              {proteinCards.map((item) => {
                const on = draft.proteins.includes(item.slug!);
                return (
                  <button
                    key={item.id}
                    onClick={() => toggleProtein(item.slug!)}
                    className={`relative min-h-[132px] rounded-2xl border-2 p-[18px_14px] flex flex-col items-center justify-center gap-2 text-center active:scale-[0.96] transition-transform ${on ? 'border-brand-400 bg-brand-900' : 'border-neutral-800 bg-neutral-900'}`}
                  >
                    {on && (
                      <span className="absolute -top-2 -right-2 min-w-[28px] h-7 px-2 rounded-[14px] bg-brand-600 text-[15px] font-black flex items-center justify-center shadow-lg">
                        ✓
                      </span>
                    )}
                    <BuilderIcon
                      name={PROTEIN_ICON[item.slug!] || 'burrito'}
                      className="h-[clamp(34px,6vw,48px)] w-[clamp(34px,6vw,48px)] text-brand-300"
                    />
                    <span className="text-[clamp(15px,2.6vw,19px)] font-black leading-[1.15]">
                      {proteinLabel(item.slug!, en)}
                    </span>
                    <span className="text-[clamp(14px,2.4vw,17px)] font-extrabold text-brand-300">
                      {pesos(item.price)}
                    </span>
                  </button>
                );
              })}
            </div>
          </>
        )}

        {step === 'estilo' && base && (
          <div className="grid gap-3.5 grid-cols-1 md:grid-cols-2 lg:grid-cols-3 max-w-[1200px] mx-auto">
            {estiloOptions(base).map((opt) => {
              const info = STYLE_INFO[opt.name];
              const on = draft.estiloName === opt.name;
              const price = stylePrice(draft.proteins, opt.name, items);
              return (
                <button
                  key={opt.id}
                  onClick={() => pickStyle(opt)}
                  className={`w-full text-left rounded-[20px] border-[3px] p-[24px_20px] active:scale-[0.97] transition-transform ${on ? 'border-brand-400 bg-brand-900 shadow-[0_8px_30px_rgba(168,84,42,0.25)]' : 'border-neutral-800 bg-neutral-900'}`}
                >
                  {info && (
                    <span
                      className={`inline-flex items-center gap-1.5 px-3 py-[5px] rounded-full mb-2.5 text-[11px] font-black tracking-[0.12em] uppercase ${info.isBurrito ? 'bg-brand-600 text-white' : 'bg-neutral-800 text-neutral-100 border border-neutral-600'}`}
                    >
                      <BuilderIcon name={info.isBurrito ? 'burrito' : 'fries'} className="h-[1.05em] w-[1.05em]" />
                      {info.isBurrito ? t('wizard.badgeBurrito') : t('wizard.badgeNotBurrito')}
                    </span>
                  )}
                  <h3 className="flex items-baseline gap-2 text-[clamp(22px,4vw,30px)] font-black mb-1">
                    {info && <BuilderIcon name={info.icon} className="h-[1.05em] w-[1.05em] self-center flex-shrink-0" />}
                    <span className="min-w-0">{info ? (en ? info.en : info.es) : opt.name}</span>
                    <span className="ml-auto text-brand-300 whitespace-nowrap">{pesos(price)}</span>
                  </h3>
                  {info && (
                    <>
                      <p className="text-[13px] font-extrabold tracking-[0.1em] uppercase text-brand-300 mb-3">
                        {en ? info.subEn : info.subEs}
                      </p>
                      <ul className="flex flex-wrap gap-1.5 list-none p-0 m-0">
                        {info.ing.map((ing) => (
                          <li
                            key={ing.quitar}
                            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[clamp(13px,2.3vw,15px)] font-bold text-neutral-100 ${on ? 'bg-brand-800' : 'bg-neutral-800'}`}
                          >
                            <BuilderIcon name={ing.icon} className="h-[1.15em] w-[1.15em] flex-shrink-0" />
                            {en ? ing.en : ing.es}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {step === 'quitar' && base && (
          <>
            <p className="text-center text-neutral-400 font-bold text-sm mb-3.5">{t('wizard.modifyHint')}</p>
            <div className="flex flex-col gap-2.5 max-w-[640px] mx-auto">
              {quitarRows.map((opt) => {
                const off = draft.removed.includes(opt.id);
                return (
                  <button
                    key={opt.id}
                    onClick={() => toggleQuitar(opt)}
                    className={`min-h-[60px] rounded-[14px] border-2 px-4 py-2.5 flex items-center justify-between gap-3 text-left text-[17px] font-extrabold transition-colors ${off ? 'border-brand-500 bg-brand-900' : 'border-neutral-800 bg-neutral-900'}`}
                  >
                    <span className={`flex items-center gap-3 ${off ? 'line-through text-brand-200' : ''}`}>
                      <BuilderIcon name={quitarIcon(opt.name)} className="h-[26px] w-[26px] text-brand-300 flex-shrink-0" />
                      {opt.name}
                    </span>
                    <span
                      className={`text-[13px] font-black tracking-[0.08em] uppercase ${off ? 'text-brand-300' : 'text-neutral-500'}`}
                    >
                      {off ? t('wizard.without') : t('wizard.withIt')}
                    </span>
                  </button>
                );
              })}
            </div>
          </>
        )}

        {step === 'agregar' && (
          <>
            {!addonsOnly && base && (
              <AddonSection label={t('wizard.extras')}>
                {extrasOptions(base).map((opt) => {
                  const qty = draft.extras[opt.id] || 0;
                  return (
                    <AddCard
                      key={opt.id}
                      icon={<BuilderIcon name={EXTRA_ICON[opt.name] || 'avocado'} className="h-[clamp(34px,6vw,48px)] w-[clamp(34px,6vw,48px)] text-brand-300" />}
                      name={opt.name}
                      price={`+${pesos(opt.price_adjustment)}`}
                      qty={qty}
                      onClick={() => addExtra(opt)}
                    />
                  );
                })}
              </AddonSection>
            )}

            <AddonSection label={t('wizard.sides')}>
              {(menu?.addons.sides || []).map((a) => (
                <AddCard
                  key={a.id}
                  icon={<BuilderIcon name={addonIcon(a.name)} className="h-[clamp(34px,6vw,48px)] w-[clamp(34px,6vw,48px)] text-brand-300" />}
                  name={en && a.name_en ? a.name_en : a.name}
                  price={`+${pesos(a.price)}`}
                  qty={lines.filter((l) => l.menu_item_id === a.id).reduce((s, l) => s + l.quantity, 0)}
                  onClick={() => addAddon(a)}
                />
              ))}
            </AddonSection>

            <AddonSection label={t('wizard.drinks')}>
              {(menu?.addons.drinks || []).map((a) => (
                <AddCard
                  key={a.id}
                  icon={<BuilderIcon name={addonIcon(a.name)} className="h-[clamp(34px,6vw,48px)] w-[clamp(34px,6vw,48px)] text-brand-300" />}
                  name={en && a.name_en ? a.name_en : a.name}
                  price={`+${pesos(a.price)}`}
                  qty={lines.filter((l) => l.menu_item_id === a.id).reduce((s, l) => s + l.quantity, 0)}
                  onClick={() => addAddon(a)}
                />
              ))}
            </AddonSection>
          </>
        )}
      </main>

      <footer className="flex flex-col gap-2.5 px-4 py-3 pb-safe border-t border-neutral-800 flex-shrink-0">
        {step === 'protein' && (
          <>
            <FooterBtn
              disabled={!selection}
              split={!!selection}
              onClick={() => setStep('estilo')}
              left={
                selection
                  ? `${t('wizard.continue')}${draft.proteins.length === 2 ? ` · ${t('wizard.comboTag')}` : ''}`
                  : t('wizard.proteinPick')
              }
              right={selection ? pesos(proteinPrice(draft.proteins, items)) : undefined}
            />
            <FooterBtn
              variant="ghost"
              onClick={() => { setDraft(emptyDraft()); navigate('/'); }}
              left={`← ${t('wizard.startOver')}`}
            />
          </>
        )}

        {step === 'estilo' && (
          <>
            <FooterBtn disabled={!draft.estiloName} onClick={() => setStep('agregar')} left={t('wizard.asIs')} />
            <FooterBtn variant="ghost" disabled={!draft.estiloName} onClick={() => setStep('quitar')} left={t('wizard.modify')} />
          </>
        )}

        {step === 'quitar' && <FooterBtn onClick={() => setStep('agregar')} left={t('wizard.continue')} />}

        {step === 'agregar' && (() => {
          const running = cartTotal + (addonsOnly ? 0 : linePrice);
          const anything = !addonsOnly || lines.length > 0;
          return (
            <FooterBtn
              split={anything}
              onClick={finish}
              left={anything ? t('wizard.continue') : t('wizard.skip')}
              right={anything ? `${t('wizard.total')}: ${pesos(running)}` : undefined}
            />
          );
        })()}
      </footer>

      {/* Transient pill — "Máximo 2 proteínas", "¡Agregado! Queso extra" */}
      {note && (
        <div className="fixed left-1/2 -translate-x-1/2 bottom-[calc(90px+env(safe-area-inset-bottom))] z-50 pointer-events-none bg-brand-600 text-white font-black text-[15px] px-5 py-2.5 rounded-full shadow-[0_8px_30px_rgba(0,0,0,0.5)] whitespace-nowrap">
          {note}
        </div>
      )}
    </div>
  );
};

const AddonSection: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => {
  const kids = React.Children.toArray(children);
  if (kids.length === 0) return null;
  return (
    <>
      <p className="text-[13px] font-black tracking-[0.12em] uppercase text-neutral-400 mt-[18px] first:mt-0 mb-2.5">
        {label}
      </p>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-3.5 pb-2">{kids}</div>
    </>
  );
};

const AddCard: React.FC<{
  icon: React.ReactNode;
  name: string;
  price: string;
  qty: number;
  onClick: () => void;
}> = ({ icon, name, price, qty, onClick }) => (
  <button
    onClick={onClick}
    className={`relative min-h-[132px] rounded-2xl border-2 p-[18px_14px] flex flex-col items-center justify-center gap-2 text-center active:scale-[0.96] transition-transform ${qty ? 'border-brand-400 bg-brand-900' : 'border-neutral-800 bg-neutral-900'}`}
  >
    {qty > 0 && (
      <span className="absolute -top-2 -right-2 min-w-[28px] h-7 px-2 rounded-[14px] bg-brand-600 text-[15px] font-black flex items-center justify-center shadow-lg">
        ×{qty}
      </span>
    )}
    {icon}
    <span className="text-[clamp(15px,2.6vw,19px)] font-black leading-[1.15]">{name}</span>
    <span className="text-[clamp(14px,2.4vw,17px)] font-extrabold text-brand-300">{price}</span>
  </button>
);

const FooterBtn: React.FC<{
  left: string;
  right?: string;
  variant?: 'primary' | 'ghost';
  split?: boolean;
  disabled?: boolean;
  onClick: () => void;
}> = ({ left, right, variant = 'primary', split, disabled, onClick }) => (
  <button
    onClick={onClick}
    disabled={disabled}
    className={`w-full min-h-[56px] rounded-[14px] px-5 py-3 text-[18px] font-black text-white flex items-center gap-2.5 active:scale-[0.98] transition-transform ${
      split ? 'justify-between' : 'justify-center'
    } ${
      variant === 'ghost'
        ? 'bg-neutral-800 active:bg-neutral-700 disabled:text-neutral-500'
        : 'bg-brand-600 active:bg-brand-700 disabled:bg-neutral-800 disabled:text-neutral-500'
    }`}
  >
    <span>{left}</span>
    {right && <small className="text-sm font-bold opacity-80">{right}</small>}
  </button>
);

export default BuilderWizardScreen;
