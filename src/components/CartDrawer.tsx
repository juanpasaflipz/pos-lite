import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { CartItem, LoyaltyCustomer, ComboDefinition, Discount, Order } from '../types';
import { formatPrice, TAX_LABEL } from '../utils/currency';
import { formatTime } from '../utils/dateFormat';
import { Check, ClipboardList, PauseCircle, Percent, Smartphone, Trash2, User, X } from 'lucide-react';

interface CartDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  cart: CartItem[];
  linkedCustomer: LoyaltyCustomer | null;
  customerCallName: string;
  onChangeCustomerCallName: (value: string) => void;
  unpaidOrders: Order[];
  showUnpaidOrders: boolean;
  parkedCount: number;
  onUnlinkCustomer: () => void;
  onRemoveFromCart: (cartId: string) => void;
  onUpdateQuantity: (cartId: string, quantity: number) => void;
  onSetNotesItem: (item: CartItem) => void;
  onShowPaymentModal: () => void;
  onSendToKitchen: () => void;
  fulfillment: 'for_here' | 'to_go' | 'delivery';
  onFulfillmentChange: (next: 'for_here' | 'to_go' | 'delivery') => void;
  onShowCustomerLookup: () => void;
  onShowTemplates: () => void;
  onShowParkedCarts: () => void;
  onShowComboBuilder: () => void;
  onShowSplitPayment: () => void;
  onClearCart: () => void;
  onLogout: () => void;
  onCobrar: (order: Order) => void;
  onToggleUnpaidOrders: () => void;
  onDeleteUnpaidOrder?: (order: Order) => void;
  selectedUnpaidIds?: Set<number>;
  unpaidSelectMode?: boolean;
  onToggleUnpaidSelectMode?: () => void;
  onToggleUnpaidSelected?: (order: Order) => void;
  onClearUnpaidSelection?: () => void;
  onCobrarJuntas?: () => void;
  comboSuggestion: { combo: ComboDefinition; matchedItems: CartItem[]; savings: number } | null;
  onConvertToCombo: () => void;
  total: number;
  subtotal: number;
  tax: number;
  cartDiscount: Discount | null;
  totalDiscount: number;
  onApplyCartDiscount: () => void;
  onApplyLineDiscount: (item: CartItem) => void;
}

