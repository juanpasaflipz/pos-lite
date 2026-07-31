import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  MessageCircle,
  Copy,
  Check,
  ExternalLink,
  Receipt,
  Boxes,
  Mic,
  Users,
  Lightbulb,
  ShieldCheck,
  AlertTriangle,
  Loader2,
  Smartphone,
} from 'lucide-react';
import BrandLogo from '../components/BrandLogo';
import { getWhatsAppStatus, type WhatsAppStatus } from '../api';

/**
 * Ops por WhatsApp — the owner-facing explainer for the inbound voice/photo
 * pipeline (helpers/inboundVoiceOps.js + receiptVision.js).
 *
 * The feature was live with no in-product surface: an owner had no way to learn
 * which number to message, who is allowed to message it, or what happens after
 * they do. That made the two support questions ("which number?" / "I sent a
 * photo and nothing happened") unanswerable without asking us. This screen is
 * the answer to both, in that order — number first, eligibility second.
 *
 * Read-only by design. Connecting a number is an ADMIN_SECRET flow
 * (routes/wa-onboarding.js) that we drive with the owner, not a self-serve
 * toggle, so there is nothing to configure here.
 */
const WhatsAppOpsScreen: React.FC = () => {
  const { t } = useTranslation('cockpit');
  const [status, setStatus] = useState<WhatsAppStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getWhatsAppStatus()
      .then((data) => {
        if (!cancelled) setStatus(data);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const phone = status?.display_phone_number || null;
  // The server pretty-prints for reading ("+52 55 1234 5678"); wa.me wants the
  // bare digits, and prettyPhone preserves every one of them.
  const waLink = useMemo(() => {
    const digits = (phone || '').replace(/\D/g, '');
    return digits ? `https://wa.me/${digits}` : null;
  }, [phone]);

  const handleCopy = () => {
    if (!phone) return;
    navigator.clipboard.writeText(phone).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const steps = t('whatsappOps.how.steps', { returnObjects: true }) as unknown as string[];
  const tips = t('whatsappOps.tips.items', { returnObjects: true }) as unknown as string[];

  const flows = [
    { key: 'receipt', icon: <Receipt size={20} /> },
    { key: 'count', icon: <Boxes size={20} /> },
    { key: 'voice', icon: <Mic size={20} /> },
  ] as const;

  const connected = !!status?.connected;
  const statusLabel = !connected
    ? t('whatsappOps.status.notConnected')
    : status?.source === 'tenant'
      ? t('whatsappOps.status.connectedTenant')
      : t('whatsappOps.status.connectedPlatform');

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
              <MessageCircle size={20} />
            </div>
            <div>
              <h1 className="font-bold leading-tight">{t('whatsappOps.title')}</h1>
              <p className="text-xs text-neutral-500">{t('whatsappOps.subtitle')}</p>
            </div>
          </div>
          <BrandLogo className="h-8" />
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 sm:px-6 py-8 space-y-6">
        {/* The number — the first question an owner has */}
        <section className="bg-neutral-900 border border-neutral-800 rounded-2xl p-6">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <h2 className="text-lg font-bold">{t('whatsappOps.status.title')}</h2>
            {!loading && !error && (
              <span
                className={`text-xs font-semibold px-2.5 py-1 rounded-full ${
                  connected
                    ? 'bg-emerald-500/15 text-emerald-400'
                    : 'bg-neutral-800 text-neutral-400'
                }`}
              >
                {statusLabel}
              </span>
            )}
          </div>

          {loading && (
            <div className="flex items-center gap-2 text-neutral-500 text-sm mt-4">
              <Loader2 size={16} className="animate-spin" />
            </div>
          )}

          {error && (
            <p className="text-neutral-400 text-sm mt-4">{t('whatsappOps.status.noNumberYet')}</p>
          )}

          {!loading && !error && (
            <>
              {phone ? (
                <div className="mt-4">
                  <div className="flex items-stretch gap-2 flex-wrap">
                    <div className="flex-1 min-w-[12rem] px-4 py-3 rounded-xl bg-neutral-950 border border-neutral-800 text-xl font-bold font-mono tracking-wide flex items-center">
                      {phone}
                    </div>
                    <button
                      onClick={handleCopy}
                      className="min-h-12 px-4 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-white text-sm font-semibold flex items-center gap-1.5 transition-colors"
                    >
                      {copied ? (
                        <>
                          <Check size={15} /> {t('whatsappOps.status.copied')}
                        </>
                      ) : (
                        <>
                          <Copy size={15} /> {t('whatsappOps.status.copy')}
                        </>
                      )}
                    </button>
                    {waLink && (
                      <a
                        href={waLink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="min-h-12 px-4 rounded-xl bg-brand-600 hover:bg-brand-500 text-white text-sm font-bold flex items-center gap-2 transition-colors"
                      >
                        <ExternalLink size={16} /> {t('whatsappOps.status.openChat')}
                      </a>
                    )}
                  </div>
                  <p className="text-neutral-500 text-xs mt-3">{t('whatsappOps.status.save')}</p>
                  {status?.source === 'platform' && (
                    <p className="text-neutral-400 text-sm mt-3 leading-relaxed">
                      {t('whatsappOps.status.platformNote')}
                    </p>
                  )}
                </div>
              ) : connected ? (
                // Connected on the platform number, but WA_CLOUD_DISPLAY_PHONE_NUMBER
                // isn't set. Saying "not connected" here would be wrong — messages
                // to that number do work; we just can't print it.
                <p className="text-neutral-400 text-sm mt-4 leading-relaxed">
                  {t('whatsappOps.status.platformNote')}
                </p>
              ) : (
                <div className="mt-4">
                  <p className="font-semibold text-neutral-200">
                    {t('whatsappOps.status.noNumberYet')}
                  </p>
                  <p className="text-neutral-400 text-sm mt-2 leading-relaxed">
                    {t('whatsappOps.status.notConnectedBody')}
                  </p>
                </div>
              )}
            </>
          )}
        </section>

        {/* Photo → inventory shipped in the mobile POS (1.5.0) and does NOT
            need WhatsApp. Without this block the page reads as "the feature is
            blocked on Meta", which stopped being true — an owner would leave
            here waiting on an approval queue for something already on their
            phone. Deliberately placed above "who can use it": the eligibility
            rules below apply only to the WhatsApp doorway. */}
        <section className="bg-emerald-500/5 border border-emerald-500/25 rounded-2xl p-6">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-500/15 flex items-center justify-center shrink-0">
              <Smartphone size={20} className="text-emerald-400" />
            </div>
            <h2 className="text-lg font-bold">{t('whatsappOps.inApp.title')}</h2>
          </div>

          <p className="text-neutral-300 text-sm mt-4 leading-relaxed">
            {t('whatsappOps.inApp.body')}
          </p>

          <p className="text-neutral-200 text-sm mt-3 font-semibold leading-relaxed">
            {t('whatsappOps.inApp.where')}
          </p>
          <p className="text-neutral-500 text-xs mt-1">{t('whatsappOps.inApp.roles')}</p>

          {/* No link: /m/scan-photo only renders on a phone (see TenantRoutes),
              so a button here would dead-end on the desktop this screen lives on. */}
          <p className="text-neutral-400 text-sm mt-4 leading-relaxed border-t border-emerald-500/15 pt-4">
            {t('whatsappOps.inApp.andWhatsApp')}
          </p>
        </section>

        {/* Who can use it — the second question, and the #1 support ticket */}
        <section className="bg-neutral-900 border border-neutral-800 rounded-2xl p-6">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-brand-600/20 text-brand-500 flex items-center justify-center shrink-0">
              <Users size={20} />
            </div>
            <h2 className="text-lg font-bold">{t('whatsappOps.who.title')}</h2>
          </div>
          <p className="text-neutral-400 text-sm mt-3 leading-relaxed">
            {t('whatsappOps.who.body')}
          </p>

          {!loading && !error && status && (
            <>
              {status.eligible.length > 0 ? (
                <ul className="mt-4 divide-y divide-neutral-800 border border-neutral-800 rounded-xl overflow-hidden">
                  {status.eligible.map((emp) => (
                    <li
                      key={emp.id}
                      className="flex items-center justify-between gap-3 px-4 py-3 bg-neutral-950/50"
                    >
                      <div className="min-w-0">
                        <div className="font-semibold text-sm truncate">{emp.name}</div>
                        <div className="text-xs text-neutral-500 capitalize">{emp.role}</div>
                      </div>
                      <span className="text-sm font-mono text-neutral-300 shrink-0">
                        {emp.phone_masked}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-4 text-sm text-neutral-300 bg-neutral-950/50 border border-neutral-800 rounded-xl px-4 py-3">
                  {t('whatsappOps.who.empty')}
                </p>
              )}

              {status.missing_phone_count > 0 && (
                <div className="mt-3 flex items-start gap-2 text-amber-400 text-sm">
                  <AlertTriangle size={16} className="shrink-0 mt-0.5" />
                  <span>{t('whatsappOps.who.missing', { count: status.missing_phone_count })}</span>
                </div>
              )}

              <Link
                to="/admin/staff?tab=roster"
                className="inline-flex items-center gap-2 mt-4 min-h-10 text-brand-400 hover:text-brand-300 font-semibold text-sm transition-colors"
              >
                {t('whatsappOps.who.cta')}
              </Link>
            </>
          )}

          <p className="text-neutral-500 text-xs mt-4 leading-relaxed border-t border-neutral-800 pt-4">
            {t('whatsappOps.who.customersNote')}
          </p>
        </section>

        {/* What you can send */}
        <section>
          <h2 className="text-lg font-bold mb-4">{t('whatsappOps.flows.title')}</h2>
          <div className="grid md:grid-cols-3 gap-4">
            {flows.map((flow) => (
              <div
                key={flow.key}
                className="bg-neutral-900 border border-neutral-800 rounded-2xl p-5 flex flex-col"
              >
                <div className="w-10 h-10 rounded-lg bg-brand-600/20 text-brand-500 flex items-center justify-center">
                  {flow.icon}
                </div>
                <h3 className="font-bold text-sm mt-3">
                  {t(`whatsappOps.flows.${flow.key}.title`)}
                </h3>
                <p className="text-neutral-400 text-sm mt-2 leading-relaxed">
                  {t(`whatsappOps.flows.${flow.key}.body`)}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* How it works */}
        <section className="bg-neutral-900 border border-neutral-800 rounded-2xl p-6">
          <h2 className="text-lg font-bold">{t('whatsappOps.how.title')}</h2>
          <p className="text-neutral-400 text-sm mt-1">{t('whatsappOps.how.subtitle')}</p>
          <ol className="space-y-4 mt-5">
            {Array.isArray(steps) &&
              steps.map((step, i) => (
                <li key={i} className="flex gap-3">
                  <span className="flex-shrink-0 w-7 h-7 rounded-full bg-brand-600/20 text-brand-400 font-bold text-sm flex items-center justify-center">
                    {i + 1}
                  </span>
                  <span className="text-neutral-200 text-sm leading-relaxed pt-0.5">{step}</span>
                </li>
              ))}
          </ol>
        </section>

        {/* Tips */}
        <section className="bg-neutral-900 border border-neutral-800 rounded-2xl p-6">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-brand-600/20 text-brand-500 flex items-center justify-center shrink-0">
              <Lightbulb size={20} />
            </div>
            <h2 className="text-lg font-bold">{t('whatsappOps.tips.title')}</h2>
          </div>
          <ul className="mt-4 space-y-3">
            {Array.isArray(tips) &&
              tips.map((tip, i) => (
                <li key={i} className="flex gap-3 text-neutral-300 text-sm leading-relaxed">
                  <span className="text-brand-500 font-bold shrink-0">·</span>
                  <span>{tip}</span>
                </li>
              ))}
          </ul>
        </section>

        {/* Privacy */}
        <div className="flex items-start gap-2 text-neutral-500 text-xs leading-relaxed pb-4">
          <ShieldCheck size={15} className="shrink-0 mt-0.5" />
          <span>{t('whatsappOps.privacy')}</span>
        </div>
      </main>
    </div>
  );
};

export default WhatsAppOpsScreen;
