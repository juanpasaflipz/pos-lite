import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getDemoAccess } from '../../api/salesApi';

export default function SalesDemoAccess() {
  const { t } = useTranslation('sales');
  const [demoUrl, setDemoUrl] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  const handleGenerate = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await getDemoAccess();
      setDemoUrl(res.demo_url);
      setExpiresAt(res.expires_at);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(demoUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-6 max-w-lg">
      <h1 className="text-2xl font-bold text-white">{t('demo.title')}</h1>

      <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5 space-y-5">
        <p className="text-sm text-neutral-400">
          Generate a temporary demo link for prospects. The link provides full access to a demo tenant for evaluation purposes.
        </p>

        <button
          onClick={handleGenerate}
          disabled={loading}
          className="px-5 py-2.5 bg-brand-600 hover:bg-brand-700 text-white font-medium rounded-lg transition disabled:opacity-50"
        >
          {loading ? '...' : t('demo.generateLink')}
        </button>

        {error && (
          <div className="text-red-400 text-sm bg-red-900/20 border border-red-800 rounded-lg px-3 py-2">
            {error}
          </div>
        )}

        {demoUrl && (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
              <p className="text-sm font-medium text-green-400">{t('demo.linkReady')}</p>
            </div>

            <div className="flex items-center gap-2">
              <code className="flex-1 bg-neutral-800 px-3 py-2.5 rounded-lg text-brand-400 text-sm break-all">
                {demoUrl}
              </code>
              <button
                onClick={handleCopy}
                className="px-4 py-2.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 text-sm rounded-lg transition flex-shrink-0"
              >
                {copied ? 'Copied!' : t('demo.copyUrl')}
              </button>
            </div>

            <p className="text-xs text-neutral-500">
              {t('demo.expiresIn')}
              {expiresAt && (
                <span className="ml-1 text-neutral-600">
                  ({new Date(expiresAt).toLocaleString()})
                </span>
              )}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
