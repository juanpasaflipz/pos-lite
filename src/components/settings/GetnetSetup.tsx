import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { getGetnetStatus, setupGetnet, disableGetnet } from '../../api';
import { usePlan } from '../../context/PlanContext';

const GetnetSetup: React.FC = () => {
  const { t } = useTranslation('admin');
  const { refresh } = usePlan();
  const [status, setStatus] = useState<{ configured: boolean; enabled: boolean; tapOnPhoneEnabled: boolean; environment: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Form fields
  const [merchantId, setMerchantId] = useState('');
  const [terminalId, setTerminalId] = useState('');
  const [environment, setEnvironment] = useState('sandbox');
  const [tapOnPhone, setTapOnPhone] = useState(false);

  useEffect(() => {
    loadStatus();
  }, []);

  const loadStatus = async () => {
    try {
      const s = await getGetnetStatus();
      setStatus(s);
      if (s.environment) setEnvironment(s.environment);
      if (s.tapOnPhoneEnabled) setTapOnPhone(s.tapOnPhoneEnabled);
    } catch {
      // Not configured
    } finally {
      setLoading(false);
    }
  };

  const handleSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      await setupGetnet({
        merchant_id: merchantId,
        terminal_id: terminalId || undefined,
        environment,
        tap_on_phone_enabled: tapOnPhone,
      });
      setSuccess(t('getnet.configuredSuccess'));
      await loadStatus();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('getnet.errorConfiguring'));
    } finally {
      setSaving(false);
    }
  };

  const handleDisable = async () => {
    setSaving(true);
    setError('');
    try {
      await disableGetnet();
      setSuccess(t('getnet.disabled'));
      await loadStatus();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('getnet.errorDisabling'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="text-neutral-400 text-center py-8">{t('common:states.loading')}</div>;
  }

  return (
    <div className="bg-neutral-900 rounded-xl p-6 border border-neutral-800">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-lg font-bold text-white">{t('getnet.title')}</h3>
          <p className="text-sm text-neutral-400">{t('getnet.subtitle')}</p>
        </div>
        {status?.enabled && (
          <span className="px-3 py-1 bg-green-600/20 text-green-400 text-sm font-semibold rounded-full">
            {t('getnet.active')}
          </span>
        )}
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-600/10 border border-red-600/30 rounded-lg text-red-400 text-sm">
          {error}
        </div>
      )}
      {success && (
        <div className="mb-4 p-3 bg-green-600/10 border border-green-600/30 rounded-lg text-green-400 text-sm">
          {success}
        </div>
      )}

      <p className="text-sm text-neutral-400 mb-4">
        {t('getnet.credentialsNote')}
      </p>

      <form onSubmit={handleSetup} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-neutral-300 mb-1">{t('getnet.merchantId')}</label>
          <input
            type="text"
            value={merchantId}
            onChange={(e) => setMerchantId(e.target.value)}
            placeholder={t('getnet.merchantIdPlaceholder')}
            className="w-full bg-neutral-800 border border-neutral-700 rounded-lg p-3 text-white focus:outline-none focus:border-brand-600"
            required
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-neutral-300 mb-1">{t('getnet.terminalId')}</label>
          <input
            type="text"
            value={terminalId}
            onChange={(e) => setTerminalId(e.target.value)}
            placeholder={t('getnet.terminalIdPlaceholder')}
            className="w-full bg-neutral-800 border border-neutral-700 rounded-lg p-3 text-white focus:outline-none focus:border-brand-600"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-neutral-300 mb-1">{t('getnet.environment')}</label>
          <select
            value={environment}
            onChange={(e) => setEnvironment(e.target.value)}
            className="w-full bg-neutral-800 border border-neutral-700 rounded-lg p-3 text-white focus:outline-none focus:border-brand-600"
          >
            <option value="sandbox">{t('getnet.sandbox')}</option>
            <option value="production">{t('getnet.production')}</option>
          </select>
        </div>

        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={tapOnPhone}
            onChange={(e) => setTapOnPhone(e.target.checked)}
            className="w-5 h-5 rounded bg-neutral-800 border-neutral-700 text-brand-600 focus:ring-brand-600"
          />
          <span className="text-sm text-neutral-300">{t('getnet.enableTapOnPhone')}</span>
        </label>

        <div className="flex gap-3">
          <button
            type="submit"
            disabled={saving || !merchantId}
            className="flex-1 py-3 bg-brand-600 text-white font-bold rounded-lg hover:bg-brand-700 disabled:bg-neutral-700 transition-all"
          >
            {saving ? t('common:states.loading') : status?.enabled ? t('common:buttons.update') : t('getnet.activate')}
          </button>
          {status?.enabled && (
            <button
              type="button"
              onClick={handleDisable}
              disabled={saving}
              className="px-6 py-3 bg-red-600/20 text-red-400 font-bold rounded-lg hover:bg-red-600/30 transition-all"
            >
              {t('common:buttons.disable')}
            </button>
          )}
        </div>
      </form>
    </div>
  );
};

export default GetnetSetup;
