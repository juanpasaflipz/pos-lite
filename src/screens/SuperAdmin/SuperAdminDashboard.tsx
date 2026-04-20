import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LogOut, Gauge, Users, Activity } from 'lucide-react';
import OverviewTab from './tabs/OverviewTab';
import TenantsTab from './tabs/TenantsTab';
import HealthTab from './tabs/HealthTab';

type TabKey = 'overview' | 'tenants' | 'health';

interface Props {
  onSignOut: () => void;
}

const SuperAdminDashboard: React.FC<Props> = ({ onSignOut }) => {
  const { t } = useTranslation('superAdmin');
  const [tab, setTab] = useState<TabKey>('overview');

  const tabs: { key: TabKey; label: string; icon: React.ReactNode }[] = [
    { key: 'overview', label: t('tabs.overview'), icon: <Gauge size={16} /> },
    { key: 'tenants', label: t('tabs.tenants'), icon: <Users size={16} /> },
    { key: 'health', label: t('tabs.health'), icon: <Activity size={16} /> },
  ];

  return (
    <div className="min-h-screen bg-neutral-950 text-white">
      {/* Header */}
      <header className="border-b border-neutral-800 bg-neutral-900 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="text-sm font-bold text-brand-500 tracking-tight">{t('dashboard.brandName')}</div>
            <span className="text-neutral-600">·</span>
            <div className="text-sm font-semibold text-neutral-200">{t('dashboard.superAdmin')}</div>
          </div>
          <button
            onClick={onSignOut}
            className="px-3 py-1.5 text-sm text-neutral-400 hover:text-white flex items-center gap-2 transition"
          >
            <LogOut size={14} /> {t('dashboard.signOut')}
          </button>
        </div>

        {/* Tab nav */}
        <nav className="max-w-7xl mx-auto px-4 sm:px-6 flex gap-1">
          {tabs.map((ti) => {
            const active = tab === ti.key;
            return (
              <button
                key={ti.key}
                onClick={() => setTab(ti.key)}
                className={`px-4 py-3 text-sm font-medium flex items-center gap-2 border-b-2 transition ${
                  active
                    ? 'text-brand-400 border-brand-500'
                    : 'text-neutral-400 border-transparent hover:text-neutral-200'
                }`}
              >
                {ti.icon} {ti.label}
              </button>
            );
          })}
        </nav>
      </header>

      {/* Content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-6">
        {tab === 'overview' && <OverviewTab />}
        {tab === 'tenants' && <TenantsTab />}
        {tab === 'health' && <HealthTab />}
      </main>
    </div>
  );
};

export default SuperAdminDashboard;
