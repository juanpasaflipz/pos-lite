import React, { useState, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { QRCodeSVG } from 'qrcode.react';
import { Clock, Coins } from 'lucide-react';
import { Order, CfdiInvoice, LoyaltyCustomer } from '../../types';
import { formatPrice, TAX_LABEL } from '../../utils/currency';
import { formatDateTime } from '../../utils/dateFormat';
import { sendSmsReceipt, lookupLoyaltyCustomer, getLoyaltyJoinToken } from '../../api';
import BrandLogo from '../BrandLogo';
import CashTipModal from './CashTipModal';
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
  const [loyaltyJoinToken, setLoyaltyJoinToken] = useState<string | null>(null);
  const [showCashTip, setShowCashTip] = useState(false);
  // Optimistic tip — bumps the displayed tip immediately after a successful
  // post-close add, without waiting for the parent to refetch the order.
  const [tipBump, setTipBump] = useState(0);
  const effectiveTip = (Number(order.tip) || 0) + tipBump;
  const canAddCashTip =
    (order.payment_status === 'paid' || order.payment_status === 'completed') &&
    (order.payment_method === 'cash' || order.payment_method === 'split');

  // The effective customer: either passed in from POSScreen (order-start lookup)
  // or discovered live as the merchant types a known phone into the SMS form.
  const recognizedCustomer = linkedCustomer || foundCustomer;

  // Name printed big/bold under the order number (matches the delivery-ticket
  // convention of calling out the customer prominently). Prefers the live
  // recognized-customer name, then falls back to whatever the order already
  // carries — customer_name is server-COALESCE'd from the loyalty customer or
  // the QR/kiosk "call name" the customer typed in at order time.
  const displayCustomerName =
    recognizedCustomer?.name?.trim() ||
    order.customer_name?.trim() ||
    order.loyalty_customer_name?.trim() ||
    null;

  // Hydrate from the inline loyalty fields on the order when no linkedCustomer
  // was passed (e.g. re-sending receipt for a past order from OrdersScreen).
  // The order endpoint returns loyalty_customer_name/phone via a LEFT JOIN,
  // so we don't need a second API call — and this path works for any employee
  // with pos_access (the by-id lookup requires manage_loyalty and would 403).
  useEffect(() => {
    if (linkedCustomer) return;
    const id = order.loyalty_customer_id;
    const phone = order.loyalty_customer_phone;
    const name = order.loyalty_customer_name;
    if (!id || !phone) return;
    setFoundCustomer({ id, phone, name: name || '', country_code: 'MX' } as LoyaltyCustomer);
    setSmsPhone(phone);
    setSmsName(name || '');
  }, [order.loyalty_customer_id, order.loyalty_customer_phone, order.loyalty_customer_name, linkedCustomer]);

  // Flags the document while the ticket is on screen so the print stylesheet
  // can hide everything except the portaled ticket. Scoped to mount/unmount so
  // other print surfaces are never affected.
  useEffect(() => {
    document.body.classList.add('receipt-modal-open');
    return () => document.body.classList.remove('receipt-modal-open');
  }, []);

  // Loyalty sign-up QR printed at the bottom of the ticket — same "scan to
  // join" flow the kiosk shows on-screen after payment, minted fresh here so
  // re-printing an old receipt from OrdersScreen still gets a live link.
  // Silently absent (no QR block) if loyalty is plan-locked or the request
  // fails — this is a nice-to-have on the receipt, not a blocking feature.
  useEffect(() => {
    let cancelled = false;
    setLoyaltyJoinToken(null);
    getLoyaltyJoinToken(order.id)
      .then((r) => { if (!cancelled) setLoyaltyJoinToken(r.token); })
      .catch(() => { /* plan-locked or unavailable — no QR shown */ });
    return () => { cancelled = true; };
  }, [order.id]);

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
  const loyaltyJoinUrl = loyaltyJoinToken
    ? `${window.location.origin}/#/loyalty/join/${loyaltyJoinToken}`
    : null;

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
      {/* Portaled to <body> so the print stylesheet can display:none the rest
          of the document without also hiding the ticket. */}
      {createPortal(
        <div className="receipt-print-overlay fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
        <div className="receipt-print bg-white rounded-2xl shadow-2xl w-full max-w-sm max-h-[90vh] overflow-auto">
          <div className="p-6 text-center border-b-2 border-gray-300">
            <BrandLogo className="h-12 mx-auto mb-2" />
            <h2 className="text-2xl font-black tracking-tighter text-black mb-1">{branding?.restaurantName || 'Desktop Kitchen'}</h2>
            {branding?.tagline && (
              <p className="text-gray-600">{branding.tagline}</p>
            )}
            {branding?.address && (
              <p className="text-sm text-gray-500 mt-2">
                {branding.address}
              </p>
            )}
          </div>

          <div className="p-6 space-y-4 text-sm">
            <div className="text-center border-b pb-3">
              <p className="font-bold text-lg">{t('receipt.orderNumber', { number: order.order_number })}</p>
              {String(order.order_number).startsWith('OFF-') && (
                <span className="inline-block mt-1 px-2 py-0.5 bg-cockpit-yellow/15 text-cockpit-yellow text-xs font-bold rounded">
                  {t('receipt.offlineBadge')}
                </span>
              )}
              {displayCustomerName && (
                <p className="text-2xl font-black tracking-tight text-black mt-1">{displayCustomerName}</p>
              )}
              {order.order_fulfillment_type && (
                <span className="inline-block mt-1 px-2 py-0.5 bg-cockpit-yellow text-black text-xs font-black uppercase rounded tracking-wide">
                  {order.order_fulfillment_type === 'for_here' ? t('cart.forHere') : t('cart.toGo')}
                </span>
              )}
              <p className="text-gray-600">
                {formatDateTime(order.created_at ? new Date(order.created_at) : new Date())}
              </p>
              {order.employee_name && (
                <p className="text-gray-600">{t('receipt.cashier', { name: order.employee_name })}</p>
              )}
            </div>

            {/* Estimated Ready Time */}
            {order.estimated_ready_range && (
              <div className="flex items-center justify-center gap-2 py-3 px-4 bg-cockpit-yellow/10 border border-cockpit-yellow rounded-lg">
                <Clock className="w-5 h-5 text-cockpit-yellow flex-shrink-0" />
                <div className="text-center">
                  <p className="text-cockpit-yellow font-bold text-lg">
                    {t('receipt.estimatedReady', {
                      low: order.estimated_ready_range.low,
                      high: order.estimated_ready_range.high,
                    })}
                  </p>
                  <p className="text-cockpit-yellow text-xs">{t('receipt.orderBeingPrepared')}</p>
                </div>
              </div>
            )}

            <div className="space-y-2 border-b pb-3">
              {order.items?.map((item) => (
                <div key={item.id || item.menu_item_id} className="flex justify-between">
                  <div className="flex-1">
                    <p className="font-semibold">{item.item_name}</p>
                    {item.notes && (
                      <p className="text-gray-600 text-xs">{item.notes}</p>
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
              <div className="flex justify-between text-gray-500 text-sm">
                <p>{t('receipt.subtotalBeforeTax')}</p>
                <p>{formatPrice(order.subtotal)}</p>
              </div>
              <div className="flex justify-between text-gray-500 text-sm">
                <p>{t('receipt.taxIncluded', { label: TAX_LABEL })}</p>
                <p>{formatPrice(order.tax)}</p>
              </div>
              {effectiveTip > 0 && (
                <div className="flex justify-between">
                  <p>{t('receipt.tip')}</p>
                  <p className="font-semibold">{formatPrice(effectiveTip)}</p>
                </div>
              )}
            </div>

            {effectiveTip > 0 && (
              <div className="text-center py-3">
                <p className="text-2xl font-bold text-black">
                  {t('receipt.totalWithTip', { amount: formatPrice(order.total + effectiveTip) })}
                </p>
              </div>
            )}

            {/* Invoice QR Code */}
            {invoiceUrl && !invoiceIssued && (
              <div className="text-center py-3 border-t pt-3">
                <QRCodeSVG value={invoiceUrl} size={160} level="L" marginSize={2} className="mx-auto receipt-qr" />
                <p className="text-xs text-gray-500 mt-2">{t('receipt.scanForInvoice')}</p>
              </div>
            )}

            {invoiceIssued && (
              <div className="text-center py-2 bg-cockpit-green/10 rounded-lg">
                <p className="text-cockpit-green text-sm font-semibold">{t('receipt.invoiceIssued')}</p>
              </div>
            )}

            <div className="text-center py-3 border-t pt-3">
              <p className="text-lg font-bold text-[#2E5EAA]">{t('receipt.thankYou')}</p>
              <p className="text-gray-600 text-xs mt-2">{t('receipt.comeAgain')}</p>
            </div>

            {/* Loyalty Sign-up QR — printed at the bottom of every ticket.
                level="L": the join URL carries a ~250-char JWT, and at level M
                the symbol gets so dense that thermal printing smears the
                modules; L cuts the module count so each square prints fat
                enough to scan. marginSize keeps the quiet zone the spec
                requires. .receipt-qr is sized up in the print stylesheet. */}
            {loyaltyJoinUrl && (
              <div className="text-center py-3 border-t pt-3">
                <QRCodeSVG value={loyaltyJoinUrl} size={160} level="L" marginSize={2} className="mx-auto receipt-qr" />
                <p className="text-xs text-gray-500 mt-2">{t('receipt.scanForLoyalty')}</p>
              </div>
            )}
          </div>

          <div className="no-print p-4 space-y-2 border-t">
            <button
              onClick={onPrint}
              className="w-full py-3 bg-neutral-800 text-white font-bold rounded-lg hover:bg-neutral-700 transition-all"
            >
              {t('receipt.printReceipt')}
            </button>
            {!showSmsForm ? (
              <button
                onClick={() => setShowSmsForm(true)}
                className="w-full py-3 bg-cockpit-green text-white font-bold rounded-lg hover:bg-cockpit-green/90 transition-all"
              >
                {recognizedCustomer ? `Enviar recibo a ${recognizedCustomer.name}` : 'Enviar recibo por SMS'}
              </button>
            ) : (
              <div className="space-y-2 p-3 bg-gray-50 rounded-lg border border-gray-200">
                {recognizedCustomer && (
                  <div className="flex items-center gap-2 text-xs text-cockpit-green bg-cockpit-green/10 border border-cockpit-green rounded-md px-2 py-1">
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
                  style={{ colorScheme: 'light' }}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-white text-gray-900 placeholder:text-gray-400"
                />
                {enrollLoyalty && !recognizedCustomer && (
                  <input
                    type="text"
                    placeholder="Nombre del cliente (opcional)"
                    value={smsName}
                    onChange={(e) => setSmsName(e.target.value)}
                    disabled={smsState === 'sending' || smsState === 'sent'}
                    style={{ colorScheme: 'light' }}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-white text-gray-900 placeholder:text-gray-400"
                  />
                )}
                {!recognizedCustomer && (
                  <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={enrollLoyalty}
                      onChange={(e) => setEnrollLoyalty(e.target.checked)}
                      disabled={smsState === 'sending' || smsState === 'sent'}
                      className="w-4 h-4 accent-cockpit-green"
                    />
                    Sumar al programa de lealtad (+1 sello)
                  </label>
                )}
                {smsError && <p className="text-cockpit-red text-xs">{smsError}</p>}
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
                    className="flex-1 py-2 bg-gray-200 text-gray-700 font-semibold rounded-lg hover:bg-gray-300"
                  >
                    Cancelar
                  </button>
                  <button
                    onClick={handleSendSms}
                    disabled={!smsPhone.trim() || smsState === 'sending' || smsState === 'sent'}
                    className="flex-1 py-2 bg-cockpit-green text-white font-semibold rounded-lg hover:bg-cockpit-green/90 disabled:opacity-50"
                  >
                    {smsState === 'sending' ? 'Enviando...' : smsState === 'sent' ? '✓ Enviado' : 'Enviar'}
                  </button>
                </div>
              </div>
            )}
            {canAddCashTip && (
              <button
                onClick={() => setShowCashTip(true)}
                className="w-full py-3 bg-cockpit-yellow text-black font-bold rounded-lg hover:bg-cockpit-yellow/90 transition-all inline-flex items-center justify-center gap-2"
              >
                <Coins className="w-4 h-4" />
                Agregar propina en efectivo
              </button>
            )}
            {!invoiceIssued && !order.cfdi_invoice_id && (
              <button
                onClick={() => setShowInvoiceModal(true)}
                className="w-full py-3 bg-cockpit-blue text-white font-bold rounded-lg hover:bg-cockpit-blue/90 transition-all"
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
        </div>,
        document.body,
      )}

      {showInvoiceModal && (
        <React.Suspense fallback={null}>
          <InvoiceModal
            order={order}
            onClose={() => setShowInvoiceModal(false)}
            onInvoiceIssued={handleInvoiceIssued}
          />
        </React.Suspense>
      )}

      {showCashTip && (
        <CashTipModal
          orderId={order.id}
          orderNumber={String(order.order_number)}
          subtotal={Number(order.subtotal) || 0}
          existingTip={effectiveTip}
          onClose={() => setShowCashTip(false)}
          onAdded={(added) => {
            setTipBump((prev) => prev + added);
            setShowCashTip(false);
          }}
        />
      )}
    </>
  );
};

export default ReceiptModal;
