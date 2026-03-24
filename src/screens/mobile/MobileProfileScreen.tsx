import React from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useNetworkStatus } from '../../hooks/useNetworkStatus';
import MobileHeader from '../../components/mobile/MobileHeader';
import LanguageSwitcher from '../../components/LanguageSwitcher';
import BrandLogo from '../../components/BrandLogo';
import { Wifi, WifiOff, LogOut } from 'lucide-react';

const roleColors: Record<string, string> = {
  admin: 'bg-purple-600',
  manager: 'bg-blue-600',
  cashier: 'bg-brand-600',
  kitchen: 'bg-amber-600',
  bar: 'bg-pink-600',
};

const MobileProfileScreen: React.FC = () => {
  const { t } = useTranslation('pos');
  const navigate = useNavigate();
  const { currentEmployee, logout } = useAuth();
  const { isOnline } = useNetworkStatus();

  const handleLogout = () => {
    logout();
    navigate('/');
  };

  return (
    <>
      <MobileHeader title={t('mobileProfile.title')} />

      <div className="p-6 space-y-6">
        {/* Logo */}
        <div className="flex justify-center">
          <BrandLogo className="h-12" />
        </div>

        {/* Employee info */}
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6 text-center">
          <div className="w-16 h-16 bg-brand-600 rounded-full flex items-center justify-center mx-auto mb-3">
            <span className="text-2xl font-bold text-white">
              {currentEmployee?.name?.charAt(0)?.toUpperCase() || '?'}
            </span>
          </div>
          <p className="text-xl font-bold text-white">{currentEmployee?.name}</p>
          <span className={`inline-block mt-2 px-3 py-1 rounded-full text-xs font-bold text-white ${
            roleColors[currentEmployee?.role || ''] || 'bg-neutral-600'
          }`}>
            {currentEmployee?.role ? t(`common:roles.${currentEmployee.role}`, currentEmployee.role) : ''}
          </span>
        </div>

        {/* Network status */}
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-4 flex items-center justify-between">
          <span className="text-sm font-semibold text-neutral-300">{t('mobileProfile.networkStatus')}</span>
          <div className="flex items-center gap-2">
            {isOnline ? (
              <>
                <Wifi className="w-4 h-4 text-green-500" />
                <span className="text-sm text-green-500 font-semibold">{t('mobileProfile.online')}</span>
              </>
            ) : (
              <>
                <WifiOff className="w-4 h-4 text-brand-500 animate-pulse" />
                <span className="text-sm text-brand-500 font-semibold">{t('mobileProfile.offline')}</span>
              </>
            )}
          </div>
        </div>

        {/* Language */}
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-4 flex items-center justify-between">
          <span className="text-sm font-semibold text-neutral-300">{t('mobileProfile.language')}</span>
          <LanguageSwitcher variant="nav" />
        </div>

        {/* Logout */}
        <button
          onClick={handleLogout}
          className="w-full py-4 bg-neutral-900 border border-neutral-800 rounded-xl text-neutral-400 font-bold flex items-center justify-center gap-2 hover:bg-neutral-800 transition-colors touch-manipulation"
        >
          <LogOut className="w-5 h-5" />
          {t('mobileProfile.logout')}
        </button>
      </div>
    </>
  );
};

export default MobileProfileScreen;
