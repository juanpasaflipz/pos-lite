import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { QRCodeSVG } from 'qrcode.react';
import { ArrowLeft, Printer, QrCode } from 'lucide-react';
import { useTenant } from '../App';
import { tenantUrl } from '../lib/tenantResolver';
import BrandLogo from '../components/BrandLogo';

/**
 * QR Menu — generates and prints the per-table QR codes that point customers
 * to the public ordering screen (/#/order?table=N, CustomerOrderScreen).
 *
 * Pure frontend: the ordering surface (routes/customer-order.js + /#/order)
 * already exists; this screen only produces the physical QR codes that were
 * the missing link. No backend calls.
 */

const MAX_TABLES = 100;

const QRMenuScreen: React.FC = () => {
  const { t } = useTranslation('qrMenu');
  const { mode, tenantSlug } = useTenant();
  const [tableCount, setTableCount] = useState(10);
  const [includeTakeaway, setIncludeTakeaway] = useState(true);

  const baseUrl = useMemo(() => {
    if (mode === 'tenant' && tenantSlug) return tenantUrl(tenantSlug);
    return window.location.origin;
  }, [mode, tenantSlug]);

  const orderUrl = (table?: number) =>
    `${baseUrl}/#/order${table ? `?table=${table}` : ''}`;

  const tables = useMemo(
    () => Array.from({ length: Math.min(Math.max(tableCount, 0), MAX_TABLES) }, (_, i) => i + 1),
    [tableCount],
  );

  return (
    <div className="min-h-screen bg-neutral-950 text-white print:bg-white">
      {/* Header + controls (hidden when printing) */}
      <header className="border-b border-neutral-800 print:hidden">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <Link
              to="/admin/cockpit"
              className="min-h-10 min-w-10 flex items-center justify-center rounded-lg border border-neutral-700 text-neutral-300 hover:border-brand-500 hover:text-white transition-colors"
            >
              <ArrowLeft size={18} />
            </Link>
            <div className="w-10 h-10 rounded-lg bg-brand-600/20 text-brand-500 flex items-center justify-center">
              <QrCode size={20} />
            </div>
            <div>
              <h1 className="font-bold leading-tight">{t('title')}</h1>
              <p className="text-xs text-neutral-500">{t('subtitle')}</p>
            </div>
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <label className="flex items-center gap-2 text-sm text-neutral-300">
              {t('tables')}
              <input
                type="number"
                min={0}
                max={MAX_TABLES}
                value={tableCount}
                onChange={(e) => setTableCount(parseInt(e.target.value) || 0)}
                className="w-20 min-h-10 px-3 py-2 rounded-lg bg-neutral-800 border border-neutral-700 text-white focus:outline-none focus:border-brand-500"
              />
            </label>
            <label className="flex items-center gap-2 text-sm text-neutral-300 cursor-pointer">
              <input
                type="checkbox"
                checked={includeTakeaway}
                onChange={(e) => setIncludeTakeaway(e.target.checked)}
                className="w-4 h-4 accent-[var(--brand-600,#A8542A)]"
              />
              {t('includeTakeaway')}
            </label>
            <button
              onClick={() => window.print()}
              className="min-h-10 px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-500 text-white font-semibold text-sm flex items-center gap-2 transition-colors"
            >
              <Printer size={16} />
              {t('print')}
            </button>
          </div>
        </div>
      </header>

      {/* QR grid */}
      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-6 print:p-0 print:max-w-none">
        {tables.length === 0 && !includeTakeaway ? (
          <p className="text-neutral-500 text-center py-16 print:hidden">{t('empty')}</p>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 print:grid-cols-2 print:gap-6">
            {includeTakeaway && (
              <QRCard
                title={t('takeaway')}
                subtitle={t('scanToOrder')}
                url={orderUrl()}
              />
            )}
            {tables.map((n) => (
              <QRCard
                key={n}
                title={t('table', { number: n })}
                subtitle={t('scanToOrder')}
                url={orderUrl(n)}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  );
};

const QRCard: React.FC<{ title: string; subtitle: string; url: string }> = ({
  title, subtitle, url,
}) => (
  <div className="bg-white text-neutral-900 rounded-2xl p-5 flex flex-col items-center gap-3 break-inside-avoid print:border print:border-neutral-300 print:rounded-xl">
    <div className="print:hidden">
      <BrandLogo />
    </div>
    <div className="text-lg font-bold">{title}</div>
    <QRCodeSVG value={url} size={160} marginSize={1} />
    <div className="text-sm text-neutral-600 text-center">{subtitle}</div>
    <div className="text-[10px] text-neutral-400 break-all text-center">{url}</div>
  </div>
);

export default QRMenuScreen;
