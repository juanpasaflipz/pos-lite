import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Sparkles, X, ArrowRight } from 'lucide-react';
import { usePlan } from '../context/PlanContext';

const DISMISSED_KEY = 'demo_banner_dismissed';

const DemoBanner: React.FC = () => {
  const { t } = useTranslation('common');
  const navigate = useNavigate();
  const { plan } = usePlan();
  const isDemo = sessionStorage.getItem('is_demo') === '1';
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISSED_KEY) === '1');

  if (!isDemo || plan !== 'free' || dismissed) return null;

  return (
    <div className="mx-4 mt-3 bg-brand-950/50 border border-brand-700/50 rounded-xl px-5 py-3">
      <div className="flex items-center gap-3">
        <Sparkles size={18} className="text-brand-400 flex-shrink-0" />
        <span className="text-brand-100 text-sm font-semibold flex-1">
          {t('demo.banner')}
        </span>
        <button
          onClick={() => navigate('/admin/account')}
          className="flex items-center gap-1 px-4 py-1.5 rounded-md text-xs font-bold bg-brand-600 hover:bg-brand-500 text-white transition-colors flex-shrink-0"
        >
          {t('upgrade.upgradeNow')} <ArrowRight size={12} />
        </button>
        <button
          onClick={() => { localStorage.setItem(DISMISSED_KEY, '1'); setDismissed(true); }}
          className="text-brand-600 hover:text-brand-400 transition-colors p-1 flex-shrink-0"
          aria-label={t('demo.dismiss')}
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
};

export default DemoBanner;
