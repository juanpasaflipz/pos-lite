import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { WifiOff, Wifi, Menu, Search, X } from 'lucide-react';
import LanguageSwitcher from '../LanguageSwitcher';
import { VirtualBrand } from '../../types';
import { formatTime } from '../../utils/dateFormat';

interface POSHeaderBarProps {
  currentEmployee: { name: string } | null;
  plan: string;
  ownerEmail: string | null;
  currentTime: Date;
  isOnline: boolean;
  pendingSyncCount: number;
  searchQuery: string;
  searchInputRef: React.RefObject<HTMLInputElement>;
  posBrands: VirtualBrand[];
  selectedBrand: number | 'all';
  showDrawerCart: boolean;
  showNavMenu: boolean;
  todayOrderCount: number;
  filteredItemsCount: number;
  onSearchChange: (value: string) => void;
  onSelectBrand: (id: number | 'all') => void;
  onSetSelectedCategory: (id: 'all') => void;
  onToggleNavMenu: () => void;
  onCloseNavMenu: () => void;
  onLogout: () => void;
}

export default function POSHeaderBar({
  currentEmployee,
  plan,
  ownerEmail,
  currentTime,
  isOnline,
  pendingSyncCount,
  searchQuery,
  searchInputRef,
  posBrands,
  selectedBrand,
  showDrawerCart,
  showNavMenu,
  todayOrderCount,
  filteredItemsCount,
  onSearchChange,
  onSelectBrand,
  onSetSelectedCategory,
  onToggleNavMenu,
  onCloseNavMenu,
  onLogout,
}: POSHeaderBarProps) {
  const navigate = useNavigate();
  const { t } = useTranslation('pos');

  return (
    <div className="bg-neutral-900 text-white p-3 lg:p-4 border-b border-neutral-800">
      <div className="flex justify-between items-center mb-3 lg:mb-4">
        <div className="flex-1">
          <p className="text-xs text-neutral-500">{t('header.operator')}</p>
          <p className="text-base lg:text-lg font-bold text-white">{currentEmployee?.name}</p>
          {plan === 'free' && ownerEmail && (
            <p className="text-xs text-neutral-500 truncate max-w-[180px]">{ownerEmail}</p>
          )}
        </div>
        <div className="text-center flex-1">
          <p className="text-xs text-neutral-500">{t('header.time')}</p>
          <p className="text-base lg:text-lg font-bold text-white">{formatTime(currentTime)}</p>
        </div>
        <div className="text-right flex-1 flex items-center justify-end gap-2 lg:gap-3">
          <div className="hidden lg:block">
            <p className="text-xs text-neutral-500">{t('header.ordersToday')}</p>
            <p className="text-lg font-bold text-white">{todayOrderCount}</p>
          </div>
          {isOnline ? (
            <Wifi className="w-5 h-5 text-green-500" />
          ) : (
            <WifiOff className="w-5 h-5 text-brand-500 animate-pulse" />
          )}
          <LanguageSwitcher variant="nav" />
          {/* Hamburger nav for tablet portrait */}
          {showDrawerCart && (
            <div className="relative">
              <button
                onClick={onToggleNavMenu}
                className="p-2 bg-neutral-800 rounded-lg border border-neutral-700 hover:bg-neutral-700 transition-all"
              >
                <Menu className="w-5 h-5 text-neutral-300" />
              </button>
              {showNavMenu && (
                <>
                  <div className="fixed inset-0 z-40" onClick={onCloseNavMenu} />
                  <div className="absolute right-0 top-full mt-1 z-50 bg-neutral-800 border border-neutral-700 rounded-lg shadow-xl py-1 min-w-[140px]">
                    <button
                      onClick={() => { navigate('/admin'); onCloseNavMenu(); }}
                      className="w-full text-left px-4 py-2.5 text-sm text-neutral-300 hover:bg-neutral-700 font-semibold"
                    >
                      {t('common:buttons.admin')}
                    </button>
                    <button
                      onClick={() => { navigate('/kitchen'); onCloseNavMenu(); }}
                      className="w-full text-left px-4 py-2.5 text-sm text-neutral-300 hover:bg-neutral-700 font-semibold"
                    >
                      {t('common:buttons.kitchen')}
                    </button>
                    <button
                      onClick={() => { onLogout(); onCloseNavMenu(); }}
                      className="w-full text-left px-4 py-2.5 text-sm text-neutral-400 hover:bg-neutral-700 font-semibold border-t border-neutral-700"
                    >
                      {t('common:buttons.logout')}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Offline Mode Banner */}
      {!isOnline && (
        <div className="flex items-center justify-center gap-2 py-2 px-4 mb-3 bg-brand-900/60 border border-brand-700 rounded-lg">
          <span className="w-2 h-2 bg-brand-500 rounded-full animate-pulse" />
          <span className="text-brand-200 font-bold text-sm">{t('offline.indicator')}</span>
          {pendingSyncCount > 0 && (
            <span className="ml-2 bg-brand-700 text-white text-xs font-bold px-2 py-0.5 rounded-full">
              {t('offline.pendingSync', { count: pendingSyncCount })}
            </span>
          )}
        </div>
      )}

      {/* Pending sync badge (online with pending orders) */}
      {isOnline && pendingSyncCount > 0 && (
        <div className="flex items-center justify-center gap-2 py-2 px-4 mb-3 bg-amber-900/40 border border-amber-700 rounded-lg">
          <span className="w-2 h-2 bg-amber-500 rounded-full animate-pulse" />
          <span className="text-amber-200 font-bold text-sm">{t('offline.syncing')}</span>
          <span className="ml-2 bg-amber-700 text-white text-xs font-bold px-2 py-0.5 rounded-full">
            {pendingSyncCount}
          </span>
        </div>
      )}

      {/* Brand Toggle Pills — hide when all brands share the same name (single-restaurant) */}
      {posBrands.length > 0 && new Set(posBrands.map(b => b.name)).size > 1 && (
        <div className="flex gap-2 mb-3 overflow-x-auto pb-1 scrollbar-hide">
          <button
            onClick={() => { onSelectBrand('all'); onSetSelectedCategory('all'); }}
            className={`flex-shrink-0 px-4 py-2 rounded-full text-sm font-bold transition-all ${
              selectedBrand === 'all'
                ? 'bg-brand-600 text-white'
                : 'bg-neutral-800 text-neutral-400 hover:bg-neutral-700'
            }`}
          >
            {t('header.allItems')}
          </button>
          {posBrands.map((brand) => (
            <button
              key={brand.id}
              onClick={() => { onSelectBrand(brand.id); onSetSelectedCategory('all'); }}
              className={`flex-shrink-0 px-4 py-2 rounded-full text-sm font-bold transition-all flex items-center gap-2 ${
                selectedBrand === brand.id
                  ? 'text-white'
                  : 'bg-neutral-800 text-neutral-400 hover:bg-neutral-700'
              }`}
              style={selectedBrand === brand.id ? { backgroundColor: brand.primary_color } : undefined}
            >
              <span
                className="w-3 h-3 rounded-full flex-shrink-0"
                style={{ backgroundColor: brand.primary_color }}
              />
              {brand.name}
            </button>
          ))}
        </div>
      )}

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-neutral-500" />
        <input
          ref={searchInputRef}
          type="text"
          placeholder={`${t('header.searchItems')} (Ctrl+K)`}
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          className="w-full pl-10 pr-10 py-3 rounded-lg bg-neutral-800 border border-neutral-700 text-white placeholder-neutral-500 focus:outline-none focus:border-brand-600 text-lg"
        />
        {searchQuery && (
          <button
            onClick={() => onSearchChange('')}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-white"
          >
            <X className="w-5 h-5" />
          </button>
        )}
      </div>
      {searchQuery && (
        <p className="text-neutral-500 text-sm mt-1">{t('searchResults', { count: filteredItemsCount })}</p>
      )}
    </div>
  );
}
