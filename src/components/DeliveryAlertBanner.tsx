import React from 'react';
import { useTranslation } from 'react-i18next';
import { DeliveryAlert } from '../hooks/useDeliveryAlerts';
import { formatPrice } from '../utils/currency';

interface DeliveryAlertBannerProps {
  alerts: DeliveryAlert[];
  onDismiss: (id: number) => void;
}

const PLATFORM_COLORS: Record<string, { border: string; bg: string; text: string }> = {
  uber_eats:  { border: 'border-green-500',  bg: 'bg-green-950',  text: 'text-green-400' },
  rappi:      { border: 'border-orange-500', bg: 'bg-orange-950', text: 'text-orange-400' },
  didi_food:  { border: 'border-amber-500',  bg: 'bg-amber-950',  text: 'text-amber-400' },
};

const DEFAULT_COLORS = { border: 'border-blue-500', bg: 'bg-blue-950', text: 'text-blue-400' };

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function getPlatformKey(platformName?: string): string {
  if (!platformName) return '';
  return platformName.toLowerCase().replace(/[\s-]+/g, '_');
}

const DeliveryAlertBanner: React.FC<DeliveryAlertBannerProps> = ({ alerts, onDismiss }) => {
  const { t } = useTranslation('pos');

  if (alerts.length === 0) return null;

  return (
    <div className="mx-4 mt-3 space-y-2">
      {alerts.map((alert) => {
        const key = getPlatformKey(alert.platform_name);
        const colors = PLATFORM_COLORS[key] || DEFAULT_COLORS;
        const isUrgent = alert.elapsedSeconds >= 600; // 10 minutes

        return (
          <div
            key={alert.id}
            className={`${colors.bg} border-l-4 ${colors.border} rounded-lg px-4 py-3 flex items-center gap-3`}
          >
            {/* Delivery truck icon */}
            <div className={`flex-shrink-0 ${colors.text}`}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M16 3h5v8h-5z" /><path d="M1 3h15v13H1z" /><path d="M16 8h4l3 3v5h-7V8z" />
                <circle cx="5.5" cy="18.5" r="2.5" /><circle cx="18.5" cy="18.5" r="2.5" />
              </svg>
            </div>

            {/* Platform + order info */}
            <div className="flex-1 min-w-0">
              <p className="text-white text-sm font-medium truncate">
                <span className={`${colors.text} font-bold mr-1.5`}>{alert.platform_name || t('deliveryAlert.delivery', 'Delivery')}</span>
                {alert.order_number && (
                  <span className="text-neutral-300">#{alert.order_number}</span>
                )}
                {alert.customer_name && (
                  <span className="text-neutral-400 ml-2">— {alert.customer_name}</span>
                )}
              </p>
              {alert.total != null && (
                <p className="text-neutral-400 text-xs">{formatPrice(alert.total)}</p>
              )}
            </div>

            {/* Elapsed time */}
            <span
              className={`font-mono text-sm font-bold flex-shrink-0 ${
                isUrgent ? 'text-red-400 animate-pulse' : colors.text
              }`}
            >
              {formatElapsed(alert.elapsedSeconds)}
            </span>

            {/* Dismiss */}
            <button
              onClick={() => onDismiss(alert.id)}
              className="flex-shrink-0 text-neutral-500 hover:text-neutral-300 transition-colors touch-manipulation p-1"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        );
      })}
    </div>
  );
};

export default DeliveryAlertBanner;
