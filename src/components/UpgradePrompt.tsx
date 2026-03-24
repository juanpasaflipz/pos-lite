import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Lock, ArrowUpCircle } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { usePlan } from '../context/PlanContext';
import { createCheckoutSession } from '../api';

interface UpgradePromptProps {
  variant?: 'inline' | 'overlay';
  message?: string;
  feature?: string;
}

const UpgradePrompt: React.FC<UpgradePromptProps> = ({
  variant = 'inline',
  message,
  feature,
}) => {
  const { t } = useTranslation('common');
  const navigate = useNavigate();
  const { plan } = usePlan();
  const [loading, setLoading] = useState(false);

  const defaultMessage = feature
    ? t('upgrade.featureRequiresPro', { feature })
    : t('upgrade.requiresPro');

  const handleUpgrade = async () => {
    const token = localStorage.getItem('owner_token');
    if (!token) {
      navigate('/admin');
      return;
    }
    setLoading(true);
    try {
      const { url } = await createCheckoutSession('pro');
      window.location.href = url;
    } catch {
      navigate('/admin');
    }
  };

  if (variant === 'overlay') {
    return (
      <div className="absolute inset-0 z-10 bg-neutral-950/80 backdrop-blur-sm flex items-center justify-center rounded-lg">
        <div className="bg-neutral-900 border border-neutral-700 rounded-xl p-8 max-w-sm text-center space-y-4">
          <Lock className="w-10 h-10 text-neutral-500 mx-auto" />
          <h3 className="text-lg font-bold text-white">{message || defaultMessage}</h3>
          <p className="text-sm text-neutral-400">
            {t('upgrade.onPlanText')} <span className="text-brand-400 font-medium capitalize">{plan}</span> {t('upgrade.planSuffix')}
          </p>
          <button
            onClick={handleUpgrade}
            disabled={loading}
            className="inline-flex items-center gap-2 px-6 py-2.5 bg-brand-600 text-white font-semibold rounded-lg hover:bg-brand-700 transition-colors disabled:opacity-50"
          >
            <ArrowUpCircle className="w-4 h-4" />
            {loading ? t('upgrade.redirecting') : t('upgrade.ctaPrice')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 px-4 py-3 bg-neutral-900 border border-neutral-700 rounded-lg">
      <Lock className="w-5 h-5 text-neutral-500 flex-shrink-0" />
      <span className="text-sm text-neutral-300 flex-1">{message || defaultMessage}</span>
      <button
        onClick={handleUpgrade}
        disabled={loading}
        className="flex-shrink-0 inline-flex items-center gap-1.5 px-4 py-1.5 bg-brand-600 text-white text-sm font-medium rounded-lg hover:bg-brand-700 transition-colors disabled:opacity-50"
      >
        <ArrowUpCircle className="w-3.5 h-3.5" />
        {loading ? t('upgrade.redirecting') : t('upgrade.ctaShort')}
      </button>
    </div>
  );
};

export default UpgradePrompt;
