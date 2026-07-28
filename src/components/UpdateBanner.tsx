import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';
import {
  APP_BUILD,
  applyAppUpdate,
  subscribeAppUpdate,
  type AppUpdateState,
} from '../lib/appUpdate';

/**
 * Non-blocking "a new version is live" prompt.
 *
 * Staff routinely ignore banners, so this is only half the mechanism — the
 * watcher in lib/appUpdate.ts reloads on its own once the surface goes idle.
 * The banner exists so someone who *wants* the new build right now can take it
 * without waiting out the idle timer.
 */
const UpdateBanner: React.FC = () => {
  const { t } = useTranslation('common');
  const [state, setState] = useState<AppUpdateState>({
    available: false,
    forced: false,
    serverBuildId: null,
  });
  const [applying, setApplying] = useState(false);

  useEffect(() => subscribeAppUpdate(setState), []);

  if (!state.available) return null;

  const handleApply = () => {
    setApplying(true);
    void applyAppUpdate();
  };

  return (
    <div className="fixed bottom-4 left-4 z-[70] max-w-sm">
      <div className="flex items-start gap-3 px-4 py-3 rounded-lg border border-cockpit-blue/60 bg-cockpit-blue/20 text-cockpit-system-text shadow-lg backdrop-blur-sm">
        <RefreshCw
          size={18}
          className={`flex-shrink-0 mt-0.5 ${applying || state.forced ? 'animate-spin' : ''}`}
        />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold">{t('appUpdate.title')}</p>
          <p className="text-xs opacity-80 mt-0.5">
            {state.forced ? t('appUpdate.forced') : t('appUpdate.body')}
          </p>
          {!state.forced && (
            <button
              onClick={handleApply}
              disabled={applying}
              className="mt-2 min-h-[40px] px-3 rounded-md bg-cockpit-blue/40 hover:bg-cockpit-blue/60 disabled:opacity-50 text-sm font-semibold transition-colors"
            >
              {t('appUpdate.action')}
            </button>
          )}
          <p className="text-[10px] opacity-50 mt-1 font-mono">
            {APP_BUILD.buildId} → {state.serverBuildId}
          </p>
        </div>
      </div>
    </div>
  );
};

export default UpdateBanner;
