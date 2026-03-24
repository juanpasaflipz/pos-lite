import React from 'react';
import { useTranslation } from 'react-i18next';
import { ClipboardList } from 'lucide-react';
import { CartItem, Order, LoyaltyCustomer, ComboDefinition } from '../../types';
import { formatPrice, TAX_LABEL } from '../../utils/currency';
import { formatTime } from '../../utils/dateFormat';

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
  onRemoveFromCart: (cartId: string) => void;
  onUpdateQuantity: (cartId: string, quantity: number) => void;
  onSetNotesItem: (item: CartItem) => void;
  onShowPaymentModal: () => void;
  onShowCustomerLookup: () => void;
  onShowTemplates: () => void;
  onShowComboBuilder: () => void;
  onShowSplitPayment: () => void;
  onClearCart: () => void;
  onLogout: () => void;
  onConvertToCombo: () => void;
  onCobrar: (order: Order) => void;
  onToggleUnpaidOrders: () => void;
  onUnlinkCustomer: () => void;
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
  onRemoveFromCart,
  onUpdateQuantity,
  onSetNotesItem,
  onShowPaymentModal,
  onShowCustomerLookup,
  onShowTemplates,
  onShowComboBuilder,
  onShowSplitPayment,
  onClearCart,
  onLogout,
  onConvertToCombo,
  onCobrar,
  onToggleUnpaidOrders,
  onUnlinkCustomer,
}: CartPanelProps) {
  const { t } = useTranslation('pos');

  return (
    <div className="hidden lg:flex w-96 bg-neutral-900 border-l border-neutral-800 flex-col">
      <div className="bg-brand-600 text-white p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xl font-bold">{t('cart.orderNumber', { number: '1001' })}</p>
            <p className="text-sm text-brand-200">{formatTime(new Date())}</p>
          </div>
        </div>
        {linkedCustomer && (
          <div className="mt-2 flex items-center justify-between bg-brand-700/50 rounded-lg px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold">{linkedCustomer.name}</span>
              {linkedCustomer.activeCard && (
                <span className="text-xs bg-purple-600 px-2 py-0.5 rounded-full">
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

      {/* Unpaid orders banner */}
      {unpaidOrders.length > 0 && (
        <div className="border-b border-neutral-800">
          <button
            onClick={onToggleUnpaidOrders}
            className="w-full flex items-center justify-between px-4 py-3 bg-amber-900/30 hover:bg-amber-900/40 transition-all"
          >
            <div className="flex items-center gap-2">
              <span className="bg-amber-600 text-white text-xs font-bold px-2 py-0.5 rounded-full">
                {unpaidOrders.length}
              </span>
              <span className="text-amber-200 font-bold text-sm">{t('cart.unpaidOrders')}</span>
            </div>
            <span className="text-amber-400 text-xs">{showUnpaidOrders ? '\u25B2' : '\u25BC'}</span>
          </button>
          {showUnpaidOrders && (
            <div className="px-4 pb-3 space-y-2 max-h-48 overflow-y-auto">
              {unpaidOrders.map((order) => (
                <div
                  key={order.id}
                  className="flex items-center justify-between bg-neutral-800 rounded-lg px-3 py-2 border border-neutral-700"
                >
                  <div>
                    <p className="text-white font-bold text-sm">#{order.order_number}</p>
                    <p className="text-neutral-400 text-xs">{formatPrice(order.total)}</p>
                  </div>
                  <button
                    onClick={() => onCobrar(order)}
                    className="px-3 py-1.5 bg-brand-600 text-white text-xs font-bold rounded-lg hover:bg-brand-700 transition-all"
                  >
                    {t('cart.charge')}
                  </button>
                </div>
              ))}
            </div>
          )}
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
                      ? 'bg-amber-900/20 border-amber-700'
                      : 'bg-amber-900/10 border-amber-800/50 ml-4'
                    : 'bg-neutral-800 border-neutral-700'
                }`}
              >
                {isFirstComboItem && (
                  <p className="text-xs font-bold text-amber-400 mb-1 uppercase tracking-wider">{t('cart.combo')}</p>
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

                {!isComboItem && !item.selectedModifierIds?.length && (
                  <button
                    onClick={() => onSetNotesItem(item)}
                    className="w-full py-2 text-sm bg-neutral-700 text-neutral-300 rounded hover:bg-neutral-600 transition-all font-semibold"
                  >
                    {t('cart.addNotes')}
                  </button>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Combo Detection Banner */}
      {comboSuggestion && (
        <div className="mx-4 mb-2 bg-amber-900/30 border border-amber-600 rounded-lg p-3">
          <p className="text-amber-400 font-bold text-sm">{t('comboDetection.title')}</p>
          <p className="text-amber-200 text-xs mt-1">
            {t('comboDetection.message', { name: comboSuggestion.combo.name, savings: formatPrice(comboSuggestion.savings) })}
          </p>
          <button
            onClick={onConvertToCombo}
            className="mt-2 w-full py-2 bg-amber-600 text-white text-sm font-bold rounded-lg hover:bg-amber-700 transition-all"
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
        <div className="flex justify-between text-neutral-500 text-sm">
          <span>{t('totals.subtotalBeforeTax')}</span>
          <span>{formatPrice(subtotal)}</span>
        </div>
        <div className="flex justify-between text-neutral-500 text-sm">
          <span>{t('totals.taxIncluded', { label: TAX_LABEL })}</span>
          <span>{formatPrice(tax)}</span>
        </div>
      </div>

      <div className="border-t border-neutral-800 p-4 space-y-3">
        <button
          onClick={onShowPaymentModal}
          disabled={cart.length === 0}
          className="w-full py-4 bg-brand-600 text-white text-lg font-bold rounded-lg hover:bg-brand-700 disabled:bg-neutral-800 disabled:text-neutral-600 disabled:cursor-not-allowed transition-all touch-manipulation"
        >
          {t('totals.charge', { amount: formatPrice(total) })}
        </button>
        <button
          onClick={onShowCustomerLookup}
          className={`w-full py-3 text-white text-sm font-bold rounded-lg transition-all touch-manipulation ${
            linkedCustomer ? 'bg-purple-700 hover:bg-purple-800' : 'bg-purple-600 hover:bg-purple-700'
          }`}
        >
          {linkedCustomer ? t('loyalty.loyaltyCustomer', { name: linkedCustomer.name }) : t('loyalty.loyaltyProgram')}
        </button>
        <div className="flex gap-2">
          <button
            onClick={onShowTemplates}
            className="flex-1 py-3 bg-emerald-600 text-white text-sm font-bold rounded-lg hover:bg-emerald-700 transition-all touch-manipulation flex items-center justify-center gap-1"
          >
            <ClipboardList className="w-4 h-4" />
            {t('quickOrders.title')}
          </button>
          <button
            onClick={onShowComboBuilder}
            className="flex-1 py-3 bg-amber-600 text-white text-sm font-bold rounded-lg hover:bg-amber-700 transition-all touch-manipulation"
          >
            {t('actions.combos')}
          </button>
          <button
            onClick={onShowSplitPayment}
            disabled={cart.length === 0}
            className="flex-1 py-3 bg-blue-600 text-white text-sm font-bold rounded-lg hover:bg-blue-700 disabled:bg-neutral-800 disabled:text-neutral-600 transition-all touch-manipulation"
          >
            {t('actions.splitPay')}
          </button>
        </div>
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
