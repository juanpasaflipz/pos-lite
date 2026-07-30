// Item-level delivery import — the inventory and COGS half of manual sales.
//
// The settlement import (ManualSalesTab's "Import file" mode) books delivery
// revenue and commission. It cannot touch inventory, because a settlement
// export has no product detail. This panel reads the platform's per-product
// daily report instead and does the other half: units sold per menu item,
// ingredient deduction, COGS. It creates NO orders — that money is already in
// the books from the settlement import, and counting it twice is the failure
// mode this whole design avoids. See server/db/migrations/0095.
//
// The confirmation step is the point of the screen, not friction around it.
// The report gives money, not units, and platform prices differ from POS prices
// (a $99 POS item bills $129 on DiDi), so units are worked out as
// gross ÷ platform price. A wrong price deducts wrong stock silently, so every
// price and every match is shown with the resulting unit count next to it.
// Confirmed answers are remembered per platform and never asked again.
import React, { useState, useMemo, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Upload, AlertTriangle, PackageSearch, Check, EyeOff, CircleHelp,
} from 'lucide-react';
import {
  previewProductImport,
  commitProductImport,
  getMenuItems,
  ProductImportPreview,
  ProductImportItem,
} from '../../api';
import { MenuItem } from '../../types';
import { formatPrice } from '../../utils/currency';

// Mirrors deriveQuantity() in server/lib/salesImport.js. Duplicated so a price
// edit re-derives units instantly instead of round-tripping the file; the
// server re-derives on commit and its answer is the one that gets written.
const QTY_TOLERANCE = 0.02;
function deriveUnits(gross: number, price: number | null): { quantity: number | null; exact: boolean } {
  if (!price || price <= 0 || !gross || gross <= 0) return { quantity: null, exact: false };
  const raw = gross / price;
  const rounded = Math.round(raw);
  if (rounded < 1) return { quantity: null, exact: false };
  return { quantity: rounded, exact: Math.abs(raw - rounded) / rounded <= QTY_TOLERANCE };
}

interface Props {
  channel: string;
  businessDate: string;
  note: string;
  inputCls: string;
  labelCls: string;
  onDone: (message: string) => void;
  onError: (e: unknown) => void;
}

