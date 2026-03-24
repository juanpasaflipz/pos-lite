import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { X, FileText, Download, Copy, Check, AlertCircle, Loader2 } from 'lucide-react';
import { Order, CfdiInvoice, SatCatalogItem, CfdiCatalogs } from '../../types';
import { issueCfdiInvoice, getCfdiCatalogs, getInvoiceToken } from '../../api';
import { formatPrice } from '../../utils/currency';

interface InvoiceModalProps {
  order: Order;
  onClose: () => void;
  onInvoiceIssued: (invoice: CfdiInvoice) => void;
}

type ModalState = 'form' | 'loading' | 'success' | 'error';

const FALLBACK_TAX_REGIMES: SatCatalogItem[] = [
  { code: '601', name: 'General de Ley Personas Morales' },
  { code: '612', name: 'Personas Físicas con Actividades Empresariales y Profesionales' },
  { code: '616', name: 'Sin obligaciones fiscales' },
  { code: '625', name: 'Régimen de las Actividades Empresariales con ingresos a través de Plataformas Tecnológicas' },
  { code: '626', name: 'Régimen Simplificado de Confianza' },
];

const FALLBACK_USO_CFDI: SatCatalogItem[] = [
  { code: 'G01', name: 'Adquisición de mercancías' },
  { code: 'G03', name: 'Gastos en general' },
  { code: 'S01', name: 'Sin efectos fiscales' },
];

