import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { getGetnetSavings } from '../../api';
import { formatPrice } from '../../utils/currency';
import { usePlan } from '../../context/PlanContext';

const GetnetUpgradePrompt: React.FC = () => {
  const { t } = useTranslation('admin');
  const { plan } = usePlan();
  const [savings, setSavings] = useState<{
    monthlySavings: number;
    totalVolume: number;
    currentFees: number;
    proFees: number;
  } | null>(null);

  useEffect(() => {
    if (plan !== 'free') return;
    getGetnetSavings(30).then(setSavings).catch(() => {});
  }, [plan]);

  // Only show for free plan users with enough volume
  if (plan !== 'free' || !savings || savings.monthlySavings < 50) return null;

  return (
    <div className="bg-gradient-to-r from-brand-600/10 to-brand-800/10 border border-brand-600/30 rounded-xl p-4 space-y-2">
      <div className="flex items-center gap-2">
        <svg className="w-5 h-5 text-brand-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
        </svg>
        <p className="text-white font-bold text-sm">
          {t('getnet.saveWithPro', { amount: formatPrice(savings.monthlySavings) })}
        </p>
      </div>
      <p className="text-neutral-400 text-xs">
        {t('getnet.upgradeDescription', { volume: formatPrice(savings.totalVolume), savings: formatPrice(savings.monthlySavings) })}
      </p>
    </div>
  );
};

export default GetnetUpgradePrompt;
