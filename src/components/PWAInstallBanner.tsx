import React from 'react';
import { Download, X } from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';

const PWAInstallBanner: React.FC = () => {
  const { canInstall, promptInstall, dismiss } = usePWAInstall();

  if (!canInstall) return null;

  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 w-[90%] max-w-md">
      <div className="bg-brand-600 rounded-xl px-4 py-3 flex items-center gap-3 shadow-lg shadow-brand-900/40">
        <div className="flex items-center justify-center w-10 h-10 bg-white/20 rounded-lg shrink-0">
          <Download className="text-white" size={22} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-white font-semibold text-sm">Install as App</p>
          <p className="text-white/70 text-xs">Get the full-screen experience</p>
        </div>
        <button
          onClick={promptInstall}
          className="shrink-0 px-3 py-1.5 bg-white text-brand-700 text-sm font-bold rounded-lg hover:bg-white/90 active:bg-white/80 transition-colors touch-manipulation"
        >
          Install
        </button>
        <button
          onClick={dismiss}
          className="shrink-0 p-1 text-white/60 hover:text-white transition-colors touch-manipulation"
          aria-label="Dismiss"
        >
          <X size={18} />
        </button>
      </div>
    </div>
  );
};

export default PWAInstallBanner;
