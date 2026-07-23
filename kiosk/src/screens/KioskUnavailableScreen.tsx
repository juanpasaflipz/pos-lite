import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useKioskBinding } from '../context/KioskBindingContext';
import { probeKioskPlan } from '../lib/kioskApi';

/**
 * Shown when the tenant's plan doesn't include the kiosk (Pro feature,
 * repackaged 2026-07-23) — e.g. the signup trial expired. Customer-facing and
 * calm: point people to the counter; never show pricing or error jargon to a
 * customer. The binding is preserved, so the moment the tenant upgrades, the
 * retry probe brings the kiosk back with no re-pairing.
 */
const KioskUnavailableScreen: React.FC = () => {
  const { t } = useTranslation();
  const { tenantId, tenantName, kioskToken, clearPlanLock } = useKioskBinding();
  const [checking, setChecking] = useState(false);

  const retry = useCallback(async () => {
    if (!tenantId || !kioskToken || checking) return;
    setChecking(true);
    try {
      const ok = await probeKioskPlan({ tenantId, kioskToken });
      if (ok) clearPlanLock();
    } finally {
      setChecking(false);
    }
  }, [tenantId, kioskToken, checking, clearPlanLock]);

  // Auto-probe every 5 minutes so an upgrade (or plan fix) restores the
  // kiosk without anyone touching the tablet.
  useEffect(() => {
    const id = setInterval(retry, 5 * 60_000);
    return () => clearInterval(id);
  }, [retry]);

  return (
    <div className="min-h-screen bg-neutral-950 flex flex-col items-center justify-center px-10 text-center select-none">
      {tenantName && (
        <p className="text-neutral-500 text-lg font-semibold tracking-[0.25em] uppercase mb-6">{tenantName}</p>
      )}
      <h1 className="text-white text-5xl font-black mb-4">{t('unavailable.title')}</h1>
      <p className="text-neutral-400 text-2xl mb-12">{t('unavailable.subtitle')}</p>
      <button
        onClick={retry}
        disabled={checking}
        className="px-8 py-4 rounded-2xl border border-neutral-700 text-neutral-300 text-lg font-semibold hover:bg-neutral-900 transition-colors disabled:opacity-50"
      >
        {checking ? t('unavailable.checking') : t('unavailable.retry')}
      </button>
      <p className="text-neutral-600 text-sm mt-14 max-w-md">{t('unavailable.staffNote')}</p>
    </div>
  );
};

export default KioskUnavailableScreen;
