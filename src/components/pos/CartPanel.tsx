import React from 'react';
import { useTranslation } from 'react-i18next';
import { ClipboardList, Smartphone, Trash2, PauseCircle, Percent, Truck, User } from 'lucide-react';
import { CartItem, Order, LoyaltyCustomer, ComboDefinition, Discount } from '../../types';
import { formatPrice, TAX_LABEL } from '../../utils/currency';
import { formatTime } from '../../utils/dateFormat';
import type { DeliveryDraft } from './DeliveryAddressModal';

interface ComboSuggestion {
  combo: ComboDefinition;
  matchedItems: CartItem[];
  savings: number;
}

interface CartPanelProps {
  cart: CartItem[];
  linkedCustomer: LoyaltyCustomer | null;
  unpaidOrders: Order[];
  showUnpaidOrders: boolean;
  comboSuggestion: ComboSuggestion | null;
  total: number;
  subtotal: number;
  tax: number;
  parkedCount: number;
  cartDiscount: Discount | null;
  totalDiscount: number;
  onRemoveFromCart: (cartId: string) => void;
  onUpdateQuantity: (cartId: string, quantity: number) => void;
  onSetNotesItem: (item: CartItem) => void;
  onShowPaymentModal: () => void;
  onSendToKitchen: () => void;
  fulfillment: 'for_here' | 'to_go' | 'delivery';
  onFulfillmentChange: (next: 'for_here' | 'to_go' | 'delivery') => void;
  deliveryDraft?: DeliveryDraft | null;
  onEditDelivery?: () => void;
  onShowCustomerLookup: () => void;
  onShowTemplates: () => void;
  onShowParkedCarts: () => void;
  onShowComboBuilder: () => void;
  onShowSplitPayment: () => void;
  onClearCart: () => void;
  onLogout: () => void;
  onConvertToCombo: () => void;
  onCobrar: (order: Order) => void;
  onToggleUnpaidOrders: () => void;
  onUnlinkCustomer: () => void;
  onDeleteUnpaidOrder?: (order: Order) => void;
  onApplyCartDiscount: () => void;
  onApplyLineDiscount: (item: CartItem) => void;
}

