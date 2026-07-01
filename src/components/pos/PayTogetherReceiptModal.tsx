import React, { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { formatPrice, TAX_LABEL } from '../../utils/currency';
import { formatDateTime } from '../../utils/dateFormat';
import { getPaymentGroup, type PaymentGroupDetail } from '../../api';
import BrandLogo from '../BrandLogo';
import { useBranding } from '../../context/BrandingContext';

interface PayTogetherReceiptModalProps {
  paymentGroupId: number;
  onClose: () => void;
}

const PayTogetherReceiptModal: React.FC<PayTogetherReceiptModalProps> = ({ paymentGroupId, onClose }) => {
  const { t } = useTranslation('pos');
  const { branding } = useBranding();
  const [detail, setDetail] = useState<PaymentGroupDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getPaymentGroup(paymentGroupId)
      .then((d) => { if (!cancelled) setDetail(d); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : 'Error'); });
    return () => { cancelled = true; };
  }, [paymentGroupId]);

  const handlePrint = useCallback(() => { window.print(); }, []);

  if (error) {
    return (
      <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
        <div className="bg-white rounded-2xl p-6 max-w-sm">
          <p className="text-cockpit-out-text font-bold mb-4">{error}</p>
          <button onClick={onClose} className="w-full py-3 bg-neutral-800 text-white font-bold rounded-lg">
            {t('common:buttons.close', { defaultValue: 'Cerrar' })}
          </button>
        </div>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
        <div className="bg-white rounded-2xl p-6 max-w-sm">
          <p>{t('common:loading', { defaultValue: 'Cargando…' })}</p>
        </div>
      </div>
    );
  }

  const { group, orders } = detail;

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm max-h-[90vh] overflow-auto">
        <div className="p-6 text-center border-b-2 border-gray-300">
          <BrandLogo className="h-12 mx-auto mb-2" />
          <h2 className="text-2xl font-black tracking-tighter text-neutral-900 mb-1">
            {branding?.restaurantName || 'Desktop Kitchen'}
          </h2>
          {branding?.tagline && <p className="text-neutral-600">{branding.tagline}</p>}
          {branding?.address && <p className="text-sm text-neutral-500 mt-2">{branding.address}</p>}
        </div>

        <div className="p-4 space-y-3 text-sm">
          <div className="text-center border-b pb-2">
            <p className="font-bold text-base">
              {t('receipt.combinedTitle', { defaultValue: 'Cobro Conjunto' })} #{group.id}
            </p>
            <p className="text-neutral-600">{formatDateTime(new Date(group.paid_at || group.created_at))}</p>
            <p className="text-neutral-500 text-xs">
              {orders.length} {t('receipt.tickets', { defaultValue: 'pedidos' })}
            </p>
          </div>

          {orders.map((o) => (
            <div key={o.id} className="border-b pb-2">
              <div className="flex justify-between items-baseline mb-1">
                <p className="font-bold">
                  #{o.order_number}
                  {o.customer_call_name && <span className="text-neutral-500 font-normal"> · {o.customer_call_name}</span>}
                </p>
                <p className="font-mono text-neutral-700">{formatPrice(o.total)}</p>
              </div>
              <div className="space-y-0.5">
                {o.items.map((it, i) => (
                  <div key={i} className="flex justify-between text-xs text-neutral-700">
                    <span>{it.quantity}× {it.item_name}</span>
                    <span className="font-mono">{formatPrice(it.unit_price * it.quantity)}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}

          <div className="space-y-1 border-b pb-2">
            <div className="flex justify-between text-neutral-600">
              <p>{t('receipt.subtotalBeforeTax')}</p>
              <p className="font-mono">{formatPrice(group.subtotal)}</p>
            </div>
            <div className="flex justify-between text-neutral-600">
              <p>{t('receipt.taxIncluded', { label: TAX_LABEL })}</p>
              <p className="font-mono">{formatPrice(group.tax)}</p>
            </div>
            {Number(group.tip) > 0 && (
              <div className="flex justify-between text-neutral-700">
                <p>{t('receipt.tip')}</p>
                <p className="font-mono font-semibold">{formatPrice(group.tip)}</p>
              </div>
            )}
          </div>

          <div className="flex justify-between items-baseline font-black text-lg">
            <p>{t('totals.total')}</p>
            <p className="font-mono">{formatPrice(group.total)}</p>
          </div>

          <div className="text-center py-2 border-t pt-2">
            <p className="text-neutral-500 text-xs">
              {group.payment_method === 'cash'
                ? t('receipt.paidCash', { defaultValue: 'Pagado en efectivo' })
                : t('receipt.paidCard', { defaultValue: 'Pagado con tarjeta' })}
            </p>
            <p className="text-brand-600 font-bold mt-1">{t('receipt.thankYou')}</p>
          </div>
        </div>

        <div className="p-4 space-y-2 border-t">
          <button
            onClick={handlePrint}
            className="w-full py-3 bg-neutral-800 text-white font-bold rounded-lg hover:bg-neutral-700 transition-all"
          >
            {t('receipt.printReceipt')}
          </button>
          <button
            onClick={onClose}
            className="w-full py-3 bg-neutral-200 text-neutral-800 font-bold rounded-lg hover:bg-neutral-300 transition-all"
          >
            {t('common:buttons.close', { defaultValue: 'Cerrar' })}
          </button>
        </div>
      </div>
    </div>
  );
};

export default PayTogetherReceiptModal;
