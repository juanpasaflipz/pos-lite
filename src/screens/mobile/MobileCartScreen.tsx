import React, { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Minus, Plus, Trash2 } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useMobileCart } from '../../context/MobileCartContext';
import { useNetworkStatus } from '../../hooks/useNetworkStatus';
import {
  createOrder,
  createPaymentIntent,
  confirmPayment,
  cashPayment,
} from '../../api';
import { createOfflineOrder, toReceiptOrder } from '../../lib/offlineOrderQueue';
import { formatPrice, TAX_LABEL } from '../../utils/currency';
import { tapFeedback, successFeedback, errorFeedback } from '../../lib/haptics';
import type { Order } from '../../types';

import MobileTipSelector from '../../components/mobile/MobileTipSelector';
import MobileCashPayment from '../../components/mobile/MobileCashPayment';
import MobileCardPayment from '../../components/mobile/MobileCardPayment';
import MobileReceiptShare from '../../components/mobile/MobileReceiptShare';

const MobileCartScreen: React.FC = () => {
  const navigate = useNavigate();
  const { currentEmployee } = useAuth();
  const { t } = useTranslation('pos');
  const { isOnline } = useNetworkStatus();
  const cart = useMobileCart();

  const [showCash, setShowCash] = useState(false);
  const [cardState, setCardState] = useState<'idle' | 'processing' | 'success' | 'error'>('idle');
  const [cardError, setCardError] = useState<string>();
  const [completedOrder, setCompletedOrder] = useState<Order | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  const buildOrderItems = useCallback(() =>
    cart.items.map((ci) => ({
      menu_item_id: ci.menu_item_id,
      quantity: ci.quantity,
      notes: ci.notes,
      modifiers: ci.selectedModifierIds || [],
      combo_instance_id: ci.combo_instance_id || null,
      virtual_brand_id: ci.virtual_brand_id || null,
    })),
  [cart.items]);

  /* ==================== Cash Payment ==================== */
  const handleCashConfirm = useCallback(async (amountReceived: number) => {
    if (!currentEmployee) return;
    setIsProcessing(true);
    try {
      if (!isOnline) {
        const offlineOrder = await createOfflineOrder(
          currentEmployee.id, currentEmployee.name, cart.items, cart.tip, amountReceived,
        );
        const receiptOrder = toReceiptOrder(offlineOrder);
        setCompletedOrder(receiptOrder);
      } else {
        const order = await createOrder({ employee_id: currentEmployee.id, items: buildOrderItems() });
        await cashPayment({ order_id: order.id, tip: cart.tip, amount_received: amountReceived });
        const finalOrder: Order = {
          ...order,
          tip: cart.tip,
          total: order.total + cart.tip,
          payment_method: 'cash',
          employee_name: currentEmployee.name,
        };
        setCompletedOrder(finalOrder);
      }
      successFeedback();
      setShowCash(false);
      cart.clearCart();
    } catch (err) {
      errorFeedback();
    } finally {
      setIsProcessing(false);
    }
  }, [currentEmployee, isOnline, cart, buildOrderItems]);

  /* ==================== Card Payment ==================== */
  const handleCardPayment = useCallback(async () => {
    if (!currentEmployee || !isOnline) return;
    setCardState('processing');
    try {
      const order = await createOrder({ employee_id: currentEmployee.id, items: buildOrderItems() });
      const pi = await createPaymentIntent({ order_id: order.id, tip: cart.tip });
      await confirmPayment({ order_id: order.id, payment_intent_id: pi.payment_intent_id });
      const finalOrder: Order = {
        ...order,
        tip: cart.tip,
        total: order.total + cart.tip,
        payment_method: 'card',
        employee_name: currentEmployee.name,
      };
      setCardState('success');
      successFeedback();
      setCompletedOrder(finalOrder);
      cart.clearCart();
    } catch (err) {
      errorFeedback();
      setCardError(err instanceof Error ? err.message : t('mobilePOS.paymentFailed'));
      setCardState('error');
    }
  }, [currentEmployee, isOnline, cart, buildOrderItems, t]);

  /* ==================== Receipt handlers ==================== */
  const handleNewOrder = useCallback(() => {
    setCompletedOrder(null);
    navigate('/m/pos');
  }, [navigate]);

  const handleDone = useCallback(() => {
    setCompletedOrder(null);
    navigate('/m/pos');
  }, [navigate]);

  /* ==================== Receipt view ==================== */
  if (completedOrder) {
    return (
      <MobileReceiptShare
        order={completedOrder}
        onNewOrder={handleNewOrder}
        onDone={handleDone}
      />
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 pt-3 pb-2">
        <button
          onClick={() => navigate('/m/pos')}
          className="p-2 text-neutral-400 touch-manipulation"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h1 className="text-lg font-bold text-white">{t('mobilePOS.viewCart')}</h1>
        <span className="text-neutral-500 text-sm ml-auto">
          {t('mobilePOS.items', { count: cart.itemCount })}
        </span>
      </div>

      {/* Cart items */}
      <div className="flex-1 overflow-y-auto px-4 pb-4">
        {cart.items.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 text-center">
            <p className="text-neutral-500 font-semibold">{t('mobilePOS.cartEmpty')}</p>
            <p className="text-neutral-600 text-sm mt-1">{t('mobilePOS.cartEmptyHint')}</p>
          </div>
        ) : (
          <div className="space-y-2">
            {cart.items.map((item) => (
              <div key={item.cart_id} className="bg-neutral-800 rounded-xl p-3 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-white font-semibold text-sm truncate">{item.item_name}</p>
                  {item.selectedModifierNames?.length ? (
                    <p className="text-neutral-400 text-xs truncate">{item.selectedModifierNames.join(', ')}</p>
                  ) : null}
                  {item.notes && <p className="text-neutral-500 text-xs italic">{item.notes}</p>}
                  <p className="text-brand-400 text-sm font-bold mt-0.5">
                    {formatPrice(item.unit_price * item.quantity)}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => { tapFeedback(); cart.updateQuantity(item.cart_id, item.quantity - 1); }}
                    className="w-8 h-8 rounded-full bg-neutral-700 flex items-center justify-center text-white touch-manipulation"
                  >
                    <Minus className="w-3.5 h-3.5" />
                  </button>
                  <span className="text-white font-bold text-sm w-5 text-center">{item.quantity}</span>
                  <button
                    onClick={() => { tapFeedback(); cart.updateQuantity(item.cart_id, item.quantity + 1); }}
                    className="w-8 h-8 rounded-full bg-neutral-700 flex items-center justify-center text-white touch-manipulation"
                  >
                    <Plus className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => { tapFeedback(); cart.removeItem(item.cart_id); }}
                    className="w-8 h-8 rounded-full bg-red-600/20 flex items-center justify-center text-red-400 touch-manipulation ml-1"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Order summary + Payment */}
      {cart.items.length > 0 && (
        <div className="border-t border-neutral-800 bg-neutral-900 px-4 pt-4 pb-4" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 5rem)' }}>
          {/* Tip selector */}
          <div className="mb-3">
            <p className="text-neutral-400 text-sm font-semibold mb-2">{t('mobilePOS.tipLabel')}</p>
            <MobileTipSelector selected={cart.tipPercent} onSelect={cart.setTip} />
          </div>

          {/* Totals */}
          <div className="space-y-1 mb-4">
            <div className="flex justify-between text-sm">
              <span className="text-neutral-400">{t('mobilePOS.subtotal')}</span>
              <span className="text-neutral-300">{formatPrice(cart.subtotal)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-neutral-400">{t('mobilePOS.taxIncluded')}</span>
              <span className="text-neutral-300">{formatPrice(cart.tax)}</span>
            </div>
            {cart.tip > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-neutral-400">{t('mobilePOS.tipLabel')}</span>
                <span className="text-neutral-300">{formatPrice(cart.tip)}</span>
              </div>
            )}
            <div className="flex justify-between text-base font-bold pt-1">
              <span className="text-white">{cart.tip > 0 ? t('mobilePOS.totalWithTip') : t('mobilePOS.total')}</span>
              <span className="text-white">{formatPrice(cart.totalWithTip)}</span>
            </div>
          </div>

          {/* Payment buttons */}
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => { tapFeedback(); setShowCash(true); }}
              className="py-3.5 bg-green-600 text-white font-semibold rounded-2xl text-sm active:bg-green-700 touch-manipulation"
            >
              {t('mobilePOS.payWithCash')}
            </button>
            <button
              onClick={() => { tapFeedback(); handleCardPayment(); }}
              disabled={!isOnline}
              className="py-3.5 bg-brand-600 text-white font-semibold rounded-2xl text-sm active:bg-brand-700 disabled:bg-neutral-700 disabled:text-neutral-500 touch-manipulation"
            >
              {t('mobilePOS.payWithCard')}
            </button>
          </div>
          {!isOnline && (
            <p className="text-amber-400 text-xs text-center mt-2">{t('offline.cashOnly')}</p>
          )}
        </div>
      )}

      {/* Cash payment sheet */}
      {showCash && (
        <MobileCashPayment
          total={cart.totalWithTip}
          onConfirm={handleCashConfirm}
          onClose={() => setShowCash(false)}
          isProcessing={isProcessing}
        />
      )}

      {/* Card payment overlay */}
      {cardState !== 'idle' && (
        <MobileCardPayment
          state={cardState as 'processing' | 'success' | 'error'}
          onRetry={() => { setCardState('idle'); handleCardPayment(); }}
          onClose={() => setCardState('idle')}
          errorMessage={cardError}
        />
      )}
    </div>
  );
};

export default MobileCartScreen;
