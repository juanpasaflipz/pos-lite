import React, { useMemo } from 'react';
import { Link, useSearchParams, Navigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Users, Clock, Wallet } from 'lucide-react';
import BrandLogo from '../components/BrandLogo';
import { useAuth } from '../context/AuthContext';
import RosterPanel from './staff/RosterPanel';
import TimeClockPanel from './staff/TimeClockPanel';
import PayrollPanel from './staff/PayrollPanel';

type Tab = 'roster' | 'timeclock' | 'payroll';

const VALID_TABS: Tab[] = ['roster', 'timeclock', 'payroll'];

/**
 * Consolidated Staff hub: Roster (admin), Time Clock, Payroll under one header.
 * Tab state lives in ?tab= so direct links like /admin/staff?tab=payroll work.
 *
 * Permission gating:
 *   - Hub itself: manager+ (route-level guard in App.tsx)
 *   - Roster tab: admin only — hidden + non-admins are bounced if they url-hack
 *   - Payroll tab: requires manage_payroll permission (or admin)
 */
export default function StaffHubScreen() {
  const { t } = useTranslation('admin');
  const { currentEmployee } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  const isAdmin = currentEmployee?.role === 'admin';
  const canSeePayroll = isAdmin || !!currentEmployee?.permissions?.includes('manage_payroll');

  const requestedTab = (searchParams.get('tab') || '').toLowerCase();
  const defaultTab: Tab = isAdmin ? 'roster' : 'timeclock';
  const activeTab: Tab = (VALID_TABS as string[]).includes(requestedTab) ? (requestedTab as Tab) : defaultTab;

  // Url-hack guard: non-admin trying to land on roster → bounce to timeclock.
  if (activeTab === 'roster' && !isAdmin) {
    return <Navigate to="/admin/staff?tab=timeclock" replace />;
  }
  if (activeTab === 'payroll' && !canSeePayroll) {
    return <Navigate to="/admin/staff?tab=timeclock" replace />;
  }

  const tabs = useMemo(() => {
    const all: { key: Tab; label: string; icon: React.ReactNode; visible: boolean }[] = [
      { key: 'roster', label: t('staff.tabs.roster'), icon: <Users size={18} />, visible: isAdmin },
      { key: 'timeclock', label: t('staff.tabs.timeClock'), icon: <Clock size={18} />, visible: true },
      { key: 'payroll', label: t('staff.tabs.payroll'), icon: <Wallet size={18} />, visible: canSeePayroll },
    ];
    return all.filter(t => t.visible);
  }, [isAdmin, canSeePayroll, t]);

  const onTab = (key: Tab) => {
    const next = new URLSearchParams(searchParams);
    next.set('tab', key);
    setSearchParams(next, { replace: true });
  };

  return (
    <div className="min-h-screen bg-neutral-950">
      <div className="bg-neutral-900 text-white p-6 border-b border-neutral-800">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link to="/admin" className="p-2 hover:bg-neutral-800 rounded-lg transition-colors">
              <ArrowLeft size={24} />
            </Link>
            <div>
              <h1 className="text-3xl font-black tracking-tighter">{t('staff.title')}</h1>
              <p className="text-sm text-neutral-400 mt-1">{t('staff.subtitle')}</p>
            </div>
          </div>
          <BrandLogo className="h-10" />
        </div>
      </div>

      <div className="max-w-7xl mx-auto p-6 space-y-6">
        <div className="flex gap-2 overflow-x-auto">
          {tabs.map(tab => (
            <button
              key={tab.key}
              onClick={() => onTab(tab.key)}
              className={`px-4 py-2.5 rounded-lg font-medium text-sm transition-colors whitespace-nowrap flex items-center gap-2 ${
                activeTab === tab.key
                  ? 'bg-neutral-700 text-white'
                  : 'bg-neutral-900 text-neutral-400 hover:bg-neutral-800 border border-neutral-800'
              }`}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </div>

        {activeTab === 'roster' && <RosterPanel />}
        {activeTab === 'timeclock' && <TimeClockPanel />}
        {activeTab === 'payroll' && <PayrollPanel />}
      </div>
    </div>
  );
}
