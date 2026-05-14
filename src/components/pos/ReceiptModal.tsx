import React, { useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { QRCodeSVG } from 'qrcode.react';
import { Clock } from 'lucide-react';
import { Order, CfdiInvoice, LoyaltyCustomer } from '../../types';
import { formatPrice, TAX_LABEL } from '../../utils/currency';
import { formatDateTime } from '../../utils/dateFormat';
import { sendSmsReceipt, lookupLoyaltyCustomer } from '../../api';
import BrandLogo from '../BrandLogo';
import { useBranding } from '../../context/BrandingContext';

const InvoiceModal = React.lazy(() => import('./InvoiceModal'));

export interface ReceiptModalProps {
  order: Order;
  onClose: () => void;
  onPrint: () => void;
  linkedCustomer?: LoyaltyCustomer | null;
}

const ReceiptModal: React.FC<ReceiptModalProps> = ({ order, onClose, onPrint, linkedCustomer = null }) => {
  const { t } = useTranslation('pos');
  const { branding } = useBranding();
  const [showInvoiceModal, setShowInvoiceModal] = useState(false);
  const [invoiceIssued, setInvoiceIssued] = useState(false);
  const [showSmsForm, setShowSmsForm] = useState(false);
  const [smsPhone, setSmsPhone] = useState(linkedCustomer?.phone || '');
  const [smsName, setSmsName] = useState(linkedCustomer?.name || '');
  const [enrollLoyalty, setEnrollLoyalty] = useState(true);
  const [smsState, setSmsState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [smsError, setSmsError] = useState<string | null>(null);
  const [foundCustomer, setFoundCustomer] = useState<LoyaltyCustomer | null>(null);

  // The effective customer: either passed in from POSScreen (order-start lookup)
  // or discovered live as the merchant types a known phone into the SMS form.
  const recognizedCustomer = linkedCustomer || foundCustomer;

  // Debounced phone-to-customer lookup. Triggers once the merchant has typed at
  // least 10 digits; clears on shorter input. Cancels in-flight requests via
  // the local `cancelled` flag so a fast typist doesn't stomp results.
  useEffect(() => {
    if (linkedCustomer) return; // already recognized — skip live lookup
    const digits = smsPhone.replace(/\D/g, '');
    if (digits.length < 10) {
      setFoundCustomer(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      lookupLoyaltyCustomer(smsPhone)
        .then((c) => {
          if (cancelled) return;
          setFoundCustomer(c);
          setSmsName(c.name);
        })
        .catch(() => {
          if (cancelled) return;
          setFoundCustomer(null);
        });
    }, 500);
    return () => { cancelled = true; clearTimeout(t); };
  }, [smsPhone, linkedCustomer]);

  const appUrl = (window.location.origin + '/#/invoice/');
  const invoiceUrl = order.invoice_token ? `${appUrl}${order.invoice_token}` : null;

  const handleSendSms = useCallback(async () => {
    const phone = smsPhone.trim();
    if (!phone) return;
    setSmsState('sending');
    setSmsError(null);
    try {
      await sendSmsReceipt(order.id, phone, 'MX', {
        enroll_loyalty: enrollLoyalty,
        customer_name: smsName.trim() || undefined,
      });
      setSmsState('sent');
      setTimeout(() => {
        setShowSmsForm(false);
        setSmsPhone('');
        setSmsName('');
        setSmsState('idle');
      }, 1800);
    } catch (err) {
      setSmsState('error');
      setSmsError(err instanceof Error ? err.message : 'No pudimos enviar el SMS');
    }
  }, [smsPhone, smsName, enrollLoyalty, order.id]);

  const handleInvoiceIssued = useCallback((_invoice: CfdiInvoice) => {
    setInvoiceIssued(true);
    setShowInvoiceModal(false);
  }, []);

  return (
    <>
      <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm max-h-[90vh] overflow-auto">
          <div className="p-6 text-center border-b-2 border-gray-300">
            <BrandLogo className="h-12 mx-auto mb-2" />
            <h2 className="text-2xl font-black tracking-tighter text-neutral-900 mb-1">{branding?.restaurantName || 'Desktop Kitchen'}</h2>
            {branding?.tagline && (
              <p className="text-neutral-600">{branding.tagline}</p>
            )}
            {branding?.address && (
              <p className="text-sm text-neutral-500 mt-2">
                {branding.address}
              </p>
            )}
          </div>

          <div className="p-6 space-y-4 text-sm">
            <div className="text-center border-b pb-3">
              <p className="font-bold text-lg">{t('receipt.orderNumber', { number: order.order_number })}</p>
              {String(order.order_number).startsWith('OFF-') && (
                <span className="inline-block mt-1 px-2 py-0.5 bg-amber-100 text-amber-800 text-xs font-bold rounded">
                  {t('receipt.offlineBadge')}
                </span>
              )}
              <p className="text-neutral-600">
                {formatDateTime(order.created_at ? new Date(order.created_at) : new Date())}
              </p>
              {order.employee_name && (
                <p className="text-neutral-600">{t('receipt.cashier', { name: order.employee_name })}</p>
              )}
            </div>

            {/* Estimated Ready Time */}
            {order.estimated_ready_range && (
              <div className="flex items-center justify-center gap-2 py-3 px-4 bg-amber-50 border border-amber-200 rounded-lg">
                <Clock className="w-5 h-5 text-amber-600 flex-shrink-0" />
                <div className="text-center">
                  <p className="text-amber-800 font-bold text-lg">
                    {t('receipt.estimatedReady', {
                      low: order.estimated_ready_range.low,
                      high: order.estimated_ready_range.high,
                    })}
                  </p>
                  <p className="text-amber-600 text-xs">{t('receipt.orderBeingPrepared')}</p>
                </div>
              </div>
            )}

            <div className="space-y-2 border-b pb-3">
              {order.items?.map((item) => (
                <div key={item.id || item.menu_item_id} className="flex justify-between">
                  <div className="flex-1">
                    <p className="font-semibold">{item.item_name}</p>
                    {item.notes && (
                      <p className="text-neutral-600 text-xs">{item.notes}</p>
                    )}
                  </div>
                  <div className="text-right">
                    <p>{item.quantity}x {formatPrice(item.unit_price)}</p>
                  </div>
                </div>
              ))}
            </div>

            <div className="space-y-2 border-b pb-3">
              <div className="flex justify-between font-bold text-lg">
                <p>{t('totals.total')}</p>
                <p>{formatPrice(order.total)}</p>
              </div>
              <div className="flex justify-between text-neutral-500 text-sm">
                <p>{t('receipt.subtotalBeforeTax')}</p>
                <p>{formatPrice(order.subtotal)}</p>
              </div>
              <div className="flex justify-between text-neutral-500 text-sm">
                <p>{t('receipt.taxIncluded', { label: TAX_LABEL })}</p>
                <p>{formatPrice(order.tax)}</p>
              </div>
              {order.tip > 0 && (
                <div className="flex justify-between">
                  <p>{t('receipt.tip')}</p>
                  <p className="font-semibold">{formatPrice(order.tip)}</p>
                </div>
              )}
            </div>

            {order.tip > 0 && (
              <div className="text-center py-3">
                <p className="text-2xl font-bold text-neutral-900">
                  {t('receipt.totalWithTip', { amount: formatPrice(order.total + (order.tip || 0)) })}
                </p>
              </div>
            )}

            {/* Invoice QR Code */}
            {invoiceUrl && !invoiceIssued && (
              <div className="text-center py-3 border-t pt-3">
                <QRCodeSVG value={invoiceUrl} size={120} className="mx-auto" />
                <p className="text-xs text-neutral-500 mt-2">{t('receipt.scanForInvoice')}</p>
              </div>
            )}

            {invoiceIssued && (
              <div className="text-center py-2 bg-green-50 rounded-lg">
                <p className="text-green-700 text-sm font-semibold">{t('receipt.invoiceIssued')}</p>
              </div>
            )}

            <div className="text-center py-3 border-t pt-3">
              <p className="text-lg font-bold text-brand-600">{t('receipt.thankYou')}</p>
              <p className="text-neutral-600 text-xs mt-2">{t('receipt.comeAgain')}</p>
            </div>
          </div>

          <div className="p-4 space-y-2 border-t">
            <button
              onClick={onPrint}
              className="w-full py-3 bg-neutral-800 text-white font-bold rounded-lg hover:bg-neutral-700 transition-all"
            >
              {t('receipt.printReceipt')}
            </button>
            {!showSmsForm ? (
              <button
                onClick={() => setShowSmsForm(true)}
                className="w-full py-3 bg-green-600 text-white font-bold rounded-lg hover:bg-green-700 transition-all"
              >
                {recognizedCustomer ? `Enviar recibo a ${recognizedCustomer.name}` : 'Enviar recibo por SMS'}
              </button>
            ) : (
              <div className="space-y-2 p-3 bg-neutral-50 rounded-lg border border-neutral-200">
                {recognizedCustomer && (
                  <div className="flex items-center gap-2 text-xs text-green-700 bg-green-50 border border-green-200 rounded-md px-2 py-1">
                    <span>✓ Cliente reconocido — {recognizedCustomer.name}</span>
                  </div>
                )}
                <input
                  type="tel"
                  inputMode="tel"
                  autoFocus={!recognizedCustomer}
                  placeholder="Teléfono (ej. 5629152086)"
                  value={smsPhone}
                  onChange={(e) => setSmsPhone(e.target.value)}
                  disabled={smsState === 'sending' || smsState === 'sent'}
                  className="w-full px-3 py-2 border border-neutral-300 rounded-lg text-neutral-900 placeholder:text-neutral-400"
                />
                {enrollLoyalty && !recognizedCustomer && (
                  <input
                    type="text"
                    placeholder="Nombre del cliente (opcional)"
                    value={smsName}
                    onChange={(e) => setSmsName(e.target.value)}
                    disabled={smsState === 'sending' || smsState === 'sent'}
                    className="w-full px-3 py-2 border border-neutral-300 rounded-lg text-neutral-900 placeholder:text-neutral-400"
                  />
                )}
                {!recognizedCustomer && (
                  <label className="flex items-center gap-2 text-sm text-neutral-700 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={enrollLoyalty}
                      onChange={(e) => setEnrollLoyalty(e.target.checked)}
                      disabled={smsState === 'sending' || smsState === 'sent'}
                      className="w-4 h-4 accent-green-600"
                    />
                    Sumar al programa de lealtad (+1 sello)
                  </label>
                )}
                {smsError && <p className="text-red-600 text-xs">{smsError}</p>}
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      setShowSmsForm(false);
                      setSmsPhone(linkedCustomer?.phone || '');
                      setSmsName(linkedCustomer?.name || '');
                      setFoundCustomer(null);
                      setSmsState('idle');
                      setSmsError(null);
                    }}
                    disabled={smsState === 'sending'}
                    className="flex-1 py-2 bg-neutral-200 text-neutral-700 font-semibold rounded-lg hover:bg-neutral-300"
                  >
                    Cancelar
                  </button>
                  <button
                    onClick={handleSendSms}
                    disabled={!smsPhone.trim() || smsState === 'sending' || smsState === 'sent'}
                    className="flex-1 py-2 bg-green-600 text-white font-semibold rounded-lg hover:bg-green-700 disabled:opacity-50"
                  >
                    {smsState === 'sending' ? 'Enviando...' : smsState === 'sent' ? '✓ Enviado' : 'Enviar'}
                  </button>
                </div>
              </div>
            )}
            {!invoiceIssued && !order.cfdi_invoice_id && (
              <button
                onClick={() => setShowInvoiceModal(true)}
                className="w-full py-3 bg-blue-600 text-white font-bold rounded-lg hover:bg-blue-700 transition-all"
              >
                {t('receipt.invoiceButton')}
              </button>
            )}
            <button
              onClick={onClose}
              className="w-full py-3 bg-brand-600 text-white font-bold rounded-lg hover:bg-brand-700 transition-all"
            >
              {t('common:buttons.done')}
            </button>
          </div>
        </div>
      </div>

      {showInvoiceModal && (
        <React.Suspense fallback={null}>
          <InvoiceModal
            order={order}
            onClose={() => setShowInvoiceModal(false)}
            onInvoiceIssued={handleInvoiceIssued}
          />
        </React.Suspense>
      )}
    </>
  );
};

export default ReceiptModal;
