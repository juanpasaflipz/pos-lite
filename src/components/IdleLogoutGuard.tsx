import React, { useCallback, useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Clock } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useIdleLogout } from '../hooks/useIdleLogout';

const IDLE_MS = 10 * 60 * 1000;
const WARNING_MS = 30 * 1000;

// Paths where the staff session should NOT auto-logout: always-on displays
// (KDS, menu boards) and public/unauth flows.
const EXEMPT_PREFIXES = [
  '/kitchen',
  '/kitchen-pair',
  '/menu-board',
  '/admin/display-menu',
  '/order',
  '/invoice/',
  '/r/',
  '/super-admin',
  '/onboarding',
  '/reset-password',
];

const IdleLogoutGuard: React.FC = () => {
  const { t } = useTranslation('common');
  const { currentEmployee, logout } = useAuth();
  const location = useLocation();

  const enabled = useMemo(() => {
    if (!currentEmployee) return false;
    return !EXEMPT_PREFIXES.some((p) => location.pathname.startsWith(p));
  }, [currentEmployee, location.pathname]);

  const onLogout = useCallback(() => logout(), [logout]);

  const { warningRemaining, dismissWarning } = useIdleLogout({
    enabled,
    idleMs: IDLE_MS,
    warningMs: WARNING_MS,
    onLogout,
  });

  if (warningRemaining === null) return null;

  const seconds = Math.ceil(warningRemaining / 1000);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-neutral-950/80 backdrop-blur-sm">
      <div className="w-[min(420px,calc(100vw-32px))] rounded-2xl bg-neutral-900 border border-neutral-800 p-6 shadow-2xl">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-10 h-10 rounded-full bg-amber-500/15 text-amber-400 flex items-center justify-center">
            <Clock className="w-5 h-5" />
          </div>
          <h2 className="text-lg font-semibold text-white">{t('idleLogout.title')}</h2>
        </div>
        <p className="text-sm text-neutral-300 mb-4">
          {t('idleLogout.message', { seconds })}
        </p>
        <div className="flex gap-2">
          <button
            onClick={dismissWarning}
            className="flex-1 min-h-[44px] rounded-lg bg-brand-600 hover:bg-brand-500 text-white font-semibold transition-colors"
          >
            {t('idleLogout.stayLoggedIn')}
          </button>
          <button
            onClick={onLogout}
            className="min-h-[44px] px-4 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-200 font-medium transition-colors"
          >
            {t('buttons.logout')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default IdleLogoutGuard;
