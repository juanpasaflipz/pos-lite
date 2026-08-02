import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Camera, Loader2, Check, X, AlertTriangle, PackagePlus, RotateCcw, CircleCheck, Search,
} from 'lucide-react';
import MobileHeader from '../../components/mobile/MobileHeader';
import { successFeedback, errorFeedback, tapFeedback } from '../../lib/haptics';
import {
  scanInventoryPhoto,
  confirmInventoryScan,
  cancelInventoryScan,
  searchInventory,
  type InventorySearchResult,
  type InventoryScanDraft,
  type InventoryScanItem,
  type InventoryScanOverride,
  type InventoryScanResult,
} from '../../api';

/**
 * Photo → inventory, on the phone that's already in the operator's hand.
 *
 * The same Claude vision engine as the WhatsApp path, minus WhatsApp. One
 * capture handles both cases the model classifies: a supplier receipt
 * (record_purchase) or a shelf/fridge photo (count_inventory).
 *
 * The review step is the reason this exists as a screen rather than a chat
 * handshake — the operator can fix a miscounted quantity or drop a bad line
 * before anything touches inventory, instead of retaking the whole photo.
 */

type Step = 'capture' | 'parsing' | 'review' | 'saving' | 'done';

/** Local per-line edit state, keyed by the draft's item index. */
interface LineEdit {
  include: boolean;
  quantity: string;
  lineTotal: string;
  create: boolean;
  /** SKU the operator re-pointed this line at, replacing a bad fuzzy match. */
  boundId: number | null;
  boundName: string | null;
  /** A corrected name, only ever sent alongside create. */
  renameTo: string;
}

