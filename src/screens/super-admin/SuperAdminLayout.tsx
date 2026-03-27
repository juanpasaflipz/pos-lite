import React from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  LayoutDashboard,
  Building2,
  DollarSign,
  HeartPulse,
  Play,
  Users,
  Monitor,
  Bell,
  LogOut,
} from 'lucide-react';

interface Props {
  children: React.ReactNode;
}

const NAV_ITEMS = [
  { path: '/super-admin', label: 'tabs.overview', icon: LayoutDashboard, end: true },
  { path: '/super-admin/tenants', label: 'tabs.tenants', icon: Building2 },
  { path: '/super-admin/revenue', label: 'tabs.revenue', icon: DollarSign },
  { path: '/super-admin/health', label: 'tabs.health', icon: HeartPulse },
  { path: '/super-admin/demo', label: 'demoConfig', icon: Play },
  { path: '/super-admin/sales-reps', label: 'salesReps', icon: Users },
  { path: '/super-admin/monitoring', label: 'monitoring', icon: Monitor },
  { path: '/super-admin/alerts', label: 'alerts', icon: Bell },
];

export default function SuperAdminLayout({ children }: Props) {
  const { t } = useTranslation('superAdmin');
  const navigate = useNavigate();

  const handleLogout = () => {
    sessionStorage.removeItem('admin_secret');
    navigate('/super-admin');
    window.location.reload();
  };

  const getLabelText = (label: string): string => {
    // Try translating with namespace key, fall back to readable label
    const translated = t(label, { defaultValue: '' });
    if (translated && translated !== label) return translated;

    // Fallback for keys without translation entries
    const fallbacks: Record<string, string> = {
      'demoConfig': 'Demo Config',
      'salesReps': 'Sales Reps',
      'monitoring': 'Monitoring',
      'alerts': 'Alerts',
    };
    return fallbacks[label] || label;
  };

  return (
    <div className="min-h-screen flex bg-neutral-950">
      {/* Sidebar */}
      <aside className="w-60 flex-shrink-0 bg-neutral-900 border-r border-neutral-800 flex flex-col">
        <div className="p-5 border-b border-neutral-800">
          <h1 className="text-lg font-black text-white tracking-tight">
            {t('dashboard.superAdmin')}
          </h1>
          <p className="text-xs text-neutral-500 mt-0.5">
            {t('dashboard.brandName')}
          </p>
        </div>

        <nav className="flex-1 py-3 px-3 space-y-1 overflow-y-auto">
          {NAV_ITEMS.map(item => (
            <NavLink
              key={item.path}
              to={item.path}
              end={item.end}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-brand-600/15 text-brand-400'
                    : 'text-neutral-400 hover:text-white hover:bg-neutral-800'
                }`
              }
            >
              <item.icon size={18} />
              <span>{getLabelText(item.label)}</span>
            </NavLink>
          ))}
        </nav>

        <div className="p-3 border-t border-neutral-800">
          <button
            onClick={handleLogout}
            className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-sm font-medium text-neutral-400 hover:text-red-400 hover:bg-neutral-800 transition-colors"
          >
            <LogOut size={18} />
            <span>{t('dashboard.signOut')}</span>
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto">
        <div className="p-6 max-w-7xl mx-auto">
          {children}
        </div>
      </main>
    </div>
  );
}