const CartDrawer: React.FC<CartDrawerProps> = ({
  isOpen,
  onClose,
  cart,
  linkedCustomer,
  customerCallName,
  onChangeCustomerCallName,
  unpaidOrders,
  showUnpaidOrders,
  parkedCount,
  onUnlinkCustomer,
  onRemoveFromCart,
  onUpdateQuantity,
  onSetNotesItem,
  onShowPaymentModal,
  onSendToKitchen,
  fulfillment,
  onFulfillmentChange,
  onShowCustomerLookup,
  onShowTemplates,
  onShowParkedCarts,
  onShowComboBuilder,
  onShowSplitPayment,
  onClearCart,
  onLogout,
  onCobrar,
  onToggleUnpaidOrders,
  onDeleteUnpaidOrder,
  comboSuggestion,
  onConvertToCombo,
  total,
  subtotal,
  tax,
  cartDiscount,
  totalDiscount,
  onApplyCartDiscount,
  onApplyLineDiscount,
  selectedUnpaidIds,
  unpaidSelectMode,
  onToggleUnpaidSelectMode,
  onToggleUnpaidSelected,
  onClearUnpaidSelection,
  onCobrarJuntas,
}) => {
  const { t } = useTranslation('pos');

  const cartCount = cart.reduce((sum, item) => sum + item.quantity, 0);
  const pendingTotal = unpaidOrders.reduce((sum, order) => sum + Number(order.total || 0), 0);
  const selectionMode = !!(unpaidSelectMode || (selectedUnpaidIds && selectedUnpaidIds.size > 0));
  const selectedOrders = selectionMode ? unpaidOrders.filter((o) => selectedUnpaidIds!.has(o.id)) : [];
  const selectedTotal = selectedOrders.reduce((s, o) => s + Number(o.total || 0), 0);

  // Lock body scroll when drawer open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => { document.body.style.overflow = ''; };
  }, [isOpen]);

  return (
    <>
      {/* Overlay */}
      <div
        className={`fixed inset-0 bg-black/50 z-40 transition-opacity duration-300 ${
          isOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
        onClick={onClose}
      />

      {/* Drawer */}
      <div
        className={`fixed top-0 right-0 z-50 w-80 h-full bg-neutral-900 border-l border-neutral-800 flex flex-col transition-transform duration-300 ease-in-out ${
          isOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        {/* Header */}
        <div className="bg-brand-600 text-white p-3">
          <div className="flex items-start justify-between gap-2">
            <div className="flex-1 min-w-0">
              <p className="text-lg font-bold">
                {cart.length === 0
                  ? t('cart.newOrder')
                  : t('cart.itemCount', { count: cartCount })}
              </p>
              <p className="text-xs text-brand-200">{formatTime(new Date())}</p>
            </div>
            {unpaidOrders.length > 0 && (
              <button
                onClick={onToggleUnpaidOrders}
                className="flex flex-col items-end bg-brand-700/60 hover:bg-brand-700 rounded-lg px-2 py-1 transition-all"
              >
                <span className="flex items-center gap-1 text-xs font-bold">
                  <span className="bg-white text-brand-700 rounded-full px-1.5 min-w-5 text-center text-[10px]">
                    {unpaidOrders.length}
                  </span>
                  {t('cart.pendingLabel')}
                  <span className="text-brand-200 text-[10px]">{showUnpaidOrders ? '▲' : '▼'}</span>
                </span>
                <span className="text-[10px] text-brand-200 mt-0.5">{formatPrice(pendingTotal)}</span>
              </button>
            )}
            <button onClick={onClose} className="text-brand-200 hover:text-white p-1 shrink-0">
              <X className="w-5 h-5" />
            </button>
          </div>
          {linkedCustomer ? (
            <div className="mt-2 flex items-center justify-between bg-brand-700/50 rounded-lg px-3 py-1.5">
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold">{linkedCustomer.name}</span>
                {linkedCustomer.activeCard && (
                  <span className="text-xs bg-cockpit-blue px-2 py-0.5 rounded-full">
                    {linkedCustomer.activeCard.stamps_earned}/{linkedCustomer.activeCard.stamps_required}
                  </span>
                )}
              </div>
              <button onClick={onUnlinkCustomer} className="text-brand-200 hover:text-white text-xs font-bold">
                {t('cart.unlink')}
              </button>
            </div>
          ) : (
            <div className="mt-2 flex items-center gap-2 bg-brand-700/40 rounded-lg px-3 py-1.5">
              <User className="w-4 h-4 text-brand-200 shrink-0" />
              <input
                type="text"
                value={customerCallName}
                onChange={(e) => onChangeCustomerCallName(e.target.value)}
                maxLength={60}
                placeholder={t('cart.customerNamePlaceholder', { defaultValue: 'Nombre del cliente (opcional)' })}
                className="flex-1 bg-transparent text-white placeholder-brand-200/70 text-sm font-bold focus:outline-none"
              />
            </div>
          )}
        </div>

        {/* Unpaid orders list — toggled from the header pending pill */}
        {unpaidOrders.length > 0 && showUnpaidOrders && (
          <div className="border-b border-neutral-800 bg-cockpit-yellow/10">
            <div className="flex items-center justify-between px-3 pt-2 pb-1">
              <span className="text-cockpit-attention-text font-bold text-xs">{t('cart.unpaidOrders')}</span>
              <div className="flex items-center gap-2">
                {unpaidOrders.length >= 2 && !selectionMode && onToggleUnpaidSelectMode && (
                  <button
                    onClick={onToggleUnpaidSelectMode}
                    className="text-[11px] px-2 py-1 rounded-md bg-brand-600/20 border border-brand-600/40 text-brand-200 hover:bg-brand-600/30 font-bold min-h-[32px]"
                  >
                    {t('cart.selectMultiple', { defaultValue: 'Seleccionar varias' })}
                  </button>
                )}
                {selectionMode && onClearUnpaidSelection && (
                  <button onClick={onClearUnpaidSelection} className="text-[11px] text-neutral-400 hover:text-white font-bold">
                    {t('cart.cancelSelection', { defaultValue: 'Cancelar' })}
                  </button>
                )}
              </div>
            </div>
            <div className="px-3 pb-2 space-y-1.5 max-h-48 overflow-y-auto">
              {unpaidOrders.map((order) => {
                const isSelected = selectedUnpaidIds?.has(order.id) || false;
                const disableToggle = order.source === 'customer_kiosk' && String(order.status) === 'draft_kiosk';
                let pressTimer: ReturnType<typeof setTimeout> | null = null;
                const rowClasses = isSelected
                  ? 'bg-brand-600/20 border-brand-500'
                  : 'bg-neutral-800 border-neutral-700';
                return (
                  <div
                    key={order.id}
                    className={`flex items-center justify-between rounded-lg px-2.5 py-1.5 border ${rowClasses}`}
                    onPointerDown={() => {
                      if (disableToggle || !onToggleUnpaidSelected) return;
                      pressTimer = setTimeout(() => onToggleUnpaidSelected(order), 400);
                    }}
                    onPointerUp={() => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } }}
                    onPointerLeave={() => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } }}
                    onClick={() => {
                      if (selectionMode && onToggleUnpaidSelected && !disableToggle) onToggleUnpaidSelected(order);
                    }}
                  >
                    {selectionMode && (
                      <div className={`flex-shrink-0 mr-2 w-5 h-5 rounded border-2 flex items-center justify-center ${isSelected ? 'bg-brand-500 border-brand-500' : 'border-neutral-500'}`}>
                        {isSelected && <Check className="w-3 h-3 text-white" />}
                      </div>
                    )}
                    <div className="min-w-0 flex-1 mr-2">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <p className="text-white font-bold text-xs">#{order.order_number}</p>
                        {order.source === 'customer_kiosk' && (
                          <span
                            className="inline-flex items-center gap-1 rounded-full bg-brand-600/20 border border-brand-600/40 text-brand-200 text-[9px] font-black uppercase px-1.5 py-0.5 tracking-wide"
                            title={t('cart.fromKiosk')}
                          >
                            <Smartphone className="h-3 w-3" />
                            Kiosko
                          </span>
                        )}
                        {order.order_fulfillment_type && (
                          <span className="inline-flex items-center rounded-full bg-cockpit-yellow text-neutral-950 text-[9px] font-black uppercase px-1.5 py-0.5 tracking-wide whitespace-nowrap">
                            {order.order_fulfillment_type === 'for_here' ? t('cart.forHere') : t('cart.toGo')}
                          </span>
                        )}
                      </div>
                      {order.customer_name && (
                        <p className="text-neutral-300 text-[11px] truncate inline-flex items-center gap-1">
                          <User className="h-3 w-3 text-neutral-500 shrink-0" />
                          {order.customer_name}
                        </p>
                      )}
                      <p className="text-neutral-400 text-[11px]">{formatPrice(order.total)}</p>
                    </div>
                    {!selectionMode && (
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={(e) => { e.stopPropagation(); onCobrar(order); }}
                          className="px-2.5 py-1.5 bg-brand-600 text-white text-[11px] font-bold rounded-lg hover:bg-brand-700 transition-all min-h-[40px]"
                        >
                          {t('cart.charge')}
                        </button>
                        {onDeleteUnpaidOrder && (
                          <button
                            onClick={(e) => { e.stopPropagation(); onDeleteUnpaidOrder(order); }}
                            title="Delete order"
                            className="p-1.5 text-neutral-400 hover:text-cockpit-out-text/90 hover:bg-neutral-700 rounded-lg transition-all min-h-[40px] min-w-[40px] flex items-center justify-center"
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {selectionMode && selectedOrders.length >= 2 && onCobrarJuntas && (
              <div className="px-3 pb-2">
                <button
                  onClick={onCobrarJuntas}
                  className="w-full py-2.5 rounded-xl bg-brand-600 hover:bg-brand-700 text-white font-black text-xs shadow-lg transition-all min-h-[44px]"
                >
                  {t('cart.cobrarJuntas', { defaultValue: 'Cobrar juntas' })} · {selectedOrders.length} · {formatPrice(selectedTotal)}
                </button>
              </div>
            )}
            {selectionMode && selectedOrders.length < 2 && (
              <div className="px-3 pb-2">
                <div className="w-full py-2.5 rounded-xl bg-neutral-800 text-neutral-500 text-center font-bold text-xs">
                  {t('cart.selectAtLeastTwo', { defaultValue: 'Selecciona al menos 2 pedidos' })}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Cart items */}
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {cart.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-center">
                <p className="text-neutral-500 text-base">{t('cart.noItems')}</p>
                <p className="text-neutral-600 text-sm mt-1">{t('cart.selectItems')}</p>
              </div>
            </div>
          ) : (
            cart.map((item) => {
              const isComboItem = !!item.combo_instance_id;
              const isFirstComboItem = isComboItem && cart.findIndex(
                (ci) => ci.combo_instance_id === item.combo_instance_id
              ) === cart.indexOf(item);
              const isSubComboItem = isComboItem && !isFirstComboItem;

              return (
                <div
                  key={item.cart_id}
                  className={`rounded-lg p-2.5 border ${
                    isComboItem
                      ? isFirstComboItem
                        ? 'bg-cockpit-yellow/20 border-cockpit-yellow'
                        : 'bg-cockpit-yellow/10 border-cockpit-yellow/50 ml-3'
                      : 'bg-neutral-800 border-neutral-700'
                  }`}
                >
                  {isFirstComboItem && (
                    <p className="text-xs font-bold text-cockpit-attention-text mb-1 uppercase tracking-wider">{t('cart.combo')}</p>
                  )}
                  <div className="flex justify-between items-start mb-1">
                    <div className="flex-1">
                      <p className="font-bold text-white text-sm">{item.item_name}</p>
                      {item.selectedModifierNames && item.selectedModifierNames.length > 0 && (
                        <div className="mt-0.5 space-y-0.5">
                          {item.selectedModifierNames.map((name, i) => (
                            <p key={i} className="text-xs text-brand-400">+ {name}</p>
                          ))}
                        </div>
                      )}
                      {item.notes && (
                        <p className="text-xs text-neutral-400 mt-0.5">{t('cart.note', { note: item.notes })}</p>
                      )}
                    </div>
                    {!isSubComboItem && (
                      <button onClick={() => onRemoveFromCart(item.cart_id)} className="text-brand-500 hover:text-brand-400 font-bold ml-2 text-sm">
                        ✕
                      </button>
                    )}
                  </div>
                  {!isSubComboItem && (
                    <div className="flex justify-between items-center mb-1">
                      <div className="flex items-center gap-1.5">
                        {!isComboItem && (
                          <>
                            <button
                              onClick={() => onUpdateQuantity(item.cart_id, item.quantity - 1)}
                              className="w-7 h-7 bg-neutral-700 text-white font-bold rounded hover:bg-neutral-600 transition-all text-sm"
                            >
                              −
                            </button>
                            <span className="w-8 text-center font-bold text-white text-sm">{item.quantity}</span>
                            <button
                              onClick={() => onUpdateQuantity(item.cart_id, item.quantity + 1)}
                              className="w-7 h-7 bg-neutral-700 text-white font-bold rounded hover:bg-neutral-600 transition-all text-sm"
                            >
                              +
                            </button>
                          </>
                        )}
                      </div>
                      <p className="font-bold text-white text-sm">
                        {item.unit_price > 0 ? formatPrice(item.unit_price * item.quantity) : ''}
                      </p>
                    </div>
                  )}
                  {item.discount && (
                    <div className="mb-1.5 px-2 py-1 bg-cockpit-yellow/30 border border-cockpit-yellow rounded text-xs flex items-center justify-between">
                      <div className="flex-1 min-w-0">
                        <p className="text-cockpit-attention-text font-semibold">
                          {item.discount.type === 'comp'
                            ? t('discount.compLabel')
                            : item.discount.type === 'percent'
                              ? t('discount.percentLabel', { value: item.discount.value })
                              : t('discount.amountLabel', { value: formatPrice(item.discount.value) })}
                        </p>
                      </div>
                      <button
                        onClick={() => onApplyLineDiscount(item)}
                        className="text-cockpit-attention-text hover:text-white text-xs font-bold ml-2"
                      >
                        {t('discount.edit')}
                      </button>
                    </div>
                  )}
                  {!isComboItem && (
                    <div className="flex gap-1.5">
                      {!item.selectedModifierIds?.length && (
                        <button
                          onClick={() => onSetNotesItem(item)}
                          className="flex-1 py-1.5 text-xs bg-neutral-700 text-neutral-300 rounded hover:bg-neutral-600 transition-all font-semibold"
                        >
                          {t('cart.addNotes')}
                        </button>
                      )}
                      {!item.discount && (
                        <button
                          onClick={() => onApplyLineDiscount(item)}
                          title={t('discount.applyToLine')}
                          className={`${item.selectedModifierIds?.length ? 'flex-1' : 'px-2'} py-1.5 text-xs bg-neutral-700 text-cockpit-attention-text rounded hover:bg-neutral-600 transition-all flex items-center justify-center gap-1`}
                        >
                          <Percent className="w-3.5 h-3.5" />
                          {item.selectedModifierIds?.length ? <span className="font-semibold">{t('discount.applyToLine')}</span> : null}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Combo Detection Banner */}
        {comboSuggestion && (
          <div className="mx-3 mb-2 bg-cockpit-yellow/30 border border-cockpit-yellow rounded-lg p-2.5">
            <p className="text-cockpit-attention-text font-bold text-xs">{t('comboDetection.title')}</p>
            <p className="text-cockpit-attention-text text-xs mt-0.5">
              {t('comboDetection.message', { name: comboSuggestion.combo.name, savings: formatPrice(comboSuggestion.savings) })}
            </p>
            <button
              onClick={onConvertToCombo}
              className="mt-1.5 w-full py-1.5 bg-cockpit-yellow text-neutral-900 text-xs font-bold rounded-lg hover:bg-cockpit-yellow/90 transition-all"
            >
              {t('comboDetection.convert', { price: formatPrice(comboSuggestion.combo.combo_price) })}
            </button>
          </div>
        )}

        {/* Totals */}
        <div className="border-t border-neutral-800 p-3 space-y-1.5">
          <div className="border-b border-neutral-700 pb-1.5 flex justify-between text-lg">
            <span className="font-bold text-white">{t('totals.total')}</span>
            <span className="font-bold text-brand-500">{formatPrice(total)}</span>
          </div>
          {totalDiscount > 0 && (
            <div className="flex justify-between text-cockpit-attention-text text-xs font-semibold">
              <span>{t('totals.discount')}</span>
              <span>-{formatPrice(totalDiscount)}</span>
            </div>
          )}
          <div className="flex justify-between text-neutral-500 text-xs">
            <span>{t('totals.subtotalBeforeTax')}</span>
            <span>{formatPrice(subtotal)}</span>
          </div>
          <div className="flex justify-between text-neutral-500 text-xs">
            <span>{t('totals.taxIncluded', { label: TAX_LABEL })}</span>
            <span>{formatPrice(tax)}</span>
          </div>
        </div>

        {/* Actions */}
        <div className="border-t border-neutral-800 p-3 space-y-2">
          {/* Fulfillment selector — kitchen needs to know if it's for here
              or to go. Mirrors the kiosk selector; defaults to take-away. */}
          <div className="grid grid-cols-3 gap-2" role="group" aria-label={t('cart.fulfillmentLabel')}>
            <button
              type="button"
              onClick={() => onFulfillmentChange('to_go')}
              aria-pressed={fulfillment === 'to_go'}
              className={`py-2 text-sm font-bold rounded-lg transition-all touch-manipulation ${
                fulfillment === 'to_go'
                  ? 'bg-cockpit-attention text-neutral-900'
                  : 'bg-neutral-800 text-neutral-400 hover:bg-neutral-700'
              }`}
            >
              {t('cart.toGo')}
            </button>
            <button
              type="button"
              onClick={() => onFulfillmentChange('for_here')}
              aria-pressed={fulfillment === 'for_here'}
              className={`py-2 text-sm font-bold rounded-lg transition-all touch-manipulation ${
                fulfillment === 'for_here'
                  ? 'bg-cockpit-attention text-neutral-900'
                  : 'bg-neutral-800 text-neutral-400 hover:bg-neutral-700'
              }`}
            >
              {t('cart.forHere')}
            </button>
            <button
              type="button"
              onClick={() => onFulfillmentChange('delivery')}
              aria-pressed={fulfillment === 'delivery'}
              className={`py-2 text-sm font-bold rounded-lg transition-all touch-manipulation ${
                fulfillment === 'delivery'
                  ? 'bg-cockpit-green text-white'
                  : 'bg-neutral-800 text-neutral-400 hover:bg-neutral-700'
              }`}
            >
              {t('cart.delivery')}
            </button>
          </div>
          <button
            onClick={onShowPaymentModal}
            disabled={cart.length === 0}
            className="w-full py-3 bg-brand-600 text-white text-base font-bold rounded-lg hover:bg-brand-700 disabled:bg-neutral-800 disabled:text-neutral-600 disabled:cursor-not-allowed transition-all touch-manipulation"
          >
            {t('totals.charge', { amount: formatPrice(total) })}
          </button>
          <button
            onClick={onSendToKitchen}
            disabled={cart.length === 0}
            title={t('totals.sendToKitchenHint')}
            className="w-full py-2.5 bg-cockpit-attention text-neutral-900 text-sm font-bold rounded-lg hover:bg-cockpit-attention/90 disabled:bg-neutral-800 disabled:text-neutral-600 disabled:cursor-not-allowed transition-all touch-manipulation flex items-center justify-center gap-2"
          >
            <ClipboardList className="w-4 h-4" />
            {t('totals.sendToKitchen')}
          </button>
          <button
            onClick={onShowCustomerLookup}
            className={`w-full py-2.5 text-white text-sm font-bold rounded-lg transition-all touch-manipulation ${
              linkedCustomer ? 'bg-cockpit-blue/80 hover:bg-cockpit-blue/70' : 'bg-cockpit-blue hover:bg-cockpit-blue/90'
            }`}
          >
            {linkedCustomer ? t('loyalty.loyaltyCustomer', { name: linkedCustomer.name }) : t('loyalty.loyaltyProgram')}
          </button>
          <button
            onClick={onShowParkedCarts}
            disabled={cart.length === 0 && parkedCount === 0}
            className="w-full py-2.5 bg-cockpit-blue text-white text-sm font-bold rounded-lg hover:bg-cockpit-blue/90 disabled:bg-neutral-800 disabled:text-neutral-600 disabled:cursor-not-allowed transition-all touch-manipulation flex items-center justify-center gap-2"
          >
            <PauseCircle className="w-4 h-4" />
            {parkedCount > 0
              ? t('parkedCarts.buttonWithCount', { count: parkedCount })
              : t('parkedCarts.button')}
          </button>
          <div className="flex gap-1.5">
            <button
              onClick={onShowTemplates}
              className="flex-1 py-2.5 bg-cockpit-green text-white text-xs font-bold rounded-lg hover:bg-cockpit-green/90 transition-all touch-manipulation flex items-center justify-center gap-1"
            >
              <ClipboardList className="w-3.5 h-3.5" />
              {t('quickOrders.title')}
            </button>
            <button
              onClick={onShowComboBuilder}
              className="flex-1 py-2.5 bg-cockpit-yellow text-neutral-900 text-xs font-bold rounded-lg hover:bg-cockpit-yellow/90 transition-all touch-manipulation"
            >
              {t('actions.combos')}
            </button>
            <button
              onClick={onShowSplitPayment}
              disabled={cart.length === 0}
              className="flex-1 py-2.5 bg-cockpit-blue text-white text-xs font-bold rounded-lg hover:bg-cockpit-blue/90 disabled:bg-neutral-800 disabled:text-neutral-600 transition-all touch-manipulation"
            >
              {t('actions.splitPay')}
            </button>
          </div>
          <button
            onClick={onApplyCartDiscount}
            disabled={cart.length === 0}
            className="w-full py-2.5 bg-cockpit-yellow text-neutral-900 text-xs font-bold rounded-lg hover:bg-cockpit-yellow/90 disabled:bg-neutral-800 disabled:text-neutral-600 disabled:cursor-not-allowed transition-all touch-manipulation flex items-center justify-center gap-1.5"
          >
            <Percent className="w-3.5 h-3.5" />
            {cartDiscount ? t('discount.modify') : t('discount.applyToOrder')}
          </button>
          <button
            onClick={onClearCart}
            disabled={cart.length === 0}
            className="w-full py-2 text-brand-500 text-sm font-bold hover:text-brand-400 hover:bg-neutral-800 disabled:text-neutral-700 transition-all rounded-lg"
          >
            {t('totals.clearOrder')}
          </button>
          <button
            onClick={onLogout}
            className="w-full py-2 bg-neutral-800 text-neutral-400 text-xs font-bold rounded hover:bg-neutral-700 transition-all border border-neutral-700"
          >
            {t('common:buttons.logout')}
          </button>
        </div>
      </div>
    </>
  );
};

export default CartDrawer;
