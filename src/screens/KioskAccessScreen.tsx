import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { QRCodeSVG } from 'qrcode.react';
import { ArrowLeft, MonitorSmartphone, ExternalLink, Copy, Check, FileDown } from 'lucide-react';
import { useTenant } from '../App';
import { tenantUrl } from '../lib/tenantResolver';
import BrandLogo from '../components/BrandLogo';

/**
 * Kiosco — surfaces the tenant's self-service kiosk to the owner.
 *
 * The kiosk is a web app served at <subdomain>.desktop.kitchen/kiosk (a real
 * path, not a hash route — see server/index.js static mount). Until now there
 * was NO in-product way for a restaurant to find that URL; a self-serve buyer
 * had no path to launch their kiosk. This screen closes that: QR to open on a
 * tablet, the URL to copy, a one-tap open button, setup instructions, and the
 * quick-start guide download. Pure frontend — no backend calls.
 */
const KioskAccessScreen: React.FC = () => {
  const { t } = useTranslation('cockpit');
  const { mode, tenantSlug } = useTenant();
  const [copied, setCopied] = useState(false);

  const kioskUrl = useMemo(() => {
    const base = mode === 'tenant' && tenantSlug ? tenantUrl(tenantSlug) : window.location.origin;
    return `${base}/kiosk`;
  }, [mode, tenantSlug]);

  const handleCopy = () => {
    navigator.clipboard.writeText(kioskUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const steps: string[] = t('kioskAccess.steps', { returnObjects: true }) as unknown as string[];

  return (
    <div className="min-h-screen bg-neutral-950 text-white">
      {/* Header */}
      <header className="border-b border-neutral-800">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Link
              to="/admin/cockpit"
              className="min-h-10 min-w-10 flex items-center justify-center rounded-lg border border-neutral-700 text-neutral-300 hover:border-brand-500 hover:text-white transition-colors"
            >
              <ArrowLeft size={18} />
            </Link>
            <div className="w-10 h-10 rounded-lg bg-brand-600/20 text-brand-500 flex items-center justify-center">
              <MonitorSmartphone size={20} />
            </div>
            <div>
              <h1 className="font-bold leading-tight">{t('kioskAccess.title')}</h1>
              <p className="text-xs text-neutral-500">{t('kioskAccess.subtitle')}</p>
            </div>
          </div>
          <BrandLogo className="h-8" />
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 sm:px-6 py-8 grid md:grid-cols-2 gap-6">
        {/* QR + URL card */}
        <div className="bg-white text-neutral-900 rounded-2xl p-6 flex flex-col items-center gap-4">
          <div className="text-sm font-semibold text-neutral-500 uppercase tracking-wide">
            {t('kioskAccess.scanTitle')}
          </div>
          <QRCodeSVG value={kioskUrl} size={196} marginSize={1} />
          <div className="w-full">
            <div className="flex items-stretch gap-2">
              <div className="flex-1 min-w-0 px-3 py-2 rounded-lg bg-neutral-100 border border-neutral-200 text-sm font-mono text-neutral-700 truncate flex items-center">
                {kioskUrl.replace('https://', '')}
              </div>
              <button
                onClick={handleCopy}
                className="min-h-10 px-3 rounded-lg bg-neutral-900 text-white text-sm font-semibold flex items-center gap-1.5 hover:bg-neutral-700 transition-colors"
              >
                {copied ? <><Check size={15} /> {t('kioskAccess.copied')}</> : <><Copy size={15} /> {t('kioskAccess.copy')}</>}
              </button>
            </div>
          </div>
          <a
            href={kioskUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="w-full min-h-11 rounded-xl bg-brand-600 hover:bg-brand-500 text-white font-bold flex items-center justify-center gap-2 transition-colors"
          >
            <ExternalLink size={18} /> {t('kioskAccess.open')}
          </a>
        </div>

        {/* Instructions card */}
        <div className="bg-neutral-900 border border-neutral-800 rounded-2xl p-6 flex flex-col">
          <h2 className="text-lg font-bold mb-1">{t('kioskAccess.howTitle')}</h2>
          <p className="text-neutral-400 text-sm mb-5">{t('kioskAccess.howSubtitle')}</p>

          <ol className="space-y-4 flex-1">
            {Array.isArray(steps) && steps.map((step, i) => (
              <li key={i} className="flex gap-3">
                <span className="flex-shrink-0 w-7 h-7 rounded-full bg-brand-600/20 text-brand-400 font-bold text-sm flex items-center justify-center">
                  {i + 1}
                </span>
                <span className="text-neutral-200 text-sm leading-relaxed pt-0.5">{step}</span>
              </li>
            ))}
          </ol>

          <div className="mt-6 pt-5 border-t border-neutral-800">
            <a
              href="/guia-inicio-rapido.pdf"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 text-brand-400 hover:text-brand-300 font-semibold text-sm transition-colors"
            >
              <FileDown size={16} /> {t('kioskAccess.downloadGuide')}
            </a>
            <p className="text-neutral-500 text-xs mt-2">{t('kioskAccess.tip')}</p>
          </div>
        </div>
      </main>
    </div>
  );
};

export default KioskAccessScreen;
