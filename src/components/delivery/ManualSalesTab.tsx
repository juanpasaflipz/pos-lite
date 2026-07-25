// Manual & imported sales entry.
//
// Delivery-app revenue never touches the POS, so without this the revenue
// reports, the channel mix and the break-even calculator all under-report
// reality for any tenant selling on Rappi / DiDi. Three modes, best data first:
// import a settlement export, type one itemized order, or record a day's
// gross + order count. See server/routes/manual-sales.js.
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Upload, CalendarDays, ListPlus, Trash2, AlertTriangle, CheckCircle2,
  Plus, Minus, FileSpreadsheet, RotateCcw, Info,
} from 'lucide-react';
import {
  getManualSalesChannels,
  getManualSalesBatches,
  createAggregateManualSale,
  createItemizedManualSale,
  previewManualSalesImport,
  commitManualSalesImport,
  deleteManualSalesBatch,
  getMenuItems,
  ManualSalesChannel,
  ManualSalesBatch,
  ManualSalesImportPreview,
} from '../../api';
import { MenuItem } from '../../types';
import { formatPrice } from '../../utils/currency';

type Mode = 'aggregate' | 'itemized' | 'import';
interface Line { key: string; menu_item_id: number | null; item_name: string; quantity: number; unit_price: number }

const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export default function ManualSalesTab() {
  const { t } = useTranslation('inventory');
  const k = (key: string, fallback: string, opts?: Record<string, unknown>) =>
    t(`delivery.manual.${key}`, { defaultValue: fallback, ...(opts || {}) });

  const [mode, setMode] = useState<Mode>('aggregate');
  const [channels, setChannels] = useState<ManualSalesChannel[]>([]);
  const [batches, setBatches] = useState<ManualSalesBatch[]>([]);
  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
  const [channel, setChannel] = useState('');
  const [businessDate, setBusinessDate] = useState(todayISO());
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // aggregate
  const [orderCount, setOrderCount] = useState('');
  const [grossTotal, setGrossTotal] = useState('');

  // itemized
  const [lines, setLines] = useState<Line[]>([]);
  const [deductInventory, setDeductInventory] = useState(true);

  // import
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ManualSalesImportPreview | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const selectedChannel = useMemo(
    () => channels.find((c) => c.name === channel) || null,
    [channels, channel]
  );
  const commissionPct = Number(selectedChannel?.commission_percent) || 0;

  useEffect(() => { void loadAll(); }, []);

  async function loadAll() {
    try {
      const [ch, bt] = await Promise.all([getManualSalesChannels(), getManualSalesBatches(25)]);
      setChannels(ch.platforms);
      setBatches(bt.batches);
      if (!channel && ch.platforms.length) setChannel(ch.platforms[0].name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    if (mode !== 'itemized' || menuItems.length) return;
    getMenuItems().then(setMenuItems).catch(() => { /* itemized falls back to free-text names */ });
  }, [mode, menuItems.length]);

  const flash = (msg: string) => { setSuccess(msg); setError(null); window.setTimeout(() => setSuccess(null), 6000); };
  const fail = (e: unknown) => { setError(e instanceof Error ? e.message : String(e)); setSuccess(null); };

  const aggregateGross = parseFloat(grossTotal) || 0;
  const aggregateCommission = Math.round(aggregateGross * (commissionPct / 100) * 100) / 100;
  const itemizedGross = lines.reduce((s, l) => s + l.unit_price * l.quantity, 0);
  const itemizedCommission = Math.round(itemizedGross * (commissionPct / 100) * 100) / 100;

  async function submitAggregate() {
    setBusy(true);
    try {
      const res = await createAggregateManualSale({
        channel, business_date: businessDate,
        order_count: parseInt(orderCount, 10), gross_total: aggregateGross,
        note: note || undefined,
      });
      flash(k('savedAggregate', '{{count}} orders recorded — {{net}} net after commission', {
        count: res.orders_created, net: formatPrice(res.net_total),
      }));
      setOrderCount(''); setGrossTotal(''); setNote('');
      await loadAll();
    } catch (e) { fail(e); } finally { setBusy(false); }
  }

  async function submitItemized() {
    setBusy(true);
    try {
      const res = await createItemizedManualSale({
        channel, business_date: businessDate,
        items: lines.map((l) => ({
          menu_item_id: l.menu_item_id, item_name: l.item_name,
          quantity: l.quantity, unit_price: l.unit_price,
        })),
        note: note || undefined,
        deduct_inventory: deductInventory,
      });
      flash(k('savedItemized', 'Order recorded — {{net}} net after commission', { net: formatPrice(res.net_total) }));
      setLines([]); setNote('');
      await loadAll();
    } catch (e) { fail(e); } finally { setBusy(false); }
  }

  async function runPreview(f: File, mapping?: Record<string, string | null>) {
    setBusy(true); setError(null);
    try {
      setPreview(await previewManualSalesImport(f, {
        business_date: businessDate, mapping,
      }));
    } catch (e) { fail(e); setPreview(null); } finally { setBusy(false); }
  }

  async function submitImport() {
    if (!preview) return;
    setBusy(true);
    try {
      const res = await commitManualSalesImport({
        channel, rows: preview.rows,
        source_filename: file?.name, note: note || undefined,
      });
      flash(res.orders_created
        ? k('savedImport', '{{count}} orders imported ({{skipped}} duplicates skipped)', {
            count: res.orders_created, skipped: res.skipped_duplicates,
          })
        : k('allDuplicates', 'Everything in that file was already recorded — nothing added.'));
      setPreview(null); setFile(null); setNote('');
      if (fileInput.current) fileInput.current.value = '';
      await loadAll();
    } catch (e) { fail(e); } finally { setBusy(false); }
  }

  async function undoBatch(b: ManualSalesBatch) {
    if (!window.confirm(k('confirmUndo', 'Remove this entry and the {{count}} order(s) it created?', { count: b.live_order_count }))) return;
    setBusy(true);
    try {
      const res = await deleteManualSalesBatch(b.id);
      flash(k('undone', '{{count}} order(s) removed', { count: res.orders_deleted }));
      await loadAll();
    } catch (e) { fail(e); } finally { setBusy(false); }
  }

  const addLine = () => setLines((ls) => [...ls, {
    key: `${Date.now()}-${ls.length}`, menu_item_id: null, item_name: '', quantity: 1, unit_price: 0,
  }]);
  const patchLine = (key: string, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const modes: { id: Mode; icon: React.ReactNode; label: string; hint: string }[] = [
    { id: 'aggregate', icon: <CalendarDays size={15} />, label: k('modeAggregate', 'By day'), hint: k('modeAggregateHint', 'Fastest — one platform, one day, gross + order count') },
    { id: 'itemized', icon: <ListPlus size={15} />, label: k('modeItemized', 'Itemized'), hint: k('modeItemizedHint', 'One order with real menu items — feeds costs and inventory') },
    { id: 'import', icon: <FileSpreadsheet size={15} />, label: k('modeImport', 'Import file'), hint: k('modeImportHint', 'Best — upload the platform sales export, real commission per order') },
  ];

  const inputCls = 'w-full min-h-[40px] px-3 py-2 rounded-lg bg-neutral-900 border border-neutral-700 text-neutral-100 focus:border-brand-500 focus:outline-none';
  const labelCls = 'block text-xs font-medium text-neutral-400 mb-1.5';

  const canSubmitAggregate = !!channel && !!businessDate && parseInt(orderCount, 10) > 0 && aggregateGross > 0;
  const canSubmitItemized = !!channel && !!businessDate && lines.length > 0
    && lines.every((l) => l.item_name.trim() && l.quantity > 0 && l.unit_price > 0);

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-2 p-3 rounded-lg bg-neutral-900/60 border border-neutral-800 text-sm text-neutral-400">
        <Info size={16} className="mt-0.5 shrink-0 text-brand-500" />
        <p>{k('intro', 'Record sales that happened outside the POS — delivery apps, phone orders — so revenue reports, channel mix and break-even reflect reality. These never reach the kitchen screen or print a ticket.')}</p>
      </div>

      {error && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-red-950/50 border border-red-900 text-sm text-red-200">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" /><p>{error}</p>
        </div>
      )}
      {success && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-emerald-950/50 border border-emerald-900 text-sm text-emerald-200">
          <CheckCircle2 size={16} className="mt-0.5 shrink-0" /><p>{success}</p>
        </div>
      )}

      {/* Mode switcher */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        {modes.map((m) => (
          <button
            key={m.id}
            onClick={() => { setMode(m.id); setError(null); }}
            className={`min-h-[40px] text-left p-3 rounded-lg border transition-colors ${
              mode === m.id
                ? 'bg-brand-600 border-brand-500 text-white'
                : 'bg-neutral-900 border-neutral-800 text-neutral-300 hover:bg-neutral-800'
            }`}
          >
            <span className="flex items-center gap-2 font-medium text-sm">{m.icon}{m.label}</span>
            <span className={`block mt-1 text-xs ${mode === m.id ? 'text-white/70' : 'text-neutral-500'}`}>{m.hint}</span>
          </button>
        ))}
      </div>

      {/* Shared fields */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className={labelCls} htmlFor="ms-channel">{k('channel', 'Platform')}</label>
          <select id="ms-channel" className={inputCls} value={channel} onChange={(e) => setChannel(e.target.value)}>
            {channels.map((c) => (
              <option key={c.name} value={c.name}>
                {c.display_name}{c.commission_percent ? ` — ${c.commission_percent}% ${k('commissionShort', 'commission')}` : ''}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls} htmlFor="ms-date">
            {mode === 'import' ? k('dateFallback', 'Date (only used if the file has none)') : k('date', 'Business date')}
          </label>
          <input id="ms-date" type="date" className={inputCls} value={businessDate} max={todayISO()}
                 onChange={(e) => setBusinessDate(e.target.value)} />
        </div>
      </div>

      {/* ===== Aggregate ===== */}
      {mode === 'aggregate' && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className={labelCls} htmlFor="ms-count">{k('orderCount', 'Number of orders')}</label>
              <input id="ms-count" type="number" min={1} inputMode="numeric" className={inputCls}
                     value={orderCount} onChange={(e) => setOrderCount(e.target.value)} placeholder="47" />
            </div>
            <div>
              <label className={labelCls} htmlFor="ms-gross">{k('grossTotal', 'Gross sales for the day')}</label>
              <input id="ms-gross" type="number" min={0} step="0.01" inputMode="decimal" className={inputCls}
                     value={grossTotal} onChange={(e) => setGrossTotal(e.target.value)} placeholder="12400.00" />
            </div>
          </div>
          {aggregateGross > 0 && (
            <SummaryRow gross={aggregateGross} commission={aggregateCommission} pct={commissionPct} k={k} />
          )}
          <NoteField value={note} onChange={setNote} labelCls={labelCls} inputCls={inputCls} k={k} />
          <button disabled={!canSubmitAggregate || busy} onClick={submitAggregate}
                  className="min-h-[40px] px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium text-sm">
            {busy ? k('saving', 'Saving…') : k('recordDay', 'Record day')}
          </button>
        </div>
      )}

      {/* ===== Itemized ===== */}
      {mode === 'itemized' && (
        <div className="space-y-4">
          <div className="space-y-2">
            {lines.map((l) => (
              <div key={l.key} className="flex flex-wrap items-end gap-2 p-2 rounded-lg bg-neutral-900 border border-neutral-800">
                <div className="flex-1 min-w-[180px]">
                  <label className={labelCls}>{k('item', 'Item')}</label>
                  {menuItems.length ? (
                    <select
                      className={inputCls}
                      value={l.menu_item_id ?? ''}
                      onChange={(e) => {
                        const id = e.target.value ? Number(e.target.value) : null;
                        const mi = menuItems.find((m) => Number(m.id) === id);
                        patchLine(l.key, {
                          menu_item_id: id,
                          item_name: mi?.name ?? '',
                          unit_price: Number(mi?.price) || l.unit_price,
                        });
                      }}
                    >
                      <option value="">{k('pickItem', 'Select an item…')}</option>
                      {menuItems.map((m) => (
                        <option key={m.id} value={m.id}>{m.name}</option>
                      ))}
                    </select>
                  ) : (
                    <input className={inputCls} value={l.item_name}
                           onChange={(e) => patchLine(l.key, { item_name: e.target.value })}
                           placeholder={k('itemName', 'Item name')} />
                  )}
                </div>
                <div className="w-24">
                  <label className={labelCls}>{k('qty', 'Qty')}</label>
                  <div className="flex items-center gap-1">
                    <button type="button" aria-label={k('decrease', 'Decrease')}
                            onClick={() => patchLine(l.key, { quantity: Math.max(1, l.quantity - 1) })}
                            className="min-h-[40px] w-10 rounded-lg bg-neutral-800 text-neutral-200 hover:bg-neutral-700">
                      <Minus size={14} className="mx-auto" />
                    </button>
                    <span className="w-8 text-center text-sm text-neutral-100">{l.quantity}</span>
                    <button type="button" aria-label={k('increase', 'Increase')}
                            onClick={() => patchLine(l.key, { quantity: l.quantity + 1 })}
                            className="min-h-[40px] w-10 rounded-lg bg-neutral-800 text-neutral-200 hover:bg-neutral-700">
                      <Plus size={14} className="mx-auto" />
                    </button>
                  </div>
                </div>
                <div className="w-32">
                  <label className={labelCls}>{k('unitPrice', 'Price')}</label>
                  <input type="number" min={0} step="0.01" inputMode="decimal" className={inputCls}
                         value={l.unit_price || ''} onChange={(e) => patchLine(l.key, { unit_price: parseFloat(e.target.value) || 0 })} />
                </div>
                <button type="button" aria-label={k('removeLine', 'Remove line')}
                        onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                        className="min-h-[40px] w-10 rounded-lg bg-neutral-800 text-red-300 hover:bg-red-950">
                  <Trash2 size={14} className="mx-auto" />
                </button>
              </div>
            ))}
          </div>

          <button type="button" onClick={addLine}
                  className="min-h-[40px] px-3 py-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-200 text-sm flex items-center gap-2">
            <Plus size={15} />{k('addItem', 'Add item')}
          </button>

          {itemizedGross > 0 && <SummaryRow gross={itemizedGross} commission={itemizedCommission} pct={commissionPct} k={k} />}

          <label className="flex items-center gap-2 text-sm text-neutral-300">
            <input type="checkbox" className="w-4 h-4 accent-brand-600" checked={deductInventory}
                   onChange={(e) => setDeductInventory(e.target.checked)} />
            {k('deductInventory', 'Deduct ingredients from inventory')}
          </label>

          <NoteField value={note} onChange={setNote} labelCls={labelCls} inputCls={inputCls} k={k} />
          <button disabled={!canSubmitItemized || busy} onClick={submitItemized}
                  className="min-h-[40px] px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium text-sm">
            {busy ? k('saving', 'Saving…') : k('recordOrder', 'Record order')}
          </button>
        </div>
      )}

      {/* ===== Import ===== */}
      {mode === 'import' && (
        <div className="space-y-4">
          <div>
            <label className={labelCls} htmlFor="ms-file">{k('file', 'Sales export from the platform portal')}</label>
            <input
              id="ms-file" ref={fileInput} type="file" accept=".csv,.tsv,.txt,.xlsx,.xls"
              className="block w-full text-sm text-neutral-300 file:mr-3 file:min-h-[40px] file:px-4 file:rounded-lg file:border-0 file:bg-brand-600 file:text-white hover:file:bg-brand-500"
              onChange={(e) => {
                const f = e.target.files?.[0] || null;
                setFile(f); setPreview(null);
                if (f) void runPreview(f);
              }}
            />
            <p className="mt-1.5 text-xs text-neutral-500">
              {k('fileHint', 'Rappi: Financiero → Relación de ventas. DiDi: Finanzas → Detalle de pagos. CSV works everywhere; if an .xlsx is rejected, export it as CSV first.')}
            </p>
          </div>

          {preview && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <Stat label={k('rowsFound', 'Rows read')} value={String(preview.row_count)} />
                <Stat label={k('willImport', 'Will import')} value={String(preview.importable_count)} highlight />
                <Stat label={k('grossLabel', 'Gross')} value={formatPrice(preview.totals.gross)} />
                <Stat label={k('commissionLabel', 'Commission')} value={formatPrice(preview.totals.commission)} />
              </div>

              {preview.date_range && (
                <p className="text-xs text-neutral-500">
                  {k('dateRange', 'Covers {{from}} → {{to}}', { from: preview.date_range.from, to: preview.date_range.to })}
                </p>
              )}

              {/* Column mapping — detection is a guess; let the user correct it. */}
              <div>
                <p className={labelCls}>{k('mapping', 'Which column is which')}</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {(['external_order_id', 'business_date', 'gross', 'commission', 'net'] as const).map((field) => (
                    <div key={field} className="flex items-center gap-2">
                      <span className="w-28 shrink-0 text-xs text-neutral-400">
                        {k(`field_${field}`, field.replace(/_/g, ' '))}
                      </span>
                      <select
                        className={inputCls}
                        value={preview.mapping[field] ?? ''}
                        onChange={(e) => {
                          const next = { ...preview.mapping, [field]: e.target.value || null };
                          if (file) void runPreview(file, next);
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

              {preview.sample.length > 0 && (
                <div className="overflow-x-auto rounded-lg border border-neutral-800">
                  <table className="w-full text-xs">
                    <thead className="bg-neutral-900 text-neutral-400">
                      <tr>
                        <th className="text-left px-3 py-2">{k('field_external_order_id', 'Order id')}</th>
                        <th className="text-left px-3 py-2">{k('field_business_date', 'Date')}</th>
                        <th className="text-right px-3 py-2">{k('field_gross', 'Gross')}</th>
                        <th className="text-right px-3 py-2">{k('field_commission', 'Commission')}</th>
                      </tr>
                    </thead>
                    <tbody className="text-neutral-300">
                      {preview.sample.map((r, i) => (
                        <tr key={`${r.external_order_id ?? 'row'}-${i}`} className="border-t border-neutral-800">
                          <td className="px-3 py-1.5">{r.external_order_id ?? '—'}</td>
                          <td className="px-3 py-1.5">{r.business_date}</td>
                          <td className="px-3 py-1.5 text-right">{formatPrice(r.gross)}</td>
                          <td className="px-3 py-1.5 text-right">{r.commission != null ? formatPrice(r.commission) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <NoteField value={note} onChange={setNote} labelCls={labelCls} inputCls={inputCls} k={k} />
              <button disabled={busy || preview.importable_count === 0} onClick={submitImport}
                      className="min-h-[40px] px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium text-sm flex items-center gap-2">
                <Upload size={15} />
                {busy ? k('importing', 'Importing…') : k('importN', 'Import {{count}} orders', { count: preview.importable_count })}
              </button>
            </div>
          )}
        </div>
      )}

      {/* ===== Recent entries ===== */}
      <div>
        <h3 className="text-sm font-semibold text-neutral-200 mb-2">{k('recent', 'Recent manual entries')}</h3>
        {batches.length === 0 ? (
          <p className="text-sm text-neutral-500">{k('noBatches', 'Nothing recorded manually yet.')}</p>
        ) : (
          <div className="space-y-2">
            {batches.map((b) => (
              <div key={b.id} className="flex items-center justify-between gap-3 p-3 rounded-lg bg-neutral-900 border border-neutral-800">
                <div className="min-w-0">
                  <p className="text-sm text-neutral-100 truncate">
                    <span className="font-medium">{b.platform_display_name || b.channel}</span>
                    <span className="text-neutral-500"> · {b.business_date} · </span>
                    {k('nOrders', '{{count}} orders', { count: b.live_order_count })}
                    <span className="text-neutral-500"> · </span>
                    {formatPrice(Number(b.gross_total))}
                  </p>
                  <p className="text-xs text-neutral-500 truncate">
                    {k(`mode_${b.entry_mode}`, b.entry_mode)}
                    {b.source_filename ? ` · ${b.source_filename}` : ''}
                    {b.created_by_name ? ` · ${b.created_by_name}` : ''}
                    {` · ${k('netShort', 'net')} ${formatPrice(Number(b.net_total))}`}
                  </p>
                </div>
                <button type="button" disabled={busy} onClick={() => undoBatch(b)}
                        aria-label={k('undo', 'Undo entry')}
                        className="min-h-[40px] px-3 rounded-lg bg-neutral-800 text-red-300 hover:bg-red-950 disabled:opacity-40 text-xs flex items-center gap-1.5 shrink-0">
                  <RotateCcw size={13} />{k('undo', 'Undo')}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SummaryRow({ gross, commission, pct, k }: {
  gross: number; commission: number; pct: number;
  k: (key: string, fallback: string, opts?: Record<string, unknown>) => string;
}) {
  return (
    <div className="grid grid-cols-3 gap-2">
      <Stat label={k('grossLabel', 'Gross')} value={formatPrice(gross)} />
      <Stat label={k('commissionAt', 'Commission ({{pct}}%)', { pct })} value={`- ${formatPrice(commission)}`} />
      <Stat label={k('netLabel', 'Net')} value={formatPrice(gross - commission)} highlight />
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className={`p-3 rounded-lg border ${highlight ? 'bg-brand-950/40 border-brand-800' : 'bg-neutral-900 border-neutral-800'}`}>
      <p className="text-xs text-neutral-400">{label}</p>
      <p className={`text-sm font-semibold ${highlight ? 'text-brand-300' : 'text-neutral-100'}`}>{value}</p>
    </div>
  );
}

function NoteField({ value, onChange, labelCls, inputCls, k }: {
  value: string; onChange: (v: string) => void; labelCls: string; inputCls: string;
  k: (key: string, fallback: string) => string;
}) {
  return (
    <div>
      <label className={labelCls} htmlFor="ms-note">{k('note', 'Note (optional)')}</label>
      <input id="ms-note" className={inputCls} value={value} maxLength={200}
             onChange={(e) => onChange(e.target.value)}
             placeholder={k('notePlaceholder', 'e.g. week 29 settlement')} />
    </div>
  );
}