export default function ProductImportPanel({
  channel, businessDate, note, inputCls, labelCls, onDone, onError,
}: Props) {
  const { t } = useTranslation('inventory');
  const k = (key: string, fallback: string, opts?: Record<string, unknown>) =>
    t(`delivery.products.${key}`, { defaultValue: fallback, ...(opts || {}) });

  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ProductImportPreview | null>(null);
  const [items, setItems] = useState<ProductImportItem[]>([]);
  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
  const [deductInventory, setDeductInventory] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getMenuItems().then(setMenuItems).catch(() => { /* select falls back to empty */ });
  }, []);

  async function runPreview(f: File, mapping?: Record<string, string | null>, sheet?: string) {
    setBusy(true);
    try {
      const p = await previewProductImport(f, { channel, business_date: businessDate, mapping, sheet });
      setPreview(p);
      setItems(p.items);
    } catch (e) { onError(e); setPreview(null); setItems([]); } finally { setBusy(false); }
  }

  /** Re-derive a row's per-day units whenever its price or match changes. */
  function patchItem(normName: string, patch: Partial<ProductImportItem>) {
    setItems((prev) => prev.map((it) => {
      if (it.norm_name !== normName) return it;
      const next = { ...it, ...patch };
      if ('platform_price' in patch) {
        next.days = next.days.map((d) => {
          if (d.quantity_source === 'column') return d;
          const { quantity, exact } = deriveUnits(d.gross, next.platform_price);
          return { ...d, quantity, exact };
        });
        next.total_quantity = next.days.reduce((s, d) => s + (d.already_imported ? 0 : (d.quantity || 0)), 0);
      }
      return next;
    }));
  }

  const active = useMemo(() => items.filter((i) => !i.ignored), [items]);
  const ready = useMemo(
    () => active.filter((i) => i.platform_price && i.platform_price > 0 && i.total_quantity > 0),
    [active]
  );
  const unresolved = active.length - ready.length;
  const totalUnits = ready.reduce((s, i) => s + i.total_quantity, 0);
  const totalCogs = ready.reduce((s, i) => s + (i.unit_cost || 0) * i.total_quantity, 0);
  const withoutRecipe = ready.filter((i) => i.menu_item_id && i.unit_cost == null).length;
  const notMatched = ready.filter((i) => !i.menu_item_id).length;

  async function submit() {
    if (!preview) return;
    setBusy(true);
    try {
      const res = await commitProductImport({
        channel, items, source_filename: file?.name, note: note || undefined,
        deduct_inventory: deductInventory,
      });
      onDone(k('saved', '{{units}} units recorded across {{lines}} product-days — {{cogs}} in ingredient cost', {
        units: res.units, lines: res.lines, cogs: formatPrice(res.cogs_total),
      }));
      setPreview(null); setItems([]); setFile(null);
    } catch (e) { onError(e); } finally { setBusy(false); }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 p-3 rounded-lg bg-neutral-900/60 border border-neutral-800 text-sm text-neutral-400">
        <PackageSearch size={16} className="mt-0.5 shrink-0 text-brand-500" />
        <p>{k('intro', 'Upload the platform’s per-product report to deduct ingredients and record cost of goods. This does not add revenue — your settlement import already did that. Confirm each product once and it is remembered.')}</p>
      </div>

      <div>
        <label className={labelCls} htmlFor="pi-file">{k('file', 'Per-product report from the platform portal')}</label>
        <input
          id="pi-file" type="file" accept=".csv,.tsv,.txt,.xlsx,.xls"
          className="block w-full text-sm text-neutral-300 file:mr-3 file:min-h-[40px] file:px-4 file:rounded-lg file:border-0 file:bg-brand-600 file:text-white hover:file:bg-brand-500"
          onChange={(e) => {
            const f = e.target.files?.[0] || null;
            setFile(f); setPreview(null); setItems([]);
            if (f) void runPreview(f);
          }}
        />
        <p className="mt-1.5 text-xs text-neutral-500">
          {k('fileHint', 'DiDi: Datos → Reporte diario de productos. Rappi’s settlement export has no product detail, so it cannot feed inventory — use it in “Import file” for revenue instead.')}
        </p>
      </div>

      {preview && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <Stat label={k('productsFound', 'Products')} value={String(preview.product_count)} />
            <Stat label={k('unitsLabel', 'Units')} value={String(totalUnits)} highlight />
            <Stat label={k('cogsLabel', 'Ingredient cost')} value={formatPrice(totalCogs)} />
            <Stat label={k('needsYou', 'Need your input')} value={String(unresolved)} />
          </div>

          {preview.date_range && (
            <p className="text-xs text-neutral-500">
              {k('dateRange', 'Covers {{from}} → {{to}}', { from: preview.date_range.from, to: preview.date_range.to })}
            </p>
          )}

          {preview.sheets.length > 1 && (
            <div>
              <label className={labelCls} htmlFor="pi-sheet">{k('sheet', 'Sheet')}</label>
              <select id="pi-sheet" className={inputCls} value={preview.sheet ?? ''}
                      onChange={(e) => { if (file) void runPreview(file, undefined, e.target.value); }}>
                {preview.sheets.map((sh) => <option key={sh} value={sh}>{sh}</option>)}
              </select>
            </div>
          )}

          <div>
            <p className={labelCls}>{k('mapping', 'Which column is which')}</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {(['business_date', 'item_name', 'quantity', 'gross'] as const).map((field) => (
                <div key={field} className="flex items-center gap-2">
                  <span className="w-28 shrink-0 text-xs text-neutral-400">{k(`field_${field}`, field.replace(/_/g, ' '))}</span>
                  <select
                    className={inputCls}
                    value={preview.mapping[field] ?? ''}
                    onChange={(e) => {
                      const next = { ...preview.mapping, [field]: e.target.value || null };
                      if (file) void runPreview(file, next, preview.sheet ?? undefined);
                    }}
                  >
                    <option value="">{k('ignore', '— ignore —')}</option>
                    {preview.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                  </select>
                </div>
              ))}
            </div>
          </div>

          {preview.warnings.length > 0 && (
            <ul className="space-y-1 p-3 rounded-lg bg-amber-950/40 border border-amber-900 text-xs text-amber-200">
              {preview.warnings.map((w) => (
                <li key={w} className="flex items-start gap-2"><AlertTriangle size={13} className="mt-0.5 shrink-0" />{w}</li>
              ))}
            </ul>
          )}

          {/* Per-product confirmation. */}
          <div className="space-y-2">
            <p className={labelCls}>{k('confirmEach', 'Confirm each product')}</p>
            {items.map((it) => (
              <ProductRow
                key={it.norm_name}
                item={it}
                menuItems={menuItems}
                inputCls={inputCls}
                k={k}
                onPatch={(patch) => patchItem(it.norm_name, patch)}
              />
            ))}
          </div>

          {(notMatched > 0 || withoutRecipe > 0) && (
            <p className="text-xs text-neutral-500">
              {notMatched > 0 && k('notMatchedNote', '{{n}} product(s) have no menu item — their units are recorded but no ingredients come out of stock. ', { n: notMatched })}
              {withoutRecipe > 0 && k('noRecipeNote', '{{n}} matched product(s) have no recipe yet, so they contribute no cost.', { n: withoutRecipe })}
            </p>
          )}

          <label className="flex items-center gap-2 text-sm text-neutral-300">
            <input type="checkbox" className="w-4 h-4 accent-brand-600" checked={deductInventory}
                   onChange={(e) => setDeductInventory(e.target.checked)} />
            {k('deductInventory', 'Deduct ingredients from inventory')}
          </label>

          <button disabled={busy || ready.length === 0} onClick={submit}
                  className="min-h-[40px] px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium text-sm flex items-center gap-2">
            <Upload size={15} />
            {busy ? k('importing', 'Importing…') : k('importN', 'Record {{units}} units', { units: totalUnits })}
          </button>
        </div>
      )}
    </div>
  );
}