const fmtMoney = (n: number) =>
  Number(n).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const MobilePhotoScanScreen: React.FC = () => {
  const { t } = useTranslation('pos');
  const fileRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<Step>('capture');
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [draftId, setDraftId] = useState<number | null>(null);
  const [draft, setDraft] = useState<InventoryScanDraft | null>(null);
  const [edits, setEdits] = useState<Record<number, LineEdit>>({});
  const [totalEdit, setTotalEdit] = useState('');
  const [result, setResult] = useState<InventoryScanResult | null>(null);

  const isCount = draft?.intent === 'count_inventory';

  const reset = useCallback(() => {
    if (preview) URL.revokeObjectURL(preview);
    setStep('capture');
    setError(null);
    setPreview(null);
    setDraftId(null);
    setDraft(null);
    setEdits({});
    setTotalEdit('');
    setResult(null);
    if (fileRef.current) fileRef.current.value = '';
  }, [preview]);

  const handleFile = useCallback(async (file: File) => {
    setError(null);
    setStep('parsing');
    setPreview(URL.createObjectURL(file));
    try {
      const res = await scanInventoryPhoto(file);
      if (!res.id || res.draft.intent === 'unknown') {
        // Neither a receipt nor a countable shelf. Surface the model's own
        // Spanish question rather than a generic failure — it tells the
        // operator what to photograph instead.
        errorFeedback();
        setError(res.draft.clarifying_question || t('photoScan.notRecognized'));
        setStep('capture');
        return;
      }
      setDraftId(res.id);
      setDraft(res.draft);
      setEdits(
        Object.fromEntries(
          res.draft.items.map((it) => [
            it.index,
            {
              // An unmatched count line is excluded by default — the server
              // drops it anyway unless promoted, so defaulting it on would
              // show a line that silently vanishes on save.
              include: !it.unmatched,
              quantity: it.quantity != null ? String(it.quantity) : '',
              lineTotal: it.line_total != null ? String(it.line_total) : '',
              create: false,
              boundId: null,
              boundName: null,
              renameTo: '',
            } as LineEdit,
          ])
        )
      );
      // Seed the total from whatever the model read. When it read nothing, the
      // field opens blank with the line sum as its placeholder — the server will
      // use that sum if the operator leaves it alone, so the placeholder is a
      // real preview of what gets booked, not a hint.
      setTotalEdit(res.draft.total_amount != null ? String(res.draft.total_amount) : '');
      successFeedback();
      setStep('review');
    } catch (err) {
      errorFeedback();
      const e = err as Error & { status?: number };
      setError(e.status === 502 ? t('photoScan.visionFailed') : e.message || t('photoScan.failed'));
      setStep('capture');
    }
  }, [t]);

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  };

  const setEdit = (index: number, patch: Partial<LineEdit>) => {
    setEdits((prev) => ({ ...prev, [index]: { ...prev[index], ...patch } }));
  };

  const includedCount = useMemo(
    () => Object.values(edits).filter((e) => e.include).length,
    [edits]
  );

  // Mirrors the server's fallback (resolvePurchaseTotal) so the placeholder
  // shows the figure that will actually be booked if the operator types nothing.
  const lineSum = useMemo(
    () =>
      Object.values(edits).reduce((acc, e) => {
        if (!e.include) return acc;
        const lt = Number(e.lineTotal);
        return Number.isFinite(lt) && lt > 0 ? acc + lt : acc;
      }, 0),
    [edits]
  );

  const handleConfirm = async () => {
    if (!draftId || !draft) return;
    setStep('saving');
    setError(null);
    try {
      const overrides: InventoryScanOverride[] = draft.items.map((it) => {
        const e = edits[it.index];
        const o: InventoryScanOverride = { index: it.index, include: e.include };
        const q = Number(e.quantity);
        if (e.quantity !== '' && Number.isFinite(q)) o.quantity = q;
        const lt = Number(e.lineTotal);
        if (e.lineTotal !== '' && Number.isFinite(lt)) o.line_total = lt;
        if (e.create) o.create = true;
        if (e.boundId != null) o.bind_inventory_item_id = e.boundId;
        // The server only honors a name with create, so don't imply otherwise.
        if (e.create && e.renameTo.trim()) o.name = e.renameTo.trim();
        return o;
      });
      // Only send a total the operator actually typed. Omitting it leaves the
      // draft's own value in charge, and the server derives one from the lines
      // when the draft has none.
      const typedTotal = Number(totalEdit);
      const res = await confirmInventoryScan(
        draftId,
        overrides,
        !isCount && totalEdit.trim() !== '' && Number.isFinite(typedTotal) && typedTotal > 0
          ? { total_amount: typedTotal }
          : undefined
      );
      successFeedback();
      setResult(res);
      setStep('done');
    } catch (err) {
      errorFeedback();
      setError(err instanceof Error ? err.message : t('photoScan.failed'));
      setStep('review');
    }
  };

  const handleDiscard = async () => {
    tapFeedback();
    if (draftId) await cancelInventoryScan(draftId).catch(() => {});
    reset();
  };

  // ---- Capture ------------------------------------------------------------
  if (step === 'capture' || step === 'parsing') {
    const busy = step === 'parsing';
    return (
      <div className="flex flex-col h-full bg-neutral-950">
        <MobileHeader title={t('photoScan.title')} showBack backTo="/m/scan" />
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {error && (
            <div className="bg-amber-900/30 border border-amber-800 rounded-xl p-4 flex gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
              <p className="text-amber-200 text-sm leading-relaxed">{error}</p>
            </div>
          )}

          <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
            <h2 className="text-white font-bold mb-2">{t('photoScan.whatToShoot')}</h2>
            <ul className="text-neutral-400 text-sm space-y-1.5 leading-relaxed">
              <li>• {t('photoScan.hintReceipt')}</li>
              <li>• {t('photoScan.hintShelf')}</li>
            </ul>
          </div>

          {busy && preview && (
            <div className="relative rounded-xl overflow-hidden border border-neutral-800">
              <img src={preview} alt="" className="w-full max-h-64 object-cover opacity-40" />
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
                <Loader2 className="w-8 h-8 text-brand-400 animate-spin" />
                <p className="text-white text-sm font-medium">{t('photoScan.reading')}</p>
              </div>
            </div>
          )}
        </div>

        <div className="p-4 border-t border-neutral-800 bg-neutral-900" style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            capture="environment"
            onChange={onPick}
            className="hidden"
          />
          <button
            onClick={() => { tapFeedback(); fileRef.current?.click(); }}
            disabled={busy}
            className="w-full min-h-[56px] bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white rounded-xl font-bold text-lg flex items-center justify-center gap-3 transition-colors touch-manipulation"
          >
            {busy
              ? <><Loader2 className="w-6 h-6 animate-spin" /> {t('photoScan.reading')}</>
              : <><Camera className="w-6 h-6" /> {t('photoScan.takePhoto')}</>}
          </button>
        </div>
      </div>
    );
  }

  // ---- Done ---------------------------------------------------------------
  if (step === 'done' && result) {
    return (
      <div className="flex flex-col h-full bg-neutral-950">
        <MobileHeader title={t('photoScan.title')} />
        <div className="flex-1 overflow-y-auto p-4 flex flex-col items-center justify-center text-center gap-4">
          <div className="w-16 h-16 rounded-full bg-green-600/20 flex items-center justify-center">
            <CircleCheck className="w-9 h-9 text-green-400" />
          </div>
          <p className="text-white text-lg font-bold leading-relaxed px-4">{result.message}</p>
          {result.created_skus.length > 0 && (
            <p className="text-neutral-400 text-sm">
              {t('photoScan.createdSkus', { count: result.created_skus.length })}
            </p>
          )}
        </div>
        <div className="p-4 border-t border-neutral-800 bg-neutral-900" style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}>
          <button
            onClick={reset}
            className="w-full min-h-[56px] bg-brand-600 hover:bg-brand-700 text-white rounded-xl font-bold flex items-center justify-center gap-2 touch-manipulation"
          >
            <Camera className="w-5 h-5" /> {t('photoScan.scanAnother')}
          </button>
        </div>
      </div>
    );
  }

  // ---- Review -------------------------------------------------------------
  const saving = step === 'saving';
  return (
    <div className="flex flex-col h-full bg-neutral-950">
      <MobileHeader
        title={isCount ? t('photoScan.reviewCount') : t('photoScan.reviewPurchase')}
        rightAction={
          <button onClick={handleDiscard} disabled={saving} className="p-2 text-neutral-400 hover:text-white disabled:opacity-50">
            <X className="w-5 h-5" />
          </button>
        }
      />

      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {error && (
          <div className="bg-brand-900/30 border border-brand-800 rounded-xl p-4">
            <p className="text-brand-200 text-sm">{error}</p>
          </div>
        )}

        {/* Purchase header: vendor + total, the two things worth eyeballing
            before the line items. The total is editable because it is the field
            the camera most often loses — a shadow over the bottom of the ticket
            used to make the whole scan unsaveable with no way to fix it. */}
        {!isCount && (
          <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-neutral-300 font-medium">{draft?.vendor || t('photoScan.noVendor')}</span>
            </div>
            <label className="flex items-center justify-between gap-3">
              <span className="text-neutral-400 text-sm shrink-0">{t('photoScan.total')}</span>
              <div className="flex items-center gap-1.5">
                <span className="text-neutral-500 font-bold">$</span>
                <input
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="0"
                  value={totalEdit}
                  onChange={(e) => setTotalEdit(e.target.value)}
                  disabled={saving}
                  placeholder={lineSum > 0 ? fmtMoney(lineSum) : '0.00'}
                  className="w-32 min-h-[40px] bg-neutral-800 border border-neutral-700 rounded-lg px-3 text-right text-white font-bold disabled:opacity-50 focus:border-brand-500 focus:outline-none"
                />
              </div>
            </label>
            {draft?.total_amount == null && (
              <p className="text-amber-300/80 text-xs leading-relaxed">
                {lineSum > 0
                  ? t('photoScan.totalUnreadable', { amount: `$${fmtMoney(lineSum)}` })
                  : t('photoScan.totalRequired')}
              </p>
            )}
          </div>
        )}

        {draft?.note && (
          <p className="text-neutral-500 text-xs leading-relaxed px-1">{draft.note}</p>
        )}

        {draft?.items.map((it) => (
          <LineRow
            key={it.index}
            item={it}
            edit={edits[it.index]}
            isCount={isCount}
            disabled={saving}
            onChange={(patch) => setEdit(it.index, patch)}
            t={t}
          />
        ))}

        {draft?.items.length === 0 && (
          <p className="text-neutral-500 text-sm text-center py-8">{t('photoScan.noItems')}</p>
        )}
      </div>

      <div className="p-4 border-t border-neutral-800 bg-neutral-900 space-y-2" style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}>
        <button
          onClick={handleConfirm}
          disabled={saving || includedCount === 0}
          className="w-full min-h-[56px] bg-brand-600 hover:bg-brand-700 disabled:opacity-40 text-white rounded-xl font-bold text-lg flex items-center justify-center gap-3 transition-colors touch-manipulation"
        >
          {saving
            ? <><Loader2 className="w-6 h-6 animate-spin" /> {t('photoScan.saving')}</>
            : <><Check className="w-6 h-6" /> {t('photoScan.save', { count: includedCount })}</>}
        </button>
        <button
          onClick={handleDiscard}
          disabled={saving}
          className="w-full min-h-[44px] text-neutral-400 hover:text-white disabled:opacity-50 rounded-xl font-medium flex items-center justify-center gap-2 touch-manipulation"
        >
          <RotateCcw className="w-4 h-4" /> {t('photoScan.retake')}
        </button>
      </div>
    </div>
  );
};

