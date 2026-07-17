import React from 'react';
import { useTranslation } from 'react-i18next';
import { useOrgAuth } from './useOrgAuth';
import OrgLogin from './OrgLogin';
import OrgDashboardScreen from './OrgDashboardScreen';

const OrgDashboard: React.FC = () => {
  const { t } = useTranslation('org');
  const { state, org, signIn, signOut } = useOrgAuth();

  if (state === 'checking') {
    return (
      <div className="min-h-screen bg-neutral-950 flex items-center justify-center">
        <div className="text-brand-600 font-semibold animate-pulse">{t('verifying')}</div>
      </div>
    );
  }

  if (state === 'unauthenticated' || !org) {
    return <OrgLogin onSignIn={signIn} />;
  }

  return <OrgDashboardScreen org={org} onSignOut={signOut} />;
};

export default OrgDashboard;
