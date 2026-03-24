import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { CartItem, LoyaltyCustomer, ComboDefinition } from '../types';
import { formatPrice, TAX_RATE, TAX_LABEL } from '../utils/currency';
import { formatTime } from '../utils/dateFormat';
import { ClipboardList, X } from 'lucide-react';

interface CartDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  cart: CartItem[];
  linkedCustomer: LoyaltyCustomer | null;
  onUnlinkCustomer: () => void;
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
  comboSuggestion: { combo: ComboDefinition; matchedItems: CartItem[]; savings: number } | null;
  onConvertToCombo: () => void;
  total: number;
  subtotal: number;
  tax: number;
}

const CartDrawer: React.FC<CartDrawerProps> = ({
  isOpen,
  onClose,
  cart,
  linkedCustomer,
  onUnlinkCustomer,
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
  comboSuggestion,
  onConvertToCombo,
  total,
  subtotal,
  tax,
}) => {
  const { t } = useTranslation('pos');

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
          <div className="flex items-center justify-between">
            <div>
              <p className="text-lg font-bold">{t('cart.orderNumber', { number: '1001' })}</p>
              <p className="text-xs text-brand-200">{formatTime(new Date())}</p>
            </div>
            <button onClick={onClose} className="text-brand-200 hover:text-white p-1">
              <X className="w-5 h-5" />
            </button>
          </div>
          {linkedCustomer && (
            <div className="mt-2 flex items-center justify-between bg-brand-700/50 rounded-lg px-3 py-1.5">
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold">{linkedCustomer.name}</span>
                {linkedCustomer.activeCard && (
                  <span className="text-xs bg-purple-600 px-2 py-0.5 rounded-full">
                    {linkedCustomer.activeCard.stamps_earned}/{linkedCustomer.activeCard.stamps_required}
                  </span>
                )}
              </div>
              <button onClick={onUnlinkCustomer} className="text-brand-200 hover:text-white text-xs font-bold">
                {t('cart.unlink')}
              </button>
            </div>
          )}
        </div>

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
                        ? 'bg-amber-900/20 border-amber-700'
                        : 'bg-amber-900/10 border-amber-800/50 ml-3'
                      : 'bg-neutral-800 border-neutral-700'
                  }`}
                >
                  {isFirstComboItem && (
                    <p className="text-xs font-bold text-amber-400 mb-1 uppercase tracking-wider">{t('cart.combo')}</p>
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
                  {!isComboItem && !item.selectedModifierIds?.length && (
                    <button
                      onClick={() => onSetNotesItem(item)}
                      className="w-full py-1.5 text-xs bg-neutral-700 text-neutral-300 rounded hover:bg-neutral-600 transition-all font-semibold"
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
          <div className="mx-3 mb-2 bg-amber-900/30 border border-amber-600 rounded-lg p-2.5">
            <p className="text-amber-400 font-bold text-xs">{t('comboDetection.title')}</p>
            <p className="text-amber-200 text-xs mt-0.5">
              {t('comboDetection.message', { name: comboSuggestion.combo.name, savings: formatPrice(comboSuggestion.savings) })}
            </p>
            <button
              onClick={onConvertToCombo}
              className="mt-1.5 w-full py-1.5 bg-amber-600 text-white text-xs font-bold rounded-lg hover:bg-amber-700 transition-all"
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
          <button
            onClick={onShowPaymentModal}
            disabled={cart.length === 0}
            className="w-full py-3 bg-brand-600 text-white text-base font-bold rounded-lg hover:bg-brand-700 disabled:bg-neutral-800 disabled:text-neutral-600 disabled:cursor-not-allowed transition-all touch-manipulation"
          >
            {t('totals.charge', { amount: formatPrice(total) })}
          </button>
          <button
            onClick={onShowCustomerLookup}
            className={`w-full py-2.5 text-white text-sm font-bold rounded-lg transition-all touch-manipulation ${
              linkedCustomer ? 'bg-purple-700 hover:bg-purple-800' : 'bg-purple-600 hover:bg-purple-700'
            }`}
          >
            {linkedCustomer ? t('loyalty.loyaltyCustomer', { name: linkedCustomer.name }) : t('loyalty.loyaltyProgram')}
          </button>
          <div className="flex gap-1.5">
            <button
              onClick={onShowTemplates}
              className="flex-1 py-2.5 bg-emerald-600 text-white text-xs font-bold rounded-lg hover:bg-emerald-700 transition-all touch-manipulation flex items-center justify-center gap-1"
            >
              <ClipboardList className="w-3.5 h-3.5" />
              {t('quickOrders.title')}
            </button>
            <button
              onClick={onShowComboBuilder}
              className="flex-1 py-2.5 bg-amber-600 text-white text-xs font-bold rounded-lg hover:bg-amber-700 transition-all touch-manipulation"
            >
              {t('actions.combos')}
            </button>
            <button
              onClick={onShowSplitPayment}
              disabled={cart.length === 0}
              className="flex-1 py-2.5 bg-blue-600 text-white text-xs font-bold rounded-lg hover:bg-blue-700 disabled:bg-neutral-800 disabled:text-neutral-600 transition-all touch-manipulation"
            >
              {t('actions.splitPay')}
            </button>
          </div>
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
