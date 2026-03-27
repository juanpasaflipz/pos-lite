import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useLocation } from 'react-router-dom';
import { useSalesAuth } from '../../context/SalesAuthContext';

interface NavItem {
  key: string;
  path: string;
  managerOnly?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { key: 'dashboard', path: '/sales' },
  { key: 'leads', path: '/sales/leads' },
  { key: 'clients', path: '/sales/clients' },
  { key: 'onboard', path: '/sales/onboard' },
  { key: 'commissions', path: '/sales/commissions' },
  { key: 'leaderboard', path: '/sales/leaderboard' },
  { key: 'team', path: '/sales/team', managerOnly: true },
  { key: 'demo', path: '/sales/demo' },
];

export default function SalesLayout({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation('sales');
  const { rep, logout, isManager } = useSalesAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const currentPath = location.pathname;

  const filteredNav = NAV_ITEMS.filter((item) => !item.managerOnly || isManager);

  const isActive = (path: string) => {
    if (path === '/sales') return currentPath === '/sales' || currentPath === '/sales/';
    return currentPath.startsWith(path);
  };

  const handleNav = (path: string) => {
    navigate(path);
    setSidebarOpen(false);
  };

  return (
    <div className="min-h-screen bg-neutral-950 flex">
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/60 z-30 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed lg:static inset-y-0 left-0 z-40 w-60 bg-neutral-900 border-r border-neutral-800 flex flex-col transform transition-transform lg:transform-none ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
        }`}
      >
        <div className="px-5 py-5 border-b border-neutral-800">
          <h2 className="text-lg font-bold text-white">Sales CRM</h2>
          <p className="text-xs text-neutral-500 mt-0.5">Desktop Kitchen</p>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          {filteredNav.map((item) => (
            <button
              key={item.key}
              onClick={() => handleNav(item.path)}
              className={`w-full text-left px-3 py-2 rounded-lg text-sm font-medium transition ${
                isActive(item.path)
                  ? 'bg-brand-600/20 text-brand-400'
                  : 'text-neutral-400 hover:text-white hover:bg-neutral-800'
              }`}
            >
              {t(`nav.${item.key}`)}
            </button>
          ))}
        </nav>

        <div className="px-3 py-4 border-t border-neutral-800">
          <button
            onClick={logout}
            className="w-full text-left px-3 py-2 rounded-lg text-sm font-medium text-neutral-500 hover:text-red-400 hover:bg-neutral-800 transition"
          >
            {t('nav.logout')}
          </button>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top header */}
        <header className="bg-neutral-900 border-b border-neutral-800 px-4 lg:px-6 py-3 flex items-center justify-between">
          <button
            onClick={() => setSidebarOpen(true)}
            className="lg:hidden text-neutral-400 hover:text-white"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>

          <div className="flex-1" />

          <div className="flex items-center gap-3">
            <span className="text-sm text-neutral-300">
              {rep?.name}
              {isManager && (
                <span className="ml-1.5 text-xs bg-brand-600/20 text-brand-400 px-1.5 py-0.5 rounded">
                  Manager
                </span>
              )}
            </span>
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto p-4 lg:p-6">{children}</main>
      </div>
    </div>
  );
}
