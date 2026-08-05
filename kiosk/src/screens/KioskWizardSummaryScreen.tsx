// Wizard-mode order summary — parity with the prototype's `rSummary` (v15).
//
// Only mounts for wizard-mode devices; KioskCartScreen keeps rendering the grid
// cart for every other tenant and device, byte-for-byte unchanged.
//
// The prototype holds its cart as rich draft objects, so it can print
// "Burrito Carne Asada + Camarón · Mission Style · sin crema" straight from
// memory. A committed cart line here is only a menu item id plus a flat list of
// modifier ids, so the same sentence is reconstructed by looking those ids up
// against the fetched builder data. That is also what makes "Editar" possible:
// the line decodes back into a wizard draft (see decodeDraft).
import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useKioskBinding } from '../context/KioskBindingContext';
import { useKioskCart, type KioskCartLine } from '../context/KioskCartContext';
import { useIdleTimer } from '../hooks/useIdleTimer';
import LanguageToggle from '../components/LanguageToggle';
import { fetchBuilderMenu, type BuilderItem, type BuilderMenu } from '../lib/kioskApi';
import { BuilderIcon, type BuilderIconName } from '../lib/builderIcons';
import { PRESET_ICON, STYLE_INFO, addonIcon, proteinLabel } from '../lib/builderMeta';
import { PROTEIN_SLUGS, decodeDraft, pesos } from '../lib/builderPricing';
import type { WizardEdit } from './BuilderWizardScreen';

const PRESET_KEY = 'kiosk-wizard-preset';
const EDIT_KEY = 'kiosk-wizard-edit';

/** Fixed favoritos are builder items too, but they render as plain lines. */
const FIXED_SLUG_ICON: Record<string, BuilderIconName> = {
  birria: PRESET_ICON.birria,
  cochinita: PRESET_ICON.cochinita,
  rollbertos: PRESET_ICON.rollbertos,
};

interface Described {
  icon: BuilderIconName;
  title: string;
  /** Removals then extras, already in display order. */
  mods: Array<{ text: string; removed: boolean }>;
  /** Present only when the line can be reopened in the wizard. */
  edit: WizardEdit | null;
}