export default function CartPanel({
  cart,
  linkedCustomer,
  unpaidOrders,
  showUnpaidOrders,
  comboSuggestion,
  total,
  subtotal,
  tax,
  parkedCount,
  cartDiscount,
  totalDiscount,
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
  onConvertToCombo,
  onCobrar,
  onToggleUnpaidOrders,
  onDeleteUnpaidOrder,
  onUnlinkCustomer,
  onApplyCartDiscount,
  onApplyLineDiscount,
  deliveryDraft,
  onEditDelivery,
}: CartPanelProps) {
  const { t } = useTranslation('pos');

  const cartCount = cart.reduce((sum, item) => sum + item.quantity, 0);
  const pendingTotal = unpaidOrders.reduce((sum, order) => sum + Number(order.total || 0), 0);

  return (
    <div className="hidden lg:flex w-96 bg-neutral-900 border-l border-neutral-800 flex-col">
      <div className="bg-brand-600 text-white p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xl font-bold">
              {cart.length === 0
                ? t('cart.newOrder')
                : t('cart.itemCount', { count: cartCount })}
            </p>
            <p className="text-sm text-brand-200">{formatTime(new Date())}</p>
          </div>
          {unpaidOrders.length > 0 && (
            <button
              onClick={onToggleUnpaidOrders}
              className="flex flex-col items-end bg-brand-700/60 hover:bg-brand-700 rounded-lg px-3 py-1.5 transition-all"
            >
              <span className="flex items-center gap-1.5 text-sm font-bold">
                <span className="bg-white text-brand-700 rounded-full px-1.5 min-w-5 text-center text-xs">
                  {unpaidOrders.length}
                </span>
                {t('cart.pendingLabel')}
                <span className="text-brand-200 text-[10px]">{showUnpaidOrders ? '▲' : '▼'}</span>
              </span>
              <span className="text-xs text-brand-200 mt-0.5">{formatPrice(pendingTotal)}</span>
            </button>
          )}
        </div>
        {linkedCustomer && (
          <div className="mt-2 flex items-center justify-between bg-brand-700/50 rounded-lg px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold">{linkedCustomer.name}</span>
              {linkedCustomer.activeCard && (
                <span className="text-xs bg-cockpit-blue px-2 py-0.5 rounded-full">
                  {linkedCustomer.activeCard.stamps_earned}/{linkedCustomer.activeCard.stamps_required}
                </span>
              )}
            </div>
            <button
              onClick={onUnlinkCustomer}
              className="text-brand-200 hover:text-white text-xs font-bold"
            >
              {t('cart.unlink')}
            </button>
          </div>
        )}
      </div>

      {/* Unpaid orders list \u2014 toggled from the header pending badge */}
      {unpaidOrders.length > 0 && showUnpaidOrders && (
        <div className="border-b border-neutral-800 bg-cockpit-yellow/10">
          <div className="flex items-center justify-between px-4 pt-3 pb-1">
            <span className="text-cockpit-attention-text font-bold text-sm">{t('cart.unpaidOrders')}</span>
          </div>
          <div className="px-4 pb-3 space-y-2 max-h-48 overflow-y-auto">
            {unpaidOrders.map((order) => (
              <div
                key={order.id}
                className="flex items-center justify-between bg-neutral-800 rounded-lg px-3 py-2 border border-neutral-700"
              >
                <div className="min-w-0 flex-1 mr-2">
                  <div className="flex items-center gap-2">
                    <p className="text-white font-bold text-sm">#{order.order_number}</p>
                    {order.source === 'customer_kiosk' && (
                      <span
                        className="inline-flex items-center gap-1 rounded-full bg-brand-600/20 border border-brand-600/40 text-brand-200 text-[10px] font-black uppercase px-1.5 py-0.5 tracking-wide"
                        title={t('cart.fromKiosk')}
                      >
                        <Smartphone className="h-3 w-3" />
                        Kiosko
                      </span>
                    )}
                    {order.order_fulfillment_type && (
                      <span className="inline-flex items-center rounded-full bg-cockpit-yellow text-neutral-950 text-[10px] font-black uppercase px-1.5 py-0.5 tracking-wide whitespace-nowrap">
                        {order.order_fulfillment_type === 'for_here' ? t('cart.forHere') : t('cart.toGo')}
                      </span>
                    )}
                  </div>
                  {order.customer_name && (
                    <p className="text-neutral-300 text-xs truncate inline-flex items-center gap-1">
                      <User className="h-3 w-3 text-neutral-500 shrink-0" />
                      {order.customer_name}
                    </p>
                  )}
                  <p className="text-neutral-400 text-xs">{formatPrice(order.total)}</p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => onCobrar(order)}
                    className="px-3 py-1.5 bg-brand-600 text-white text-xs font-bold rounded-lg hover:bg-brand-700 transition-all"
                  >
                    {t('cart.charge')}
                  </button>
                  {onDeleteUnpaidOrder && (
                    <button
                      onClick={() => onDeleteUnpaidOrder(order)}
                      title="Delete order"
                      className="p-1.5 text-neutral-400 hover:text-cockpit-out-text/90 hover:bg-neutral-700 rounded-lg transition-all"
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {cart.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <p className="text-neutral-500 text-lg">{t('cart.noItems')}</p>
              <p className="text-neutral-600 text-sm mt-2">{t('cart.selectItems')}</p>
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
                className={`rounded-lg p-3 border ${
                  isComboItem
                    ? isFirstComboItem
                      ? 'bg-cockpit-yellow/20 border-cockpit-yellow'
                      : 'bg-cockpit-yellow/10 border-cockpit-yellow/50 ml-4'
                    : 'bg-neutral-800 border-neutral-700'
                }`}
              >
                {isFirstComboItem && (
                  <p className="text-xs font-bold text-cockpit-attention-text mb-1 uppercase tracking-wider">{t('cart.combo')}</p>
                )}
                <div className="flex justify-between items-start mb-1">
                  <div className="flex-1">
                    <p className="font-bold text-white">{item.item_name}</p>
                    {item.selectedModifierNames && item.selectedModifierNames.length > 0 && (
                      <div className="mt-1 space-y-0.5">
                        {item.selectedModifierNames.map((name, i) => (
                          <p key={i} className="text-xs text-brand-400">+ {name}</p>
                        ))}
                      </div>
                    )}
                    {item.notes && (
                      <p className="text-xs text-neutral-400 mt-1">{t('cart.note', { note: item.notes })}</p>
                    )}
                  </div>
                  {(!isSubComboItem) && (
                    <button
                      onClick={() => onRemoveFromCart(item.cart_id)}
                      className="text-brand-500 hover:text-brand-400 font-bold ml-2"
                    >
                      ✕
                    </button>
                  )}
                </div>

                {!isSubComboItem && (
                  <div className="flex justify-between items-center mb-2">
                    <div className="flex items-center gap-2">
                      {!isComboItem && (
                        <>
                          <button
                            onClick={() => onUpdateQuantity(item.cart_id, item.quantity - 1)}
                            className="w-8 h-8 bg-neutral-700 text-white font-bold rounded hover:bg-neutral-600 transition-all"
                          >
                            −
                          </button>
                          <span className="w-10 text-center font-bold text-white">{item.quantity}</span>
                          <button
                            onClick={() => onUpdateQuantity(item.cart_id, item.quantity + 1)}
                            className="w-8 h-8 bg-neutral-700 text-white font-bold rounded hover:bg-neutral-600 transition-all"
                          >
                            +
                          </button>
                        </>
                      )}
                    </div>
                    <p className="font-bold text-white">
                      {item.unit_price > 0 ? formatPrice(item.unit_price * item.quantity) : ''}
                    </p>
                  </div>
                )}

                {item.discount && (
                  <div className="mb-2 px-2 py-1.5 bg-cockpit-yellow/30 border border-cockpit-yellow rounded text-xs flex items-center justify-between">
                    <div className="flex-1 min-w-0">
                      <p className="text-cockpit-attention-text font-semibold">
                        {item.discount.type === 'comp'
                          ? t('discount.compLabel')
                          : item.discount.type === 'percent'
                            ? t('discount.percentLabel', { value: item.discount.value })
                            : t('discount.amountLabel', { value: formatPrice(item.discount.value) })}
                      </p>
                      {item.discount.reason && (
                        <p className="text-cockpit-attention-text/80 truncate">{item.discount.reason}</p>
                      )}
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
                  <div className="flex gap-2">
                    {!item.selectedModifierIds?.length && (
                      <button
                        onClick={() => onSetNotesItem(item)}
                        className="flex-1 py-2 text-sm bg-neutral-700 text-neutral-300 rounded hover:bg-neutral-600 transition-all font-semibold"
                      >
                        {t('cart.addNotes')}
                      </button>
                    )}
                    {!item.discount && (
                      <button
                        onClick={() => onApplyLineDiscount(item)}
                        title={t('discount.applyToLine')}
                        className={`${item.selectedModifierIds?.length ? 'flex-1' : 'px-3'} py-2 text-sm bg-neutral-700 text-cockpit-attention-text rounded hover:bg-neutral-600 transition-all font-semibold flex items-center justify-center gap-1`}
                      >
                        <Percent className="w-4 h-4" />
                        {item.selectedModifierIds?.length ? <span>{t('discount.applyToLine')}</span> : null}
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
        <div className="mx-4 mb-2 bg-cockpit-yellow/30 border border-cockpit-yellow rounded-lg p-3">
          <p className="text-cockpit-attention-text font-bold text-sm">{t('comboDetection.title')}</p>
          <p className="text-cockpit-attention-text text-xs mt-1">
            {t('comboDetection.message', { name: comboSuggestion.combo.name, savings: formatPrice(comboSuggestion.savings) })}
          </p>
          <button
            onClick={onConvertToCombo}
            className="mt-2 w-full py-2 bg-cockpit-yellow text-neutral-900 text-sm font-bold rounded-lg hover:bg-cockpit-yellow/90 transition-all"
          >
            {t('comboDetection.convert', { price: formatPrice(comboSuggestion.combo.combo_price) })}
          </button>
        </div>
      )}

      <div className="border-t border-neutral-800 p-4 space-y-2">
        <div className="border-b border-neutral-700 pb-2 flex justify-between text-xl">
          <span className="font-bold text-white">{t('totals.total')}</span>
          <span className="font-bold text-brand-500">{formatPrice(total)}</span>
        </div>
        {totalDiscount > 0 && (
          <div className="flex justify-between text-cockpit-attention-text text-sm font-semibold">
            <span>{t('totals.discount')}</span>
            <span>-{formatPrice(totalDiscount)}</span>
          </div>
        )}
        <div className="flex justify-between text-neutral-500 text-sm">
          <span>{t('totals.subtotalBeforeTax')}</span>
          <span>{formatPrice(subtotal)}</span>
        </div>
        <div className="flex justify-between text-neutral-500 text-sm">
          <span>{t('totals.taxIncluded', { label: TAX_LABEL })}</span>
          <span>{formatPrice(tax)}</span>
        </div>
        {cartDiscount && (
          <div className="mt-2 px-3 py-2 bg-cockpit-yellow/30 border border-cockpit-yellow rounded-lg flex items-center justify-between">
            <div className="flex-1 min-w-0">
              <p className="text-cockpit-attention-text font-bold text-xs">
                {cartDiscount.type === 'comp'
                  ? t('discount.compLabel')
                  : cartDiscount.type === 'percent'
                    ? t('discount.percentLabel', { value: cartDiscount.value })
                    : t('discount.amountLabel', { value: formatPrice(cartDiscount.value) })}
              </p>
              {cartDiscount.reason && (
                <p className="text-cockpit-attention-text/80 text-xs truncate">{cartDiscount.reason}</p>
              )}
            </div>
            <button
              onClick={onApplyCartDiscount}
              className="text-cockpit-attention-text hover:text-white text-xs font-bold ml-2"
            >
              {t('discount.edit')}
            </button>
          </div>
        )}
      </div>

      <div className="border-t border-neutral-800 p-4 space-y-3">
        {/* Fulfillment selector — kitchen needs to know if it's for here, to
            go, or delivery. Mirrors the kiosk selector; defaults to take-away. */}
        <div className="grid grid-cols-3 gap-2" role="group" aria-label={t('cart.fulfillmentLabel')}>
          <button
            type="button"
            onClick={() => onFulfillmentChange('to_go')}
            aria-pressed={fulfillment === 'to_go'}
            className={`py-2.5 text-sm font-bold rounded-lg transition-all touch-manipulation ${
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
            className={`py-2.5 text-sm font-bold rounded-lg transition-all touch-manipulation ${
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
            className={`py-2.5 text-sm font-bold rounded-lg transition-all touch-manipulation inline-flex items-center justify-center gap-1 ${
              fulfillment === 'delivery'
                ? 'bg-cockpit-green text-white'
                : 'bg-neutral-800 text-neutral-400 hover:bg-neutral-700'
            }`}
          >
            <Truck size={14} />
            {t('cart.delivery')}
          </button>
        </div>
        {fulfillment === 'delivery' && (
          <button
            type="button"
            onClick={onEditDelivery}
            className="w-full rounded-lg bg-cockpit-green/15 border border-cockpit-green/40 p-3 text-left inline-flex items-center gap-3 hover:bg-cockpit-green/20 transition-colors"
          >
            <Truck size={18} className="text-cockpit-in-text flex-shrink-0" />
            <div className="flex-1 min-w-0">
              {deliveryDraft ? (
                <>
                  <p className="text-xs font-bold text-neutral-400 uppercase">
                    {t('delivery.toAddress')} · {deliveryDraft.etaMin} min · {formatPrice(deliveryDraft.fee)}
                  </p>
                  <p className="text-sm font-bold text-white truncate">{deliveryDraft.address}</p>
                </>
              ) : (
                <>
                  <p className="text-xs font-bold text-neutral-400 uppercase">{t('delivery.setup')}</p>
                  <p className="text-sm font-bold text-cockpit-in-text">{t('delivery.tapToCapture')}</p>
                </>
              )}
            </div>
          </button>
        )}
        <button
          onClick={onShowPaymentModal}
          disabled={cart.length === 0}
          className="w-full py-4 bg-brand-600 text-white text-lg font-bold rounded-lg hover:bg-brand-700 disabled:bg-neutral-800 disabled:text-neutral-600 disabled:cursor-not-allowed transition-all touch-manipulation"
        >
          {t('totals.charge', { amount: formatPrice(total) })}
        </button>
        {/* Send-to-kitchen — for dine-in tabs the customer hasn't paid yet but
            the kitchen should start cooking. Mirrors the kiosk dine-in flow. */}
        <button
          onClick={onSendToKitchen}
          disabled={cart.length === 0}
          title={t('totals.sendToKitchenHint')}
          className="w-full py-3 bg-cockpit-attention text-neutral-900 text-sm font-bold rounded-lg hover:bg-cockpit-attention/90 disabled:bg-neutral-800 disabled:text-neutral-600 disabled:cursor-not-allowed transition-all touch-manipulation flex items-center justify-center gap-2"
        >
          <ClipboardList className="w-4 h-4" />
          {t('totals.sendToKitchen')}
        </button>
        <button
          onClick={onShowCustomerLookup}
          className={`w-full py-3 text-white text-sm font-bold rounded-lg transition-all touch-manipulation ${
            linkedCustomer ? 'bg-cockpit-blue/80 hover:bg-cockpit-blue/70' : 'bg-cockpit-blue hover:bg-cockpit-blue/90'
          }`}
        >
          {linkedCustomer ? t('loyalty.loyaltyCustomer', { name: linkedCustomer.name }) : t('loyalty.loyaltyProgram')}
        </button>
        <button
          onClick={onShowParkedCarts}
          disabled={cart.length === 0 && parkedCount === 0}
          className="w-full py-3 bg-cockpit-blue text-white text-sm font-bold rounded-lg hover:bg-cockpit-blue/90 disabled:bg-neutral-800 disabled:text-neutral-600 disabled:cursor-not-allowed transition-all touch-manipulation flex items-center justify-center gap-2"
        >
          <PauseCircle className="w-4 h-4" />
          {parkedCount > 0
            ? t('parkedCarts.buttonWithCount', { count: parkedCount })
            : t('parkedCarts.button')}
        </button>
        <div className="flex gap-2">
          <button
            onClick={onShowTemplates}
            className="flex-1 py-3 bg-cockpit-green text-white text-sm font-bold rounded-lg hover:bg-cockpit-green/90 transition-all touch-manipulation flex items-center justify-center gap-1"
          >
            <ClipboardList className="w-4 h-4" />
            {t('quickOrders.title')}
          </button>
          <button
            onClick={onShowComboBuilder}
            className="flex-1 py-3 bg-cockpit-yellow text-neutral-900 text-sm font-bold rounded-lg hover:bg-cockpit-yellow/90 transition-all touch-manipulation"
          >
            {t('actions.combos')}
          </button>
          <button
            onClick={onShowSplitPayment}
            disabled={cart.length === 0}
            className="flex-1 py-3 bg-cockpit-blue text-white text-sm font-bold rounded-lg hover:bg-cockpit-blue/90 disabled:bg-neutral-800 disabled:text-neutral-600 transition-all touch-manipulation"
          >
            {t('actions.splitPay')}
          </button>
        </div>
        <button
          onClick={onApplyCartDiscount}
          disabled={cart.length === 0}
          className="w-full py-3 bg-cockpit-yellow text-neutral-900 text-sm font-bold rounded-lg hover:bg-cockpit-yellow/90 disabled:bg-neutral-800 disabled:text-neutral-600 disabled:cursor-not-allowed transition-all touch-manipulation flex items-center justify-center gap-2"
        >
          <Percent className="w-4 h-4" />
          {cartDiscount ? t('discount.modify') : t('discount.applyToOrder')}
        </button>
        <button
          onClick={onClearCart}
          disabled={cart.length === 0}
          className="w-full py-3 text-brand-500 text-lg font-bold hover:text-brand-400 hover:bg-neutral-800 disabled:text-neutral-700 transition-all rounded-lg"
        >
          {t('totals.clearOrder')}
        </button>
        <button
          onClick={onLogout}
          className="w-full py-3 bg-neutral-800 text-neutral-400 text-sm font-bold rounded hover:bg-neutral-700 transition-all border border-neutral-700"
        >
          {t('common:buttons.logout')}
        </button>
      </div>
    </div>
  );
}
