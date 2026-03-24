import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Share2, Copy, CheckCircle, Plus } from 'lucide-react';
import type { Order } from '../../types';
import { formatPrice } from '../../utils/currency';
import { successFeedback } from '../../lib/haptics';

interface Props {
  order: Order;
  onNewOrder: () => void;
  onDone: () => void;
}

const MobileReceiptShare: React.FC<Props> = ({ order, onNewOrder, onDone }) => {
  const { t } = useTranslation('pos');
  const [copied, setCopied] = useState(false);

  const buildReceiptText = useCallback(() => {
    const lines: string[] = [
      t('mobilePOS.orderNumber', { number: order.order_number }),
      `${t('mobilePOS.subtotal')}: ${formatPrice(order.subtotal)}`,
      `${t('mobilePOS.taxIncluded')}: ${formatPrice(order.tax)}`,
    ];
    if (order.tip > 0) {
      lines.push(`${t('mobilePOS.tipLabel')}: ${formatPrice(order.tip)}`);
    }
    lines.push(`${t('mobilePOS.total')}: ${formatPrice(order.total)}`);
    if (order.items?.length) {
      lines.push('');
      for (const item of order.items) {
        lines.push(`${item.quantity}x ${item.item_name} - ${formatPrice(item.unit_price * item.quantity)}`);
      }
    }
    return lines.join('\n');
  }, [order, t]);

  const handleShare = async () => {
    const text = buildReceiptText();
    if (navigator.share) {
      try {
        await navigator.share({ title: t('mobilePOS.orderNumber', { number: order.order_number }), text });
      } catch {
        // user cancelled
      }
    } else {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      successFeedback();
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end" onClick={onDone}>
      <div className="absolute inset-0 bg-black/60" />
      <div className="relative bg-neutral-900 rounded-t-3xl flex flex-col animate-slide-up" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-center pt-3 pb-1">
          <div className="w-10 h-1 rounded-full bg-neutral-700" />
        </div>

        {/* Success icon */}
        <div className="flex flex-col items-center pt-4 pb-2">
          <CheckCircle className="w-16 h-16 text-green-500 mb-2" />
          <h2 className="text-xl font-bold text-white">{t('mobilePOS.orderComplete')}</h2>
          <p className="text-neutral-400 text-sm mt-1">
            {t('mobilePOS.orderNumber', { number: order.order_number })}
          </p>
        </div>

        {/* Order summary */}
        <div className="mx-4 my-3 bg-neutral-800 rounded-2xl p-4 space-y-2">
          {order.items?.map((item, idx) => (
            <div key={idx} className="flex justify-between text-sm">
              <span className="text-neutral-300">{item.quantity}x {item.item_name}</span>
              <span className="text-neutral-400">{formatPrice(item.unit_price * item.quantity)}</span>
            </div>
          ))}
          <div className="border-t border-neutral-700 pt-2 mt-2">
            <div className="flex justify-between text-sm">
              <span className="text-neutral-400">{t('mobilePOS.subtotal')}</span>
              <span className="text-neutral-300">{formatPrice(order.subtotal)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-neutral-400">{t('mobilePOS.taxIncluded')}</span>
              <span className="text-neutral-300">{formatPrice(order.tax)}</span>
            </div>
            {order.tip > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-neutral-400">{t('mobilePOS.tipLabel')}</span>
                <span className="text-neutral-300">{formatPrice(order.tip)}</span>
              </div>
            )}
            <div className="flex justify-between text-base font-bold mt-1">
              <span className="text-white">{t('mobilePOS.total')}</span>
              <span className="text-white">{formatPrice(order.total)}</span>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="px-4 pb-4 space-y-2" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 1rem)' }}>
          <button
            onClick={handleShare}
            className="w-full py-3.5 bg-neutral-800 text-white font-semibold rounded-2xl flex items-center justify-center gap-2 touch-manipulation active:bg-neutral-700"
          >
            {copied ? (
              <>
                <CheckCircle className="w-5 h-5 text-green-500" />
                {t('mobilePOS.copyReceipt')}
              </>
            ) : (
              <>
                {navigator.share ? <Share2 className="w-5 h-5" /> : <Copy className="w-5 h-5" />}
                {t('mobilePOS.shareReceipt')}
              </>
            )}
          </button>

          <button
            onClick={onNewOrder}
            className="w-full py-3.5 bg-brand-600 text-white font-semibold rounded-2xl flex items-center justify-center gap-2 touch-manipulation active:bg-brand-700"
          >
            <Plus className="w-5 h-5" />
            {t('mobilePOS.newOrder')}
          </button>
        </div>
      </div>

      <style>{`
        @keyframes slide-up {
          from { transform: translateY(100%); }
          to { transform: translateY(0); }
        }
        .animate-slide-up {
          animation: slide-up 0.25s ease-out;
        }
      `}</style>
    </div>
  );
};

export default MobileReceiptShare;
