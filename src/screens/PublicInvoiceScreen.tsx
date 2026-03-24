import React, { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { getCfdiPublicOrder, issueCfdiPublicInvoice } from '../api';

/* ---------- SAT catalog subsets (hardcoded for public page) ---------- */

const TAX_REGIMES = [
  { code: '601', name: 'General de Ley Personas Morales' },
  { code: '612', name: 'Personas Fisicas con Actividades Empresariales' },
  { code: '616', name: 'Sin obligaciones fiscales' },
  { code: '625', name: 'RESICO - Plataformas Tecnologicas' },
  { code: '626', name: 'Regimen Simplificado de Confianza' },
  { code: '606', name: 'Arrendamiento' },
  { code: '605', name: 'Sueldos y Salarios' },
  { code: '608', name: 'Demas ingresos' },
];

const USO_CFDI = [
  { code: 'G03', name: 'Gastos en general' },
  { code: 'G01', name: 'Adquisicion de mercancias' },
  { code: 'S01', name: 'Sin efectos fiscales' },
  { code: 'D01', name: 'Honorarios medicos y gastos hospitalarios' },
];

/* ---------- Types ---------- */

interface OrderData {
  order_number: string;
  date: string;
  items: Array<{ item_name: string; quantity: number; unit_price: number }>;
  subtotal: number;
  tax: number;
  total: number;
  tenant_name: string;
  tenant_logo: string | null;
  tenant_color: string;
  emisor_postal_code: string;
}

interface InvoiceResult {
  uuid_fiscal: string;
  pdf_url: string;
  xml_url: string;
  invoice_id: number;
}

interface FormData {
  rfc: string;
  name: string;
  tax_regime: string;
  postal_code: string;
  uso_cfdi: string;
}

type PageState = 'loading' | 'form' | 'submitting' | 'success' | 'error';

interface ErrorInfo {
  message: string;
  status?: number;
}

/* ---------- Helpers ---------- */

function formatMXN(amount: number): string {
  return new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency: 'MXN',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

function formatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString('es-MX', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return dateStr;
  }
}

function getErrorMessage(err: unknown): ErrorInfo {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (msg.includes('expired') || msg.includes('expirado')) {
      return { message: 'Este enlace de facturacion ha expirado. Solicita uno nuevo al establecimiento.', status: 410 };
    }
    if (msg.includes('already') || msg.includes('ya fue') || msg.includes('already invoiced')) {
      return { message: 'Esta orden ya fue facturada. Contacta al establecimiento si necesitas una copia.', status: 410 };
    }
    if (msg.includes('rfc') && (msg.includes('invalid') || msg.includes('invalido'))) {
      return { message: 'El RFC ingresado no es valido. Verifica que tenga el formato correcto (12 o 13 caracteres).', status: 400 };
    }
    if (msg.includes('cfdi') && (msg.includes('not active') || msg.includes('no activ'))) {
      return { message: 'La facturacion electronica no esta habilitada para este establecimiento.', status: 400 };
    }
    return { message: err.message };
  }
  return { message: 'Ocurrio un error inesperado. Intenta de nuevo.' };
}

/* ---------- Component ---------- */

