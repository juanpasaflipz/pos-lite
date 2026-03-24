import React, { useState, useEffect, lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Search,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Download,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Eye,
} from 'lucide-react';
import { getCfdiInvoices, cancelCfdiInvoice } from '../../api';
import type { CfdiInvoice, CfdiCatalogs } from '../../types';
import { formatPrice } from '../../utils/currency';

const CancellationModal = lazy(
  () => import('../cfdi/CancellationModal')
);

function InvoiceStatusBadge({ status, t }: { status: CfdiInvoice['status']; t: (key: string) => string }) {
  if (status === 'valid') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-green-900/30 text-green-400 border border-green-800">
        <CheckCircle size={12} />
        {t('invoicing.statusValid')}
      </span>
    );
  }
  if (status === 'cancelled') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-red-900/30 text-red-400 border border-red-800">
        <XCircle size={12} />
        {t('invoicing.statusCancelled')}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-amber-900/30 text-amber-400 border border-amber-800">
      <AlertTriangle size={12} />
      {t('invoicing.statusCancellationPending')}
    </span>
  );
}

const formatDate = (dateStr: string): string => {
  try {
    return new Date(dateStr).toLocaleDateString('es-MX', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return dateStr;
  }
};

const INVOICES_PER_PAGE = 15;

interface InvoiceListTabProps {
  catalogs: CfdiCatalogs | null;
  onError: (msg: string) => void;
  onSuccess: (msg: string) => void;
}

export default function InvoiceListTab({ catalogs, onError, onSuccess }: InvoiceListTabProps) {
  const { t } = useTranslation('admin');
  const [invoices, setInvoices] = useState<CfdiInvoice[]>([]);
  const [invoiceSearch, setInvoiceSearch] = useState('');
  const [invoiceStatusFilter, setInvoiceStatusFilter] = useState<string>('');
  const [invoicePage, setInvoicePage] = useState(1);
  const [invoiceTotal, setInvoiceTotal] = useState(0);
  const [cancellingInvoice, setCancellingInvoice] = useState<CfdiInvoice | null>(null);

  const fetchInvoices = async () => {
    try {
      const res = await getCfdiInvoices({
        page: invoicePage,
        limit: INVOICES_PER_PAGE,
        search: invoiceSearch || undefined,
        status: invoiceStatusFilter || undefined,
      });
      setInvoices(res.invoices);
      setInvoiceTotal(res.total);
    } catch (err) {
      onError(err instanceof Error ? err.message : t('invoicing.errorLoadingInvoices'));
    }
  };

  useEffect(() => {
    fetchInvoices();
  }, [invoicePage, invoiceStatusFilter]);

  const handleInvoiceSearch = () => {
    setInvoicePage(1);
    fetchInvoices();
  };

  const handleCancelComplete = async (motive: string, substituteUUID?: string) => {
    if (!cancellingInvoice) return;
    try {
      const updatedInvoice = await cancelCfdiInvoice(cancellingInvoice.id, {
        motive,
        substitute_uuid: substituteUUID,
      });
      setInvoices((prev) =>
        prev.map((inv) => (inv.id === updatedInvoice.id ? updatedInvoice : inv))
      );
      setCancellingInvoice(null);
      onSuccess(t('invoicing.invoiceCancelled'));
    } catch (err) {
      onError(err instanceof Error ? err.message : t('invoicing.errorCancellingInvoice'));
    }
  };

  const totalPages = Math.ceil(invoiceTotal / INVOICES_PER_PAGE);

  return (
    <div className="space-y-6">
      {/* Search and Filters */}
      <div className="bg-neutral-900 rounded-lg border border-neutral-800 p-6">
        <div className="flex flex-col md:flex-row gap-3">
          <div className="flex-1 flex gap-3">
            <input
              type="text"
              value={invoiceSearch}
              onChange={(e) => setInvoiceSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleInvoiceSearch();
              }}
              placeholder={t('invoicing.searchPlaceholder')}
              className="flex-1 bg-neutral-800 text-white rounded-lg px-4 py-3 border border-neutral-700 focus:border-brand-500 focus:outline-none"
            />
            <button
              onClick={handleInvoiceSearch}
              className="px-4 py-3 bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors"
            >
              <Search size={18} />
            </button>
          </div>
          <select
            value={invoiceStatusFilter}
            onChange={(e) => {
              setInvoiceStatusFilter(e.target.value);
              setInvoicePage(1);
            }}
            className="bg-neutral-800 text-white rounded-lg px-4 py-3 border border-neutral-700 focus:border-brand-500 focus:outline-none"
          >
            <option value="">{t('invoicing.allStatuses')}</option>
            <option value="valid">{t('invoicing.statusValid')}</option>
            <option value="cancelled">{t('invoicing.statusCancelled')}</option>
          </select>
        </div>
      </div>

      {/* Invoice Table */}
      <div className="bg-neutral-900 rounded-lg border border-neutral-800 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-neutral-800">
              <tr>
                <th className="px-4 py-3 text-left text-sm font-semibold text-neutral-300">
                  {t('invoicing.folio')}
                </th>
                <th className="px-4 py-3 text-left text-sm font-semibold text-neutral-300">
                  {t('invoicing.order')}
                </th>
                <th className="px-4 py-3 text-left text-sm font-semibold text-neutral-300">
                  {t('invoicing.rfc')}
                </th>
                <th className="px-4 py-3 text-left text-sm font-semibold text-neutral-300">
                  {t('invoicing.recipient')}
                </th>
                <th className="px-4 py-3 text-right text-sm font-semibold text-neutral-300">
                  {t('invoicing.total')}
                </th>
                <th className="px-4 py-3 text-center text-sm font-semibold text-neutral-300">
                  {t('invoicing.status')}
                </th>
                <th className="px-4 py-3 text-left text-sm font-semibold text-neutral-300">
                  {t('invoicing.date')}
                </th>
                <th className="px-4 py-3 text-right text-sm font-semibold text-neutral-300">
                  {t('invoicing.actions')}
                </th>
              </tr>
            </thead>
            <tbody>
              {invoices.length === 0 ? (
                <tr>
                  <td
                    colSpan={8}
                    className="px-4 py-12 text-center text-neutral-500"
                  >
                    {t('invoicing.noInvoicesFound')}
                  </td>
                </tr>
              ) : (
                invoices.map((inv) => (
                  <tr
                    key={inv.id}
                    className="border-b border-neutral-800 hover:bg-neutral-800/50 transition-colors"
                  >
                    <td className="px-4 py-3 text-white text-sm font-medium">
                      {inv.series}-{inv.folio}
                    </td>
                    <td className="px-4 py-3 text-neutral-300 text-sm">
                      {inv.order_number || `#${inv.order_id}`}
                    </td>
                    <td className="px-4 py-3 text-neutral-300 text-sm font-mono">
                      {inv.receptor_rfc}
                    </td>
                    <td className="px-4 py-3 text-neutral-300 text-sm max-w-[200px] truncate">
                      {inv.receptor_name}
                    </td>
                    <td className="px-4 py-3 text-white text-sm text-right font-medium">
                      {formatPrice(inv.total)}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <InvoiceStatusBadge status={inv.status} t={t} />
                    </td>
                    <td className="px-4 py-3 text-neutral-400 text-sm">
                      {formatDate(inv.issued_at)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        {inv.pdf_url && (
                          <a
                            href={inv.pdf_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            title={t('invoicing.viewPdf')}
                            className="p-2 hover:bg-neutral-700 rounded-lg transition-colors text-neutral-400 hover:text-white"
                          >
                            <Eye size={16} />
                          </a>
                        )}
                        {inv.xml_url && (
                          <a
                            href={inv.xml_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            title={t('invoicing.downloadXml')}
                            className="p-2 hover:bg-neutral-700 rounded-lg transition-colors text-neutral-400 hover:text-white"
                          >
                            <Download size={16} />
                          </a>
                        )}
                        {inv.status === 'valid' && (
                          <button
                            onClick={() => setCancellingInvoice(inv)}
                            title={t('invoicing.cancelInvoice')}
                            className="p-2 hover:bg-red-900/30 rounded-lg transition-colors text-neutral-400 hover:text-red-400"
                          >
                            <XCircle size={16} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-neutral-800">
            <p className="text-sm text-neutral-400">
              {t('invoicing.showing', { from: (invoicePage - 1) * INVOICES_PER_PAGE + 1, to: Math.min(invoicePage * INVOICES_PER_PAGE, invoiceTotal), total: invoiceTotal })}
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setInvoicePage((p) => Math.max(1, p - 1))}
                disabled={invoicePage <= 1}
                className="flex items-center gap-1 px-3 py-1.5 bg-neutral-800 text-neutral-300 rounded-lg hover:bg-neutral-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-sm"
              >
                <ChevronLeft size={16} />
                {t('invoicing.previous')}
              </button>
              <span className="text-sm text-neutral-400">
                {invoicePage} / {totalPages}
              </span>
              <button
                onClick={() =>
                  setInvoicePage((p) => Math.min(totalPages, p + 1))
                }
                disabled={invoicePage >= totalPages}
                className="flex items-center gap-1 px-3 py-1.5 bg-neutral-800 text-neutral-300 rounded-lg hover:bg-neutral-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-sm"
              >
                {t('invoicing.next')}
                <ChevronRight size={16} />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Cancellation Modal */}
      {cancellingInvoice && catalogs && (
        <Suspense
          fallback={
            <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
              <Loader2 size={32} className="animate-spin text-brand-500" />
            </div>
          }
        >
          <CancellationModal
            invoice={cancellingInvoice}
            onCancel={handleCancelComplete}
            onClose={() => setCancellingInvoice(null)}
          />
        </Suspense>
      )}
    </div>
  );
}