const KioskWizardSummaryScreen: React.FC = () => {
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const { tenantId, kioskToken } = useKioskBinding();
  const { lines, total, removeLine } = useKioskCart();
  const en = i18n.language.startsWith('en');

  const { warning } = useIdleTimer(() => navigate('/'), 120_000);

  const [menu, setMenu] = useState<BuilderMenu | null>(null);
  useEffect(() => {
    if (!tenantId || !kioskToken) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const data = await fetchBuilderMenu({ tenantId, kioskToken });
        if (!cancelled) setMenu(data);
      } catch {
        // Fall back to the line's own name — the order is already priced and
        // must stay payable even if this request fails.
      }
    })();
    return () => { cancelled = true; };
  }, [tenantId, kioskToken]);

  const items = menu?.items || [];
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);

  const describe = (line: KioskCartLine): Described => {
    const item: BuilderItem | undefined = byId.get(line.menu_item_id);
    const slug = item?.slug || '';
    const isBurrito = PROTEIN_SLUGS.includes(slug as (typeof PROTEIN_SLUGS)[number]);

    if (!isBurrito) {
      return {
        icon: FIXED_SLUG_ICON[slug] || addonIcon(line.name),
        title: line.quantity > 1 ? `${line.name} ×${line.quantity}` : line.name,
        mods: [],
        edit: null,
      };
    }

    const draft = decodeDraft(line.menu_item_id, line.modifiers.map((m) => m.id), items);
    const proteins = draft?.proteins || [slug];
    const protNames = proteins.map((s) => proteinLabel(s, en)).join(' + ');
    const style = draft?.estiloName ? STYLE_INFO[draft.estiloName] : null;
    const isFries = draft?.estiloName === 'Fries';

    const title = isFries
      ? `${protNames} Fries`
      : `${t('wizard.burrito')} ${protNames}${style ? ` · ${en ? style.en : style.es}` : ''}`;

    // Removals read as the option name lowercased ("Sin crema" → "sin crema"),
    // which is exactly the prototype's `sin <ingrediente>` phrasing.
    const removedNames = line.modifiers
      .filter((m) => draft?.removed.includes(m.id))
      .map((m) => ({ text: m.name.toLowerCase(), removed: true }));

    const extraCounts = new Map<string, number>();
    for (const m of line.modifiers) {
      if (!draft?.extras[m.id]) continue;
      extraCounts.set(m.name, (extraCounts.get(m.name) || 0) + 1);
    }
    const extraNames = [...extraCounts].map(([name, qty]) => ({
      text: `+ ${name}${qty > 1 ? ` ×${qty}` : ''}`,
      removed: false,
    }));

    return {
      icon: isFries ? 'fries' : 'burrito',
      title: line.quantity > 1 ? `${title} ×${line.quantity}` : title,
      mods: [...removedNames, ...extraNames],
      edit: draft
        ? { lineKey: line.line_key, menuItemId: line.menu_item_id, modifierIds: line.modifiers.map((m) => m.id) }
        : null,
    };
  };

  /** Every route into the wizard clears whichever hand-off key doesn't apply,
   *  so the wizard itself can stay a pure reader of both (StrictMode-safe). */
  const intoWizard = (path: string, edit: WizardEdit | null) => {
    sessionStorage.removeItem(PRESET_KEY);
    if (edit) sessionStorage.setItem(EDIT_KEY, JSON.stringify(edit));
    else sessionStorage.removeItem(EDIT_KEY);
    navigate(path);
  };

  return (
    <div className="h-full w-full bg-neutral-950 text-neutral-50 flex flex-col">
      <header className="flex items-center justify-between gap-3 px-4 py-3 pt-safe border-b border-neutral-800 flex-shrink-0">
        <div className="min-w-0">
          <p className="text-xs font-bold uppercase tracking-[0.12em] text-neutral-500 mb-0.5">
            {t('wizard.orderK')}
          </p>
          <h1 className="text-[clamp(22px,4.5vw,40px)] font-black leading-[1.05] truncate">
            {t('wizard.yourOrder')}
          </h1>
        </div>
        <div className="flex gap-2 flex-shrink-0">
          <LanguageToggle />
        </div>
      </header>

      <main className="flex-1 min-h-0 overflow-y-auto p-4">
        <div className="flex flex-col gap-3 max-w-[640px] mx-auto">
          {lines.length === 0 && (
            <p className="text-center text-neutral-400 font-bold text-sm">{t('wizard.emptyCart')}</p>
          )}

          {lines.map((line) => {
            const d = describe(line);
            return (
              <div key={line.line_key} className="rounded-2xl bg-neutral-900 border border-neutral-800 p-4">
                <div className="flex justify-between items-baseline gap-3">
                  <b className="text-[18px] font-black inline-flex items-baseline gap-2 min-w-0">
                    <BuilderIcon name={d.icon} className="h-[1.1em] w-[1.1em] flex-shrink-0 self-center text-brand-300" />
                    <span className="min-w-0">{d.title}</span>
                  </b>
                  <span className="text-[17px] font-black text-brand-300 whitespace-nowrap">
                    {pesos(line.price * line.quantity)}
                  </span>
                </div>

                {d.mods.length > 0 && (
                  <p className="mt-1.5 text-sm font-semibold text-neutral-300 leading-relaxed">
                    {d.mods.map((m, i) => (
                      <React.Fragment key={m.text}>
                        {i > 0 && ' · '}
                        <span className={m.removed ? 'text-brand-300' : undefined}>{m.text}</span>
                      </React.Fragment>
                    ))}
                  </p>
                )}

                <div className="flex gap-2 mt-3">
                  {d.edit && (
                    <button
                      onClick={() => intoWizard('/wizard', d.edit)}
                      className="h-10 px-3.5 rounded-[10px] bg-neutral-800 active:bg-neutral-700 text-[13px] font-extrabold"
                    >
                      {t('wizard.edit')}
                    </button>
                  )}
                  <button
                    onClick={() => removeLine(line.line_key)}
                    className="h-10 px-3.5 rounded-[10px] bg-neutral-800 active:bg-neutral-700 text-[13px] font-extrabold"
                  >
                    {t('wizard.remove')}
                  </button>
                </div>
              </div>
            );
          })}

          {lines.length > 0 && (
            <div className="flex justify-between px-1.5 py-1 text-[22px] font-black">
              <span>{t('wizard.total')}</span>
              <span className="text-brand-300">{pesos(total)}</span>
            </div>
          )}
        </div>
      </main>

      <footer className="flex flex-col gap-2.5 px-4 py-3 pb-safe border-t border-neutral-800 flex-shrink-0">
        <button
          onClick={() => intoWizard('/wizard', null)}
          className="w-full min-h-[56px] rounded-[14px] px-5 py-3 text-[18px] font-black text-white bg-neutral-800 active:bg-neutral-700 flex items-center justify-center gap-2.5 active:scale-[0.98] transition-transform"
        >
          {t('wizard.anotherBurrito')}
        </button>
        <button
          onClick={() => intoWizard('/wizard?mode=addons', null)}
          className="w-full min-h-[56px] rounded-[14px] px-5 py-3 text-[18px] font-black text-white bg-neutral-800 active:bg-neutral-700 flex items-center justify-center gap-2.5 active:scale-[0.98] transition-transform"
        >
          {t('wizard.addMore')}
        </button>
        <button
          disabled={lines.length === 0}
          onClick={() => navigate('/fulfillment')}
          className="w-full min-h-[56px] rounded-[14px] px-5 py-3 text-[18px] font-black text-white bg-brand-600 active:bg-brand-700 disabled:bg-neutral-800 disabled:text-neutral-500 flex items-center justify-between gap-2.5 active:scale-[0.98] transition-transform"
        >
          <span>{t('wizard.pay')}</span>
          <small className="text-sm font-bold opacity-80">{pesos(total)}</small>
        </button>
      </footer>

      {warning}
    </div>
  );
};

export default KioskWizardSummaryScreen;
