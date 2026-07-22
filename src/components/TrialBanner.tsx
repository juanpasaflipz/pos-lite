import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Sparkles, Gift, X, ArrowRight } from 'lucide-react';
import { usePlan } from '../context/PlanContext';

const DISMISSED_KEY = 'free_banner_dismissed';
const TRIAL_DISMISSED_KEY = 'trial_banner_dismissed';

/**
 * One slot, two states (freemium launch):
 *  - Active signup trial → amber countdown ("te quedan N días de Pro")
 *    with the founders-offer CTA. Re-appears each session on purpose.
 *  - Free plan (trial over or never had one) → the original upgrade nudge.
 */
const FreePlanBanner: React.FC = () => {
  const { t } = useTranslation('common');
  const navigate = useNavigate();
  const { plan, isTrial, trialDaysLeft } = usePlan();
  const [dismissed, setDismissed] = useState(() => sessionStorage.getItem(DISMISSED_KEY) === '1');
  const [trialDismissed, setTrialDismissed] = useState(() => sessionStorage.getItem(TRIAL_DISMISSED_KEY) === '1');

  if (isTrial && !trialDismissed) {
    return (
      <div className="mx-4 mt-3 bg-amber-500/10 border border-amber-500/40 rounded-xl px-5 py-2.5">
        <div className="flex items-center gap-3">
          <Gift size={16} className="text-amber-400 flex-shrink-0" />
          <span className="text-amber-200 text-sm font-medium flex-1">
            {trialDaysLeft === 1
              ? t('trial.bannerLastDay')
              : t('trial.banner', { days: trialDaysLeft ?? 0 })}
          </span>
          <button
            onClick={() => navigate('/admin/account')}
            className="flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-semibold bg-amber-600 hover:bg-amber-500 text-white transition-colors flex-shrink-0"
          >
            {t('trial.cta')} <ArrowRight size={12} />
          </button>
          <button
            onClick={() => { sessionStorage.setItem(TRIAL_DISMISSED_KEY, '1'); setTrialDismissed(true); }}
            className="text-amber-600 hover:text-amber-400 transition-colors p-1 flex-shrink-0"
            aria-label={t('demo.dismiss')}
          >
            <X size={14} />
          </button>
        </div>
      </div>
    );
  }

  if (plan !== 'free' || dismissed) return null;

  return (
    <div className="mx-4 mt-3 bg-brand-950/40 border border-brand-800/40 rounded-xl px-5 py-2.5">
      <div className="flex items-center gap-3">
        <Sparkles size={16} className="text-brand-400 flex-shrink-0" />
        <span className="text-brand-200 text-sm font-medium flex-1">
          {t('freePlan.banner')}
        </span>
        <button
          onClick={() => navigate('/admin/account')}
          className="flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-semibold bg-brand-700 hover:bg-brand-600 text-white transition-colors flex-shrink-0"
        >
          {t('freePlan.upgrade')} <ArrowRight size={12} />
        </button>
        <button
          onClick={() => { sessionStorage.setItem(DISMISSED_KEY, '1'); setDismissed(true); }}
          className="text-brand-600 hover:text-brand-400 transition-colors p-1 flex-shrink-0"
          aria-label={t('demo.dismiss')}
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
};

export default FreePlanBanner;