function ProductRow({ item, menuItems, inputCls, k, onPatch }: {
  item: ProductImportItem;
  menuItems: MenuItem[];
  inputCls: string;
  k: (key: string, fallback: string, opts?: Record<string, unknown>) => string;
  onPatch: (patch: Partial<ProductImportItem>) => void;
}) {
  const pending = item.days.filter((d) => !d.already_imported);
  const hasInexact = pending.some((d) => d.quantity && !d.exact);
  const needsInput = !item.ignored && (!item.platform_price || item.total_quantity < 1);
  // 'single' means one day's total was the only evidence for the price — the
  // arithmetic is satisfiable by any divisor, so it is a guess, not a finding.
  const weakPrice = item.price_basis === 'single' && !item.ignored;

  return (
    <div className={`p-3 rounded-lg border ${
      item.ignored ? 'bg-neutral-900/40 border-neutral-800 opacity-60'
        : needsInput || hasInexact || weakPrice ? 'bg-amber-950/20 border-amber-900/60'
        : 'bg-neutral-900 border-neutral-800'
    }`}>
      <div className="flex flex-wrap items-start justify-between gap-2 mb-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-neutral-100 truncate">{item.platform_item_name}</p>
          <p className="text-xs text-neutral-500">
            {k('grossAcross', '{{gross}} across {{days}} day(s)', {
              gross: formatPrice(item.total_gross), days: pending.length,
            })}
            <MatchBadge confidence={item.match_confidence} k={k} />
          </p>
        </div>
        <button
          type="button"
          onClick={() => onPatch({ ignored: !item.ignored })}
          className="min-h-[40px] px-3 rounded-lg bg-neutral-800 text-neutral-300 hover:bg-neutral-700 text-xs flex items-center gap-1.5 shrink-0"
        >
          {item.ignored ? <><Check size={13} />{k('include', 'Include')}</> : <><EyeOff size={13} />{k('skip', 'Skip')}</>}
        </button>
      </div>

      {!item.ignored && (
        <div className="grid grid-cols-1 sm:grid-cols-[2fr_1fr_auto] gap-2 items-end">
          <div>
            <label className="block text-xs text-neutral-400 mb-1">{k('menuItem', 'Menu item')}</label>
            <select
              className={inputCls}
              value={item.menu_item_id ?? ''}
              onChange={(e) => {
                const id = e.target.value ? Number(e.target.value) : null;
                const mi = menuItems.find((m) => Number(m.id) === id);
                onPatch({
                  menu_item_id: id,
                  menu_item_name: mi?.name ?? null,
                  pos_price: Number(mi?.price) || null,
                });
              }}
            >
              <option value="">{k('noMenuItem', '— not on the POS menu —')}</option>
              {menuItems.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </div>

          <div>
            <label className="block text-xs text-neutral-400 mb-1">
              {k('platformPrice', 'Price on this platform')}
            </label>
            <input
              type="number" min={0} step="0.01" inputMode="decimal" className={inputCls}
              value={item.platform_price ?? ''}
              onChange={(e) => onPatch({ platform_price: e.target.value ? parseFloat(e.target.value) : null })}
            />
          </div>

          <div className="pb-2 text-right min-w-[80px]">
            <p className="text-xs text-neutral-400">{k('units', 'Units')}</p>
            <p className={`text-lg font-semibold ${
              item.total_quantity > 0 && !hasInexact ? 'text-brand-300' : 'text-amber-300'
            }`}>
              {item.total_quantity || '—'}
            </p>
          </div>
        </div>
      )}

      {!item.ignored && item.pos_price != null && item.platform_price != null
        && Math.abs(item.platform_price - item.pos_price) > 0.005 && (
        <p className="mt-2 text-xs text-neutral-500">
          {k('markup', 'POS price is {{pos}} — this platform bills {{plat}} ({{pct}}% markup).', {
            pos: formatPrice(item.pos_price),
            plat: formatPrice(item.platform_price),
            pct: Math.round(((item.platform_price / item.pos_price) - 1) * 100),
          })}
        </p>
      )}

      {!item.ignored && weakPrice && (
        <p className="mt-2 text-xs text-amber-300 flex items-start gap-1.5">
          <CircleHelp size={13} className="mt-0.5 shrink-0" />
          {k('weakPrice', 'Only one day of sales for this product, so the price could not be worked out — it was assumed to be a single unit. Enter the real platform price.')}
        </p>
      )}

      {!item.ignored && hasInexact && (
        <p className="mt-2 text-xs text-amber-300 flex items-start gap-1.5">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          {k('inexact', 'Sales do not divide evenly into whole units at this price — check it, or that day had a discount.')}
        </p>
      )}

      {!item.ignored && pending.length > 1 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {pending.map((d) => (
            <span key={d.business_date}
                  className={`px-2 py-0.5 rounded text-xs ${
                    d.quantity && d.exact ? 'bg-neutral-800 text-neutral-400' : 'bg-amber-950/60 text-amber-300'
                  }`}>
              {d.business_date.slice(5)} · {formatPrice(d.gross)} → {d.quantity ?? '?'}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function MatchBadge({ confidence, k }: {
  confidence: ProductImportItem['match_confidence'];
  k: (key: string, fallback: string) => string;
}) {
  if (confidence === 'none') return null;
  const label = {
    saved: k('matchSaved', 'remembered'),
    exact: k('matchExact', 'exact match'),
    contains: k('matchContains', 'name match'),
    fuzzy: k('matchFuzzy', 'best guess'),
  }[confidence];
  const tone = confidence === 'fuzzy' ? 'text-amber-400' : 'text-neutral-500';
  return <span className={`ml-2 ${tone}`}>· {label}</span>;
}

function Stat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className={`p-3 rounded-lg border ${highlight ? 'bg-brand-950/40 border-brand-800' : 'bg-neutral-900 border-neutral-800'}`}>
      <p className="text-xs text-neutral-400">{label}</p>
      <p className={`text-sm font-semibold ${highlight ? 'text-brand-300' : 'text-neutral-100'}`}>{value}</p>
    </div>
  );
}