const PublicInvoiceScreen: React.FC = () => {
  const { token } = useParams<{ token: string }>();

  const [pageState, setPageState] = useState<PageState>('loading');
  const [order, setOrder] = useState<OrderData | null>(null);
  const [invoice, setInvoice] = useState<InvoiceResult | null>(null);
  const [errorInfo, setErrorInfo] = useState<ErrorInfo | null>(null);

  const [form, setForm] = useState<FormData>({
    rfc: '',
    name: '',
    tax_regime: '616',
    postal_code: '',
    uso_cfdi: 'G03',
  });

  const [formErrors, setFormErrors] = useState<Partial<Record<keyof FormData, string>>>({});

  const accentColor = order?.tenant_color || '#0d9488';

  /* --- Fetch order on mount --- */
  useEffect(() => {
    if (!token) {
      setErrorInfo({ message: 'Enlace de facturacion invalido.' });
      setPageState('error');
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        const data = await getCfdiPublicOrder(token);
        if (!cancelled) {
          setOrder(data);
          setPageState('form');
        }
      } catch (err) {
        if (!cancelled) {
          setErrorInfo(getErrorMessage(err));
          setPageState('error');
        }
      }
    })();

    return () => { cancelled = true; };
  }, [token]);

  /* --- Form validation --- */
  function validateForm(): boolean {
    const errors: Partial<Record<keyof FormData, string>> = {};

    const rfcTrimmed = form.rfc.trim().toUpperCase();
    if (!rfcTrimmed) {
      errors.rfc = 'El RFC es requerido';
    } else if (!/^[A-Z&Ñ]{3,4}\d{6}[A-Z0-9]{3}$/.test(rfcTrimmed)) {
      errors.rfc = 'Formato de RFC invalido';
    }

    if (!form.name.trim()) {
      errors.name = 'La razon social es requerida';
    }

    if (!form.tax_regime) {
      errors.tax_regime = 'Selecciona un regimen fiscal';
    }

    const cp = form.postal_code.trim();
    if (!cp) {
      errors.postal_code = 'El codigo postal es requerido';
    } else if (!/^\d{5}$/.test(cp)) {
      errors.postal_code = 'Codigo postal invalido (5 digitos)';
    }

    if (!form.uso_cfdi) {
      errors.uso_cfdi = 'Selecciona un uso de CFDI';
    }

    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  }

  /* --- Submit handler --- */
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validateForm() || !token) return;

    setPageState('submitting');
    setErrorInfo(null);

    try {
      const result = await issueCfdiPublicInvoice(token, {
        rfc: form.rfc.trim().toUpperCase(),
        name: form.name.trim(),
        tax_regime: form.tax_regime,
        postal_code: form.postal_code.trim(),
        uso_cfdi: form.uso_cfdi,
      });
      setInvoice(result);
      setPageState('success');
    } catch (err) {
      setErrorInfo(getErrorMessage(err));
      setPageState('error');
    }
  }

  /* --- Field change handler --- */
  function updateField(field: keyof FormData, value: string) {
    setForm(prev => ({ ...prev, [field]: value }));
    if (formErrors[field]) {
      setFormErrors(prev => {
        const next = { ...prev };
        delete next[field];
        return next;
      });
    }
  }

  /* --- Download URLs --- */
  const API_BASE = import.meta.env.VITE_API_URL || '/api';

  function getDownloadUrl(format: 'pdf' | 'xml'): string {
    if (format === 'pdf' && invoice?.pdf_url) return invoice.pdf_url;
    if (format === 'xml' && invoice?.xml_url) return invoice.xml_url;
    return `${API_BASE}/cfdi-public/${token}/download?format=${format}`;
  }

  /* ========================== RENDER ========================== */

  /* --- Spinner --- */
  const Spinner: React.FC<{ size?: string; color?: string }> = ({ size = 'h-8 w-8', color }) => (
    <svg
      className={`animate-spin ${size}`}
      style={{ color: color || accentColor }}
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  );

  /* --- Loading state --- */
  if (pageState === 'loading') {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="text-center">
          <Spinner size="h-10 w-10" />
          <p className="mt-4 text-gray-500 text-sm">Cargando datos de la orden...</p>
        </div>
      </div>
    );
  }

  /* --- Error state (no order loaded) --- */
  if (pageState === 'error' && !order) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 max-w-md w-full p-8 text-center">
          <div className="mx-auto w-14 h-14 bg-red-50 rounded-full flex items-center justify-center mb-4">
            <svg className="w-7 h-7 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-gray-900 mb-2">No se pudo cargar la orden</h2>
          <p className="text-gray-500 text-sm">{errorInfo?.message || 'Error desconocido'}</p>
        </div>
      </div>
    );
  }

  /* --- Success state --- */
  if (pageState === 'success' && invoice) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 max-w-md w-full p-8">
          {/* Tenant header */}
          <div className="text-center mb-6">
            {order?.tenant_logo && (
              <img src={order.tenant_logo} alt={order.tenant_name} className="h-10 mx-auto mb-2 object-contain" />
            )}
            <p className="text-sm text-gray-500">{order?.tenant_name}</p>
          </div>

          {/* Success icon */}
          <div className="text-center mb-6">
            <div
              className="mx-auto w-16 h-16 rounded-full flex items-center justify-center mb-4"
              style={{ backgroundColor: `${accentColor}15` }}
            >
              <svg className="w-8 h-8" style={{ color: accentColor }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h2 className="text-xl font-semibold text-gray-900 mb-1">Factura generada</h2>
            <p className="text-gray-500 text-sm">Tu CFDI ha sido timbrado exitosamente</p>
          </div>

          {/* Invoice details */}
          <div className="bg-gray-50 rounded-lg p-4 mb-6 space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">UUID Fiscal</span>
              <span className="text-gray-900 font-mono text-xs break-all text-right ml-4">{invoice.uuid_fiscal}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">Orden</span>
              <span className="text-gray-900 font-medium">{order?.order_number}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">Total</span>
              <span className="text-gray-900 font-medium">{order ? formatMXN(order.total) : ''}</span>
            </div>
          </div>

          {/* Download buttons */}
          <div className="space-y-3">
            <a
              href={getDownloadUrl('pdf')}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-2 w-full py-3 px-4 rounded-lg text-white font-medium text-sm transition-opacity hover:opacity-90"
              style={{ backgroundColor: accentColor }}
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              Descargar PDF
            </a>
            <a
              href={getDownloadUrl('xml')}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-2 w-full py-3 px-4 rounded-lg border font-medium text-sm transition-colors hover:bg-gray-50"
              style={{ borderColor: accentColor, color: accentColor }}
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
              </svg>
              Descargar XML
            </a>
          </div>
        </div>
      </div>
    );
  }

  /* --- Form state (and error-with-order state) --- */
  return (
    <div className="min-h-screen bg-gray-50 py-6 px-4">
      <div className="max-w-lg mx-auto space-y-4">
        {/* Tenant header */}
        <div className="text-center pt-2 pb-2">
          {order?.tenant_logo && (
            <img src={order.tenant_logo} alt={order.tenant_name} className="h-12 mx-auto mb-2 object-contain" />
          )}
          <h1 className="text-lg font-semibold text-gray-900">{order?.tenant_name}</h1>
          <p className="text-sm text-gray-500">Solicitud de factura</p>
        </div>

        {/* Order summary card */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-gray-900">Resumen de orden</h2>
            <span className="text-xs text-gray-400 font-mono">{order?.order_number}</span>
          </div>

          {order?.date && (
            <p className="text-xs text-gray-400 mb-3">{formatDate(order.date)}</p>
          )}

          {/* Items */}
          <div className="divide-y divide-gray-100">
            {order?.items.map((item, idx) => (
              <div key={idx} className="flex items-center justify-between py-2">
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-gray-700 truncate">
                    {item.quantity > 1 && (
                      <span className="text-gray-400 mr-1">{item.quantity}x</span>
                    )}
                    {item.item_name}
                  </p>
                </div>
                <p className="text-sm text-gray-600 ml-4 flex-shrink-0">
                  {formatMXN(item.unit_price * item.quantity)}
                </p>
              </div>
            ))}
          </div>

          {/* Totals */}
          <div className="border-t border-gray-200 mt-3 pt-3 space-y-1">
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">Subtotal</span>
              <span className="text-gray-700">{order ? formatMXN(order.subtotal) : ''}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">IVA (16%)</span>
              <span className="text-gray-700">{order ? formatMXN(order.tax) : ''}</span>
            </div>
            <div className="flex justify-between text-sm font-semibold">
              <span className="text-gray-900">Total</span>
              <span className="text-gray-900">{order ? formatMXN(order.total) : ''}</span>
            </div>
          </div>
        </div>

        {/* Error banner (when order is loaded but submission failed) */}
        {pageState === 'error' && errorInfo && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-start gap-3">
            <svg className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div>
              <p className="text-sm text-red-800 font-medium">Error al generar la factura</p>
              <p className="text-sm text-red-600 mt-1">{errorInfo.message}</p>
              <button
                type="button"
                onClick={() => { setPageState('form'); setErrorInfo(null); }}
                className="mt-2 text-sm font-medium underline"
                style={{ color: accentColor }}
              >
                Intentar de nuevo
              </button>
            </div>
          </div>
        )}

        {/* Invoice form */}
        <form onSubmit={handleSubmit} className="bg-white rounded-xl shadow-sm border border-gray-200 p-5 space-y-4">
          <h2 className="text-sm font-semibold text-gray-900 mb-1">Datos fiscales</h2>

          {/* RFC */}
          <div>
            <label htmlFor="rfc" className="block text-sm font-medium text-gray-700 mb-1">
              RFC
            </label>
            <input
              id="rfc"
              type="text"
              maxLength={13}
              placeholder="XAXX010101000"
              value={form.rfc}
              onChange={e => updateField('rfc', e.target.value.toUpperCase())}
              className={`w-full rounded-lg border px-3 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 transition-colors ${
                formErrors.rfc ? 'border-red-300 focus:ring-red-400' : 'border-gray-300 focus:ring-opacity-50'
              }`}
              style={!formErrors.rfc ? { '--tw-ring-color': accentColor } as React.CSSProperties : undefined}
              autoComplete="off"
              autoCapitalize="characters"
            />
            {formErrors.rfc && <p className="text-xs text-red-500 mt-1">{formErrors.rfc}</p>}
          </div>

          {/* Razon Social */}
          <div>
            <label htmlFor="name" className="block text-sm font-medium text-gray-700 mb-1">
              Razon Social
            </label>
            <input
              id="name"
              type="text"
              placeholder="Nombre o empresa"
              value={form.name}
              onChange={e => updateField('name', e.target.value)}
              className={`w-full rounded-lg border px-3 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 transition-colors ${
                formErrors.name ? 'border-red-300 focus:ring-red-400' : 'border-gray-300 focus:ring-opacity-50'
              }`}
              style={!formErrors.name ? { '--tw-ring-color': accentColor } as React.CSSProperties : undefined}
              autoComplete="off"
            />
            {formErrors.name && <p className="text-xs text-red-500 mt-1">{formErrors.name}</p>}
          </div>

          {/* Regimen Fiscal */}
          <div>
            <label htmlFor="tax_regime" className="block text-sm font-medium text-gray-700 mb-1">
              Regimen Fiscal
            </label>
            <select
              id="tax_regime"
              value={form.tax_regime}
              onChange={e => updateField('tax_regime', e.target.value)}
              className={`w-full rounded-lg border px-3 py-2.5 text-sm text-gray-900 bg-white focus:outline-none focus:ring-2 transition-colors ${
                formErrors.tax_regime ? 'border-red-300 focus:ring-red-400' : 'border-gray-300 focus:ring-opacity-50'
              }`}
              style={!formErrors.tax_regime ? { '--tw-ring-color': accentColor } as React.CSSProperties : undefined}
            >
              {TAX_REGIMES.map(r => (
                <option key={r.code} value={r.code}>
                  {r.code} - {r.name}
                </option>
              ))}
            </select>
            {formErrors.tax_regime && <p className="text-xs text-red-500 mt-1">{formErrors.tax_regime}</p>}
          </div>

          {/* Codigo Postal */}
          <div>
            <label htmlFor="postal_code" className="block text-sm font-medium text-gray-700 mb-1">
              Codigo Postal
            </label>
            <input
              id="postal_code"
              type="text"
              inputMode="numeric"
              maxLength={5}
              placeholder="00000"
              value={form.postal_code}
              onChange={e => updateField('postal_code', e.target.value.replace(/\D/g, ''))}
              className={`w-full rounded-lg border px-3 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 transition-colors ${
                formErrors.postal_code ? 'border-red-300 focus:ring-red-400' : 'border-gray-300 focus:ring-opacity-50'
              }`}
              style={!formErrors.postal_code ? { '--tw-ring-color': accentColor } as React.CSSProperties : undefined}
              autoComplete="postal-code"
            />
            {formErrors.postal_code && <p className="text-xs text-red-500 mt-1">{formErrors.postal_code}</p>}
          </div>

          {/* Uso de CFDI */}
          <div>
            <label htmlFor="uso_cfdi" className="block text-sm font-medium text-gray-700 mb-1">
              Uso de CFDI
            </label>
            <select
              id="uso_cfdi"
              value={form.uso_cfdi}
              onChange={e => updateField('uso_cfdi', e.target.value)}
              className={`w-full rounded-lg border px-3 py-2.5 text-sm text-gray-900 bg-white focus:outline-none focus:ring-2 transition-colors ${
                formErrors.uso_cfdi ? 'border-red-300 focus:ring-red-400' : 'border-gray-300 focus:ring-opacity-50'
              }`}
              style={!formErrors.uso_cfdi ? { '--tw-ring-color': accentColor } as React.CSSProperties : undefined}
            >
              {USO_CFDI.map(u => (
                <option key={u.code} value={u.code}>
                  {u.code} - {u.name}
                </option>
              ))}
            </select>
            {formErrors.uso_cfdi && <p className="text-xs text-red-500 mt-1">{formErrors.uso_cfdi}</p>}
          </div>

          {/* Submit */}
          <button
            type="submit"
            disabled={pageState === 'submitting'}
            className="w-full flex items-center justify-center gap-2 py-3 px-4 rounded-lg text-white font-medium text-sm transition-opacity hover:opacity-90 disabled:opacity-60 disabled:cursor-not-allowed mt-2"
            style={{ backgroundColor: accentColor }}
          >
            {pageState === 'submitting' ? (
              <>
                <Spinner size="h-4 w-4" color="#ffffff" />
                Generando factura...
              </>
            ) : (
              <>
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                Generar Factura
              </>
            )}
          </button>
        </form>

        {/* Footer */}
        <p className="text-center text-xs text-gray-400 pb-4">
          CFDI 4.0 &middot; Factura electronica generada conforme a las disposiciones del SAT
        </p>
      </div>
    </div>
  );
};

export default PublicInvoiceScreen;