interface LineRowProps {
  item: InventoryScanItem;
  edit: LineEdit;
  isCount: boolean;
  disabled: boolean;
  onChange: (patch: Partial<LineEdit>) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}

const LineRow: React.FC<LineRowProps> = ({ item, edit, isCount, disabled, onChange, t }) => {
  const [picking, setPicking] = useState(false);
  const [renaming, setRenaming] = useState(false);

  if (!edit) return null;
  const dimmed = !edit.include;
  const rebound = edit.boundId != null;
  const effectiveBoundName = edit.boundName ?? item.matched_name;

  return (
    <div className={`bg-neutral-900 border rounded-xl p-4 transition-opacity ${dimmed ? 'opacity-40 border-neutral-800' : 'border-neutral-700'}`}>
      <div className="flex items-start gap-3">
        <button
          onClick={() => { tapFeedback(); onChange({ include: !edit.include }); }}
          disabled={disabled}
          className={`mt-0.5 w-6 h-6 shrink-0 rounded-md border-2 flex items-center justify-center touch-manipulation ${
            edit.include ? 'bg-brand-600 border-brand-600' : 'border-neutral-600'
          }`}
          aria-label={edit.include ? t('photoScan.exclude') : t('photoScan.include')}
        >
          {edit.include && <Check className="w-4 h-4 text-white" />}
        </button>

        <div className="flex-1 min-w-0">
          <p className="text-white font-semibold truncate">{item.raw_name || t('photoScan.unnamed')}</p>

          {/* What this line will actually restock. The model's transcription and
              the SKU it bound to are different things, and only the second one
              moves stock — a handwritten "mango" read as "maíz" is invisible
              until you show it. */}
          {(edit.create || rebound ||
            (effectiveBoundName && effectiveBoundName.toLowerCase() !== item.raw_name.trim().toLowerCase())) && (
            <p className="text-xs mt-0.5 truncate">
              <span className="text-neutral-500">{t('photoScan.willUpdate')} </span>
              {edit.create ? (
                <span className="text-blue-300 font-medium">
                  {(edit.renameTo.trim() || item.raw_name || t('photoScan.unnamed')) + ' · ' + t('photoScan.tagNew')}
                </span>
              ) : (
                <span className={rebound ? 'text-green-300 font-medium' : 'text-neutral-300 font-medium'}>
                  {effectiveBoundName}
                </span>
              )}
            </p>
          )}

          <div className="flex flex-wrap gap-1.5 mt-1">
            {item.will_create && (
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-blue-900/40 text-blue-300 border border-blue-800">
                {t('photoScan.tagNew')}
              </span>
            )}
            {item.fuzzy_matched && (
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-neutral-800 text-neutral-400 border border-neutral-700">
                {t('photoScan.tagFuzzy')}
              </span>
            )}
            {item.unmatched && (
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-900/40 text-amber-300 border border-amber-800">
                {t('photoScan.tagUnmatched')}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2 mt-3">
            <div className="flex-1">
              <label className="block text-[11px] text-neutral-500 mb-1">
                {isCount ? t('photoScan.counted') : t('photoScan.quantity')}
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  inputMode="decimal"
                  step="any"
                  min="0"
                  value={edit.quantity}
                  onChange={(e) => onChange({ quantity: e.target.value })}
                  disabled={disabled || !edit.include}
                  className="w-full min-h-[44px] px-3 bg-neutral-800 border border-neutral-700 rounded-lg text-white text-lg font-semibold focus:outline-none focus:border-brand-600 disabled:opacity-50"
                />
                {item.unit && <span className="text-neutral-400 text-sm shrink-0">{item.unit}</span>}
              </div>
            </div>

            {!isCount && (
              <div className="flex-1">
                <label className="block text-[11px] text-neutral-500 mb-1">{t('photoScan.lineTotal')}</label>
                <input
                  type="number"
                  inputMode="decimal"
                  step="any"
                  min="0"
                  value={edit.lineTotal}
                  onChange={(e) => onChange({ lineTotal: e.target.value })}
                  disabled={disabled || !edit.include}
                  className="w-full min-h-[44px] px-3 bg-neutral-800 border border-neutral-700 rounded-lg text-white text-lg font-semibold focus:outline-none focus:border-brand-600 disabled:opacity-50"
                />
              </div>
            )}
          </div>

          {/* The two ways a misread gets corrected: point the line at the SKU it
              should have matched, or name a SKU that doesn't exist yet. */}
          {edit.include && !edit.create && (
            <div className="flex gap-2 mt-3">
              <button
                onClick={() => { tapFeedback(); setPicking((v) => !v); setRenaming(false); }}
                disabled={disabled}
                className={`flex-1 min-h-[40px] rounded-lg text-xs font-medium flex items-center justify-center gap-1.5 border touch-manipulation ${
                  picking ? 'bg-brand-600/20 border-brand-700 text-brand-200' : 'bg-neutral-800 border-neutral-700 text-neutral-300'
                }`}
              >
                <Search className="w-3.5 h-3.5" /> {t('photoScan.changeItem')}
              </button>
              <button
                onClick={() => { tapFeedback(); setRenaming((v) => !v); setPicking(false); }}
                disabled={disabled}
                className="flex-1 min-h-[40px] rounded-lg text-xs font-medium flex items-center justify-center gap-1.5 border bg-neutral-800 border-neutral-700 text-neutral-300 touch-manipulation"
              >
                <PackagePlus className="w-3.5 h-3.5" /> {t('photoScan.renameCreate')}
              </button>
            </div>
          )}

          {picking && edit.include && (
            <InventoryPicker
              disabled={disabled}
              onPick={(hit) => {
                onChange({ boundId: hit.id, boundName: hit.name, create: false, renameTo: '' });
                setPicking(false);
                successFeedback();
              }}
              t={t}
            />
          )}

          {rebound && !picking && (
            <button
              onClick={() => { tapFeedback(); onChange({ boundId: null, boundName: null }); }}
              disabled={disabled}
              className="mt-2 text-xs text-neutral-500 hover:text-neutral-300 underline touch-manipulation min-h-[40px]"
            >
              {t('photoScan.undoChange')}
            </button>
          )}

          {renaming && edit.include && (
            <div className="mt-2 space-y-2">
              <input
                type="text"
                autoFocus
                value={edit.renameTo}
                onChange={(e) => onChange({ renameTo: e.target.value })}
                placeholder={item.raw_name || t('photoScan.unnamed')}
                disabled={disabled}
                className="w-full min-h-[44px] px-3 bg-neutral-800 border border-neutral-700 rounded-lg text-white focus:outline-none focus:border-brand-600 disabled:opacity-50"
              />
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    tapFeedback();
                    onChange({ create: true, boundId: null, boundName: null });
                    setRenaming(false);
                  }}
                  disabled={disabled || !edit.renameTo.trim()}
                  className="flex-1 min-h-[44px] rounded-lg text-sm font-medium bg-blue-600/20 border border-blue-700 text-blue-300 disabled:opacity-40 touch-manipulation"
                >
                  {t('photoScan.confirmCreate')}
                </button>
                <button
                  onClick={() => { tapFeedback(); onChange({ renameTo: '' }); setRenaming(false); }}
                  disabled={disabled}
                  className="min-h-[44px] px-4 rounded-lg text-sm text-neutral-400 border border-neutral-700 touch-manipulation"
                >
                  {t('photoScan.cancel')}
                </button>
              </div>
            </div>
          )}

          {/* Creating a new SKU is reversible right up to save. */}
          {edit.create && !item.unmatched && (
            <button
              onClick={() => { tapFeedback(); onChange({ create: false, renameTo: '' }); }}
              disabled={disabled}
              className="mt-2 text-xs text-neutral-500 hover:text-neutral-300 underline touch-manipulation min-h-[40px]"
            >
              {t('photoScan.undoChange')}
            </button>
          )}

          {/* An unmatched count line does nothing on save unless the operator
              says "yes, create this SKU" — the in-app AGREGAR. */}
          {item.unmatched && edit.include && (
            <button
              onClick={() => { tapFeedback(); onChange({ create: !edit.create }); }}
              disabled={disabled}
              className={`mt-3 w-full min-h-[44px] rounded-lg font-medium text-sm flex items-center justify-center gap-2 border touch-manipulation ${
                edit.create
                  ? 'bg-blue-600/20 border-blue-700 text-blue-300'
                  : 'bg-neutral-800 border-neutral-700 text-neutral-400'
              }`}
            >
              <PackagePlus className="w-4 h-4" />
              {edit.create ? t('photoScan.willCreate') : t('photoScan.createSku')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

interface InventoryPickerProps {
  disabled: boolean;
  onPick: (hit: InventorySearchResult) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}

/**
 * Search the tenant's own inventory and re-point a line at the right SKU.
 *
 * Deliberately shows current stock and unit next to each hit: with names like
 * "Queso Oaxaca La Piramide" vs "Queso Oaxaca", the number on hand is often the
 * only way to tell which row is the one actually in use.
 */
const InventoryPicker: React.FC<InventoryPickerProps> = ({ disabled, onPick, t }) => {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<InventorySearchResult[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setHits([]); return; }
    // Debounced so a thumb typing "mango" fires one request, not five.
    let cancelled = false;
    setBusy(true);
    const timer = setTimeout(async () => {
      try {
        const res = await searchInventory(term);
        if (!cancelled) setHits(res);
      } catch {
        if (!cancelled) setHits([]);
      } finally {
        if (!cancelled) setBusy(false);
      }
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); setBusy(false); };
  }, [q]);

  return (
    <div className="mt-2 space-y-2">
      <div className="relative">
        <Search className="w-4 h-4 text-neutral-500 absolute left-3 top-1/2 -translate-y-1/2" />
        <input
          type="text"
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('photoScan.searchInventory')}
          disabled={disabled}
          className="w-full min-h-[44px] pl-9 pr-3 bg-neutral-800 border border-neutral-700 rounded-lg text-white focus:outline-none focus:border-brand-600 disabled:opacity-50"
        />
        {busy && <Loader2 className="w-4 h-4 text-neutral-500 animate-spin absolute right-3 top-1/2 -translate-y-1/2" />}
      </div>

      {hits.map((hit) => (
        <button
          key={hit.id}
          onClick={() => onPick(hit)}
          disabled={disabled}
          className="w-full min-h-[44px] px-3 py-2 rounded-lg bg-neutral-800 border border-neutral-700 hover:border-brand-600 flex items-center justify-between gap-3 text-left touch-manipulation"
        >
          <span className="text-white text-sm truncate">{hit.name}</span>
          <span className="text-neutral-500 text-xs shrink-0">
            {Number(hit.quantity)} {hit.unit}
          </span>
        </button>
      ))}

      {q.trim().length >= 2 && !busy && hits.length === 0 && (
        <p className="text-neutral-500 text-xs px-1">{t('photoScan.noMatches')}</p>
      )}
    </div>
  );
};

export default MobilePhotoScanScreen;
