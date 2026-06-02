import React, { useEffect, useState } from 'react';
import { Check, Loader2, Minus, Pencil, Plus, RotateCcw, Tag, Trash2, X } from 'lucide-react';
import {
  appendOrderItems,
  applyOrderDiscount,
  deleteOrder,
  getOrder,
  updateOrderItemQuantity,
  voidOrderItem,
} from '../../api';
import type { Discount, Order, OrderItem } from '../../types';
import { formatPrice } from '../../utils/currency';
import DiscountModal from './DiscountModal';
import ManagerApprovalModal, { type ManagerApprovalResult } from './ManagerApprovalModal';
import OrderEditMenuPicker, { type PickerLine } from './OrderEditMenuPicker';
import VoidReasonModal from './VoidReasonModal';

interface OrderEditModalProps {
  isOpen: boolean;
  order: Order | null;
  onClose: () => void;
  /** Called after any successful mutation so the parent panel re-fetches. */
  onChanged: () => void;
  /** Paid orders only. Opens the refund modal owned by the POS screen. */
  onRefund?: (orderId: number) => void;
}

type RetryFn = (approverId: number) => Promise<void>;

interface VoidPick {
  itemId: number;
  itemName: string;
}

const OrderEditModal: React.FC<OrderEditModalProps> = ({ isOpen, order, onClose, onChanged, onRefund }) => {
  const [items, setItems] = useState<OrderItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyItemId, setBusyItemId] = useState<number | null>(null);
  const [addingItems, setAddingItems] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingRetry, setPendingRetry] = useState<RetryFn | null>(null);
  const [voidingPick, setVoidingPick] = useState<VoidPick | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showDiscount, setShowDiscount] = useState(false);
  const [currentDiscount, setCurrentDiscount] = useState<Discount | null>(null);
  const [currentDiscountAmount, setCurrentDiscountAmount] = useState(0);

  // Re-fetch the order whenever it opens, so we render the freshest items
  // (the parent panel's snapshot can be up to 8s stale).
  useEffect(() => {
    if (!isOpen || !order) return;
    let mounted = true;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const fresh = await getOrder(order.id);
        if (!mounted) return;
        setItems(fresh.items || []);
        if (fresh.discount_type && fresh.discount_amount && Number(fresh.discount_amount) > 0) {
          setCurrentDiscount({
            type: fresh.discount_type,
            // For percent/amount we store the resolved $ in discount_amount.
            // We don't have the original % value, so display value = amount.
            value: Number(fresh.discount_amount),
            reason: fresh.discount_reason || '',
            authorized_by_employee_id: fresh.discount_authorized_by || undefined,
          });
          setCurrentDiscountAmount(Number(fresh.discount_amount));
        } else {
          setCurrentDiscount(null);
          setCurrentDiscountAmount(0);
        }
      } catch (err) {
        if (mounted) setError(err instanceof Error ? err.message : 'No se pudo cargar la orden');
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, [isOpen, order]);

  if (!isOpen || !order) return null;

  const refreshItems = async () => {
    try {
      const fresh = await getOrder(order.id);
      setItems(fresh.items || []);
      if (fresh.discount_type && fresh.discount_amount && Number(fresh.discount_amount) > 0) {
        setCurrentDiscount({
          type: fresh.discount_type,
          value: Number(fresh.discount_amount),
          reason: fresh.discount_reason || '',
          authorized_by_employee_id: fresh.discount_authorized_by || undefined,
        });
        setCurrentDiscountAmount(Number(fresh.discount_amount));
      } else {
        setCurrentDiscount(null);
        setCurrentDiscountAmount(0);
      }
    } catch {
      // Non-blocking — the parent panel poll will reconcile.
    }
    onChanged();
  };

  // Wraps a mutation so we can retry it with a manager-approver id when the
  // backend returns 403 ("Manager approval required to edit a paid order").
  // PIN is NOT cached; each subsequent paid-order edit re-prompts.
  const callWithMaybeApproval = async (
    runner: (approverId?: number) => Promise<unknown>,
  ): Promise<boolean> => {
    setError(null);
    try {
      await runner(undefined);
      return true;
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 403) {
        // Queue the retry so ManagerApprovalModal's onApproved can call it.
        setPendingRetry(() => async (approverId: number) => {
          try {
            await runner(approverId);
            setPendingRetry(null);
            await refreshItems();
          } catch (retryErr) {
            setError(retryErr instanceof Error ? retryErr.message : 'Falló después de aprobación');
            setPendingRetry(null);
          }
        });
        return false;
      }
      setError(err instanceof Error ? err.message : 'No se pudo aplicar el cambio');
      return false;
    }
  };

  const handleQtyChange = async (item: OrderItem, delta: number) => {
    if (busyItemId != null || item.id == null) return;
    const newQty = (item.quantity || 0) + delta;
    if (newQty <= 0) {
      // Backend blocks voiding the last live item — for a single-qty item, the
      // user should void it explicitly (which carries an audit reason).
      setError('Para quitar este producto, usa el botón de cancelar.');
      return;
    }
    setBusyItemId(item.id);
    const ok = await callWithMaybeApproval((approverId) =>
      updateOrderItemQuantity(order.id, item.id!, newQty,
        approverId ? { authorized_by_employee_id: approverId } : undefined)
    );
    setBusyItemId(null);
    if (ok) await refreshItems();
  };

  const handleVoidConfirmed = async (reason: string) => {
    const pick = voidingPick;
    setVoidingPick(null);
    if (!pick) return;
    setBusyItemId(pick.itemId);
    const ok = await callWithMaybeApproval((approverId) =>
      voidOrderItem(order.id, pick.itemId, reason,
        approverId ? { authorized_by_employee_id: approverId } : undefined)
    );
    setBusyItemId(null);
    if (ok) await refreshItems();
  };

  const handleAddConfirmed = async (lines: PickerLine[]) => {
    setShowPicker(false);
    if (lines.length === 0) return;
    setAddingItems(true);
    const payload = lines.map((l) => ({
      menu_item_id: l.menu_item_id,
      quantity: l.quantity,
      modifiers: l.modifier_ids,
      notes: l.notes,
    }));
    const ok = await callWithMaybeApproval((approverId) =>
      appendOrderItems(order.id, payload,
        approverId ? { authorized_by_employee_id: approverId } : undefined)
    );
    setAddingItems(false);
    if (ok) await refreshItems();
  };

  const onManagerApproved = (result: ManagerApprovalResult) => {
    if (pendingRetry) pendingRetry(result.employee_id);
  };

  const handleConfirmDelete = async () => {
    if (!order || deleting) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteOrder(order.id);
      setShowDeleteConfirm(false);
      onChanged();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo cancelar la orden');
    } finally {
      setDeleting(false);
    }
  };

  const handleDiscountSave = async (next: Discount | null) => {
    setShowDiscount(false);
    setError(null);
    // DiscountModal returns the manager-approval result baked into the
    // Discount payload itself — the server's 403 path is rare, but
    // callWithMaybeApproval handles it just like the qty/void edits.
    await callWithMaybeApproval((approverId) =>
      applyOrderDiscount(order.id, next, {
        authorized_by_employee_id:
          approverId ?? next?.authorized_by_employee_id,
      })
    );
    await refreshItems();
  };

  const liveItems = items.filter((it) => !it.voided_at);
  const voidedItems = items.filter((it) => it.voided_at);
  const total = liveItems.reduce(
    (sum, it) => sum + Number(it.unit_price || 0) * (it.quantity || 0),
    0
  );

  return (
    <>
      <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
        <div className="bg-neutral-950 rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] border border-neutral-800 flex flex-col">
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-neutral-800 bg-neutral-900 rounded-t-2xl">
            <div className="flex items-center gap-3 min-w-0">
              <Pencil className="w-5 h-5 text-brand-400 shrink-0" />
              <div className="min-w-0">
                <h2 className="text-lg font-black text-white truncate">
                  Editar #{order.order_number}
                </h2>
                <p className="text-xs text-neutral-400 font-bold">
                  {order.payment_status === 'paid' ? 'Pagada — requiere aprobación' : 'No pagada'}
                </p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="h-12 w-12 rounded-lg bg-neutral-800 hover:bg-neutral-700 flex items-center justify-center"
              aria-label="Cerrar"
            >
              <X className="w-6 h-6 text-white" />
            </button>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-8 h-8 text-brand-500 animate-spin" />
              </div>
            ) : (
              <>
                {error && (
                  <div className="rounded-lg bg-cockpit-red/20 border border-cockpit-red/60 px-4 py-3 text-sm font-bold text-white">
                    {error}
                  </div>
                )}

                {liveItems.length === 0 && (
                  <p className="text-center text-neutral-500 py-8 font-bold">
                    Sin productos activos
                  </p>
                )}

                {liveItems.map((item) => {
                  const isAdded = !!item.added_at;
                  const isQtyChanged =
                    item.original_quantity != null &&
                    item.original_quantity !== item.quantity;
                  const busy = busyItemId === item.id;
                  return (
                    <div
                      key={item.id}
                      className={`rounded-lg border p-3 ${
                        isAdded
                          ? 'bg-cockpit-yellow/10 border-cockpit-yellow/40'
                          : 'bg-neutral-900 border-neutral-800'
                      }`}
                    >
                      <div className="flex justify-between items-start gap-3 mb-2">
                        <div className="flex items-center gap-2 flex-wrap flex-1 min-w-0">
                          <span className="text-base font-bold text-white truncate">
                            {item.item_name}
                          </span>
                          {isAdded && (
                            <span className="text-[10px] font-black uppercase tracking-wider bg-cockpit-yellow text-neutral-900 px-1.5 py-0.5 rounded">
                              NUEVO
                            </span>
                          )}
                          {isQtyChanged && (
                            <span className="text-[10px] font-black uppercase bg-cockpit-blue text-white px-1.5 py-0.5 rounded">
                              was {item.original_quantity}
                            </span>
                          )}
                        </div>
                        <span className="text-base font-bold text-brand-300 shrink-0">
                          {formatPrice(Number(item.unit_price) * item.quantity)}
                        </span>
                      </div>
                      {item.modifiers && item.modifiers.length > 0 && (
                        <p className="text-xs text-neutral-400 mb-2">
                          {item.modifiers.map((m) => m.modifier_name).join(' · ')}
                        </p>
                      )}
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1">
                          <button
                            disabled={busy}
                            onClick={() => handleQtyChange(item, -1)}
                            className="h-10 w-10 rounded-md bg-neutral-800 hover:bg-neutral-700 disabled:opacity-40 flex items-center justify-center"
                            aria-label="Menos"
                          >
                            <Minus className="w-4 h-4 text-white" />
                          </button>
                          <span className="h-10 min-w-[44px] flex items-center justify-center font-black text-white text-lg">
                            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : item.quantity}
                          </span>
                          <button
                            disabled={busy}
                            onClick={() => handleQtyChange(item, 1)}
                            className="h-10 w-10 rounded-md bg-neutral-800 hover:bg-neutral-700 disabled:opacity-40 flex items-center justify-center"
                            aria-label="Más"
                          >
                            <Plus className="w-4 h-4 text-white" />
                          </button>
                        </div>
                        <button
                          disabled={busy || item.id == null}
                          onClick={() => item.id != null && setVoidingPick({ itemId: item.id, itemName: item.item_name })}
                          className="h-10 px-3 rounded-md bg-cockpit-red/20 hover:bg-cockpit-red/30 disabled:opacity-40 text-cockpit-out-text font-bold text-sm inline-flex items-center gap-1.5"
                        >
                          <Trash2 className="w-4 h-4" />
                          Cancelar
                        </button>
                      </div>
                    </div>
                  );
                })}

                {voidedItems.length > 0 && (
                  <div className="pt-3 mt-3 border-t border-neutral-800">
                    <p className="text-xs text-neutral-500 font-bold uppercase mb-2">Cancelados</p>
                    {voidedItems.map((item) => (
                      <div
                        key={item.id}
                        className="rounded-md bg-cockpit-red/10 border border-cockpit-red/40 p-2 mb-1.5"
                      >
                        <div className="flex justify-between items-baseline gap-2">
                          <span className="text-sm font-bold line-through text-neutral-400 truncate">
                            {item.quantity}× {item.item_name}
                          </span>
                          <span className="text-[10px] font-black uppercase bg-cockpit-red text-white px-1.5 py-0.5 rounded">
                            VOID
                          </span>
                        </div>
                        {item.void_reason && (
                          <p className="text-xs text-cockpit-out-text font-semibold mt-1">
                            ↳ {item.void_reason}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          {/* Footer */}
          <div className="px-4 py-3 border-t border-neutral-800 bg-neutral-900 rounded-b-2xl">
            <button
              disabled={addingItems || loading}
              onClick={() => setShowPicker(true)}
              className="w-full h-12 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-40 text-white font-black inline-flex items-center justify-center gap-2 mb-3 transition-colors"
            >
              {addingItems ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  Agregando…
                </>
              ) : (
                <>
                  <Plus className="w-5 h-5" />
                  Agregar producto
                </>
              )}
            </button>
            {/* Discount line — visible whenever an order-level discount is active. */}
            {currentDiscount && currentDiscountAmount > 0 && (
              <div className="flex items-center justify-between mb-1 text-cockpit-in-text">
                <span className="text-xs font-bold inline-flex items-center gap-1">
                  <Tag className="w-3 h-3" />
                  {currentDiscount.type === 'comp'
                    ? 'Cortesía'
                    : currentDiscount.type === 'percent'
                      ? 'Descuento %'
                      : 'Descuento'}
                  {currentDiscount.reason ? ` · ${currentDiscount.reason}` : ''}
                </span>
                <span className="text-sm font-black">−{formatPrice(currentDiscountAmount)}</span>
              </div>
            )}
            <div className="flex items-center justify-between">
              <span className="text-sm text-neutral-400 font-bold">Total</span>
              <span className="text-2xl font-black text-brand-300">
                {formatPrice(Math.max(0, total - currentDiscountAmount))}
              </span>
            </div>
            {liveItems.length > 0 && (
              <p className="text-[11px] text-neutral-500 font-bold mt-1">
                Recalculado en vivo · IVA incluido
              </p>
            )}
            {/* Discount surface — unpaid orders only. Paid orders must
                go through refund instead. */}
            {order.payment_status !== 'paid' && (
              <button
                onClick={() => setShowDiscount(true)}
                disabled={loading || liveItems.length === 0}
                className="w-full h-11 mt-3 rounded-lg bg-cockpit-yellow/15 hover:bg-cockpit-yellow/25 disabled:opacity-40 text-cockpit-attention-text font-bold transition-colors inline-flex items-center justify-center gap-1.5 border border-cockpit-yellow/40"
              >
                <Tag className="w-4 h-4" />
                {currentDiscount ? 'Editar descuento' : 'Aplicar descuento / cortesía'}
              </button>
            )}
            <button
              onClick={onClose}
              className="w-full h-11 mt-3 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-white font-bold transition-colors inline-flex items-center justify-center gap-1.5"
            >
              <Check className="w-4 h-4" />
              Listo
            </button>
            {/* Cancel-entire-order — only for unpaid orders. Paid orders must
                go through refund instead, to keep an audit trail. */}
            {order.payment_status !== 'paid' && (
              <button
                onClick={() => setShowDeleteConfirm(true)}
                disabled={deleting || loading}
                className="w-full h-11 mt-2 rounded-lg bg-cockpit-red/20 hover:bg-cockpit-red/30 disabled:opacity-40 text-cockpit-out-text font-bold transition-colors inline-flex items-center justify-center gap-1.5 border border-cockpit-red/40"
              >
                <Trash2 className="w-4 h-4" />
                Cancelar orden completa
              </button>
            )}
            {(order.payment_status === 'paid' || order.payment_status === 'completed') && onRefund && (
              <button
                onClick={() => { onRefund(order.id); onClose(); }}
                disabled={loading}
                className="w-full h-11 mt-2 rounded-lg bg-cockpit-red/20 hover:bg-cockpit-red/30 disabled:opacity-40 text-cockpit-out-text font-bold transition-colors inline-flex items-center justify-center gap-1.5 border border-cockpit-red/40"
              >
                <RotateCcw className="w-4 h-4" />
                Reembolsar
              </button>
            )}
          </div>
        </div>
      </div>

      {voidingPick && (
        <VoidReasonModal
          itemName={voidingPick.itemName}
          onConfirm={handleVoidConfirmed}
          onClose={() => setVoidingPick(null)}
        />
      )}

      {showPicker && (
        <OrderEditMenuPicker
          onCancel={() => setShowPicker(false)}
          onConfirm={handleAddConfirmed}
        />
      )}

      {pendingRetry && (
        <ManagerApprovalModal
          permission="void_orders"
          title="Aprobación requerida"
          message="Edita una orden pagada — pin de manager"
          onApproved={onManagerApproved}
          onClose={() => setPendingRetry(null)}
        />
      )}

      {showDiscount && (
        <DiscountModal
          base={total}
          scope="cart"
          initialDiscount={currentDiscount}
          onSave={handleDiscountSave}
          onClose={() => setShowDiscount(false)}
        />
      )}

      {showDeleteConfirm && (
        <div className="fixed inset-0 bg-black/80 z-[60] flex items-center justify-center p-4">
          <div className="bg-neutral-950 rounded-2xl shadow-2xl w-full max-w-sm border border-cockpit-red/60 p-5">
            <div className="flex items-center gap-3 mb-3">
              <div className="h-10 w-10 rounded-full bg-cockpit-red/20 flex items-center justify-center">
                <Trash2 className="w-5 h-5 text-cockpit-out-text" />
              </div>
              <h3 className="text-lg font-black text-white">¿Cancelar orden #{order.order_number}?</h3>
            </div>
            <p className="text-sm text-neutral-400 mb-5">
              Se eliminarán todos los productos. La cocina dejará de verla. Esta acción no se puede deshacer.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setShowDeleteConfirm(false)}
                disabled={deleting}
                className="flex-1 h-12 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-white font-bold"
              >
                No, regresar
              </button>
              <button
                onClick={handleConfirmDelete}
                disabled={deleting}
                className="flex-1 h-12 rounded-lg bg-cockpit-red hover:brightness-110 disabled:opacity-50 text-white font-black inline-flex items-center justify-center gap-1.5"
              >
                {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                {deleting ? 'Cancelando…' : 'Sí, cancelar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default OrderEditModal;