const InvoiceModal: React.FC<InvoiceModalProps> = ({ order, onClose, onInvoiceIssued }) => {
  const { t } = useTranslation('pos');
  const [modalState, setModalState] = useState<ModalState>('form');
  const [publicoGeneral, setPublicoGeneral] = useState(true);

  // Customer fields
  const [rfc, setRfc] = useState('');
  const [razonSocial, setRazonSocial] = useState('');
  const [regimenFiscal, setRegimenFiscal] = useState('');
  const [codigoPostal, setCodigoPostal] = useState('');
  const [usoCfdi, setUsoCfdi] = useState('G03');

  // Catalogs
  const [taxRegimes, setTaxRegimes] = useState<SatCatalogItem[]>(FALLBACK_TAX_REGIMES);
  const [usoCfdiOptions, setUsoCfdiOptions] = useState<SatCatalogItem[]>(FALLBACK_USO_CFDI);

  // Result
  const [issuedInvoice, setIssuedInvoice] = useState<CfdiInvoice | null>(null);
  const [invoiceTokenUrl, setInvoiceTokenUrl] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    getCfdiCatalogs()
      .then((catalogs: CfdiCatalogs) => {
        if (catalogs.taxRegimes?.length) setTaxRegimes(catalogs.taxRegimes);
        if (catalogs.usoCfdi?.length) setUsoCfdiOptions(catalogs.usoCfdi);
      })
      .catch(() => {
        // Keep fallback values
      });
  }, []);

  const handleIssue = useCallback(async () => {
    setModalState('loading');
    setErrorMessage('');

    try {
      const payload: Parameters<typeof issueCfdiInvoice>[0] = {
        order_id: order.id,
      };

      if (publicoGeneral) {
        payload.publico_general = true;
      } else {
        payload.receptor = {
          rfc: rfc.trim().toUpperCase(),
          name: razonSocial.trim(),
          tax_regime: regimenFiscal,
          postal_code: codigoPostal.trim(),
          uso_cfdi: usoCfdi,
        };
      }

      const invoice = await issueCfdiInvoice(payload);
      setIssuedInvoice(invoice);

      // Fetch the invoice token URL for the copy link feature
      try {
        const tokenData = await getInvoiceToken(order.id);
        setInvoiceTokenUrl(tokenData.url);
      } catch {
        // Token fetch is optional; don't block the success state
      }

      setModalState('success');
      onInvoiceIssued(invoice);
    } catch (err: any) {
      setErrorMessage(err?.message || t('invoice.errorGeneric'));
      setModalState('error');
    }
  }, [order.id, publicoGeneral, rfc, razonSocial, regimenFiscal, codigoPostal, usoCfdi, onInvoiceIssued, t]);

  const handleCopyLink = useCallback(async () => {
    if (!invoiceTokenUrl) return;
    try {
      await navigator.clipboard.writeText(invoiceTokenUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for older browsers
      const textarea = document.createElement('textarea');
      textarea.value = invoiceTokenUrl;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [invoiceTokenUrl]);

  const isFormValid = publicoGeneral || (
    rfc.trim().length >= 12 &&
    razonSocial.trim().length > 0 &&
    regimenFiscal.length > 0 &&
    codigoPostal.trim().length === 5
  );

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-neutral-900 border border-neutral-700 rounded-2xl shadow-2xl w-full max-w-md max-h-[90vh] overflow-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-neutral-700">
          <div className="flex items-center gap-2">
            <FileText className="w-5 h-5 text-brand-400" />
            <h2 className="text-lg font-bold text-white">
              {t('invoice.title', { number: order.order_number })}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-neutral-800 text-neutral-400 hover:text-white transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form State */}
        {modalState === 'form' && (
          <div className="p-4 space-y-4">
            {/* Order summary */}
            <div className="bg-neutral-800 rounded-lg p-3 text-sm">
              <div className="flex justify-between text-neutral-400">
                <span>{t('invoice.subtotal')}</span>
                <span>{formatPrice(order.subtotal)}</span>
              </div>
              <div className="flex justify-between text-neutral-400">
                <span>{t('invoice.tax')}</span>
                <span>{formatPrice(order.tax)}</span>
              </div>
              <div className="flex justify-between text-white font-bold mt-1 pt-1 border-t border-neutral-700">
                <span>{t('invoice.total')}</span>
                <span>{formatPrice(order.total)}</span>
              </div>
            </div>

            {/* Publico en General toggle */}
            <label className="flex items-center gap-3 cursor-pointer select-none">
              <div className="relative">
                <input
                  type="checkbox"
                  checked={publicoGeneral}
                  onChange={(e) => setPublicoGeneral(e.target.checked)}
                  className="sr-only peer"
                />
                <div className="w-10 h-6 bg-neutral-700 rounded-full peer-checked:bg-brand-600 transition-colors" />
                <div className="absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform peer-checked:translate-x-4" />
              </div>
              <span className="text-white text-sm font-medium">{t('invoice.generalPublic')}</span>
            </label>

            {/* Customer fields (shown when not publico general) */}
            {!publicoGeneral && (
              <div className="space-y-3">
                {/* RFC */}
                <div>
                  <label className="block text-xs font-medium text-neutral-400 mb-1">{t('invoice.rfc')}</label>
                  <input
                    type="text"
                    value={rfc}
                    onChange={(e) => setRfc(e.target.value.toUpperCase())}
                    placeholder="XAXX010101000"
                    maxLength={13}
                    className="w-full px-3 py-2 bg-neutral-800 border border-neutral-600 rounded-lg text-white placeholder-neutral-500 text-sm focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 uppercase"
                  />
                </div>

                {/* Razon Social */}
                <div>
                  <label className="block text-xs font-medium text-neutral-400 mb-1">{t('invoice.legalName')}</label>
                  <input
                    type="text"
                    value={razonSocial}
                    onChange={(e) => setRazonSocial(e.target.value)}
                    placeholder={t('invoice.legalNamePlaceholder')}
                    className="w-full px-3 py-2 bg-neutral-800 border border-neutral-600 rounded-lg text-white placeholder-neutral-500 text-sm focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
                  />
                </div>

                {/* Regimen Fiscal */}
                <div>
                  <label className="block text-xs font-medium text-neutral-400 mb-1">{t('invoice.taxRegime')}</label>
                  <select
                    value={regimenFiscal}
                    onChange={(e) => setRegimenFiscal(e.target.value)}
                    className="w-full px-3 py-2 bg-neutral-800 border border-neutral-600 rounded-lg text-white text-sm focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 appearance-none"
                  >
                    <option value="" className="bg-neutral-800">{t('invoice.selectRegime')}</option>
                    {taxRegimes.map((regime) => (
                      <option key={regime.code} value={regime.code} className="bg-neutral-800">
                        {regime.code} - {regime.name}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Codigo Postal */}
                <div>
                  <label className="block text-xs font-medium text-neutral-400 mb-1">{t('invoice.postalCode')}</label>
                  <input
                    type="text"
                    value={codigoPostal}
                    onChange={(e) => setCodigoPostal(e.target.value.replace(/\D/g, '').slice(0, 5))}
                    placeholder="00000"
                    maxLength={5}
                    inputMode="numeric"
                    className="w-full px-3 py-2 bg-neutral-800 border border-neutral-600 rounded-lg text-white placeholder-neutral-500 text-sm focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
                  />
                </div>

                {/* Uso de CFDI */}
                <div>
                  <label className="block text-xs font-medium text-neutral-400 mb-1">{t('invoice.cfdiUsage')}</label>
                  <select
                    value={usoCfdi}
                    onChange={(e) => setUsoCfdi(e.target.value)}
                    className="w-full px-3 py-2 bg-neutral-800 border border-neutral-600 rounded-lg text-white text-sm focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 appearance-none"
                  >
                    {usoCfdiOptions.map((uso) => (
                      <option key={uso.code} value={uso.code} className="bg-neutral-800">
                        {uso.code} - {uso.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            {/* Issue button */}
            <button
              onClick={handleIssue}
              disabled={!isFormValid}
              className="w-full py-3 rounded-lg font-bold text-sm transition-colors bg-brand-600 hover:bg-brand-700 text-white disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {t('invoice.issueCfdi')}
            </button>
          </div>
        )}

        {/* Loading State */}
        {modalState === 'loading' && (
          <div className="p-8 flex flex-col items-center gap-4">
            <Loader2 className="w-10 h-10 text-brand-400 animate-spin" />
            <p className="text-neutral-300 text-sm">{t('invoice.issuing')}</p>
          </div>
        )}

        {/* Success State */}
        {modalState === 'success' && issuedInvoice && (
          <div className="p-4 space-y-4">
            <div className="flex flex-col items-center gap-2 py-2">
              <div className="w-12 h-12 rounded-full bg-green-600/20 flex items-center justify-center">
                <Check className="w-6 h-6 text-green-400" />
              </div>
              <p className="text-green-400 font-bold text-sm">{t('invoice.success')}</p>
            </div>

            <div className="bg-neutral-800 rounded-lg p-3 space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-neutral-400">{t('invoice.folio')}</span>
                <span className="text-white font-medium">{issuedInvoice.series}{issuedInvoice.folio}</span>
              </div>
              <div>
                <span className="text-neutral-400 block mb-1">{t('invoice.uuidFiscal')}</span>
                <span className="text-brand-400 font-mono text-xs break-all">{issuedInvoice.uuid_fiscal}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-400">{t('invoice.recipientRfc')}</span>
                <span className="text-white font-medium">{issuedInvoice.receptor_rfc}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-400">{t('invoice.total')}</span>
                <span className="text-white font-bold">{formatPrice(issuedInvoice.total)}</span>
              </div>
            </div>

            <div className="space-y-2">
              {/* Download PDF */}
              {issuedInvoice.pdf_url && (
                <a
                  href={issuedInvoice.pdf_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-center gap-2 w-full py-2.5 rounded-lg font-bold text-sm bg-brand-600 hover:bg-brand-700 text-white transition-colors"
                >
                  <Download className="w-4 h-4" />
                  {t('invoice.downloadPdf')}
                </a>
              )}

              {/* Copy Invoice Link */}
              {invoiceTokenUrl && (
                <button
                  onClick={handleCopyLink}
                  className="flex items-center justify-center gap-2 w-full py-2.5 rounded-lg font-bold text-sm bg-neutral-800 hover:bg-neutral-700 text-white border border-neutral-600 transition-colors"
                >
                  {copied ? (
                    <>
                      <Check className="w-4 h-4 text-green-400" />
                      <span className="text-green-400">{t('invoice.linkCopied')}</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-4 h-4" />
                      {t('invoice.copyLink')}
                    </>
                  )}
                </button>
              )}

              {/* Close */}
              <button
                onClick={onClose}
                className="w-full py-2.5 rounded-lg font-bold text-sm text-neutral-400 hover:text-white transition-colors"
              >
                {t('common:buttons.close')}
              </button>
            </div>
          </div>
        )}

        {/* Error State */}
        {modalState === 'error' && (
          <div className="p-4 space-y-4">
            <div className="flex flex-col items-center gap-2 py-2">
              <div className="w-12 h-12 rounded-full bg-red-600/20 flex items-center justify-center">
                <AlertCircle className="w-6 h-6 text-red-400" />
              </div>
              <p className="text-red-400 font-bold text-sm">{t('invoice.errorTitle')}</p>
            </div>

            <div className="bg-red-900/20 border border-red-800 rounded-lg p-3">
              <p className="text-red-300 text-sm">{errorMessage}</p>
            </div>

            <div className="space-y-2">
              <button
                onClick={() => setModalState('form')}
                className="w-full py-2.5 rounded-lg font-bold text-sm bg-brand-600 hover:bg-brand-700 text-white transition-colors"
              >
                {t('invoice.retry')}
              </button>
              <button
                onClick={onClose}
                className="w-full py-2.5 rounded-lg font-bold text-sm text-neutral-400 hover:text-white transition-colors"
              >
                {t('common:buttons.close')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default InvoiceModal;
