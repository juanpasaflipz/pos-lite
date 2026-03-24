import React from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle } from 'lucide-react';
import { ShrinkageAlert } from '../../types';
import { formatDateTime } from '../../utils/dateFormat';

interface AlertsTabProps {
  alerts: ShrinkageAlert[];
  alertsLoading: boolean;
  actionLoading: boolean;
  onAcknowledge: (alertId: number) => void;
  onRefresh: () => void;
}

export default function AlertsTab({
  alerts,
  alertsLoading,
  actionLoading,
  onAcknowledge,
  onRefresh,
}: AlertsTabProps) {
  const { t } = useTranslation('inventory');

  return (
    <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <AlertTriangle className="text-brand-500" size={20} />
          <h3 className="text-lg font-bold text-white">{t('alerts.title')}</h3>
        </div>
        <button
          onClick={onRefresh}
          className="text-sm text-neutral-400 hover:text-white transition-colors"
        >
          {t('common:buttons.refresh')}
        </button>
      </div>
      {alertsLoading ? (
        <div className="space-y-3">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-20 bg-neutral-800 rounded animate-pulse"></div>
          ))}
        </div>
      ) : alerts.length === 0 ? (
        <div className="text-center py-12">
          <CheckCircle className="mx-auto text-green-600 mb-3" size={40} />
          <p className="text-neutral-400">{t('alerts.noAlerts')}</p>
          <p className="text-neutral-500 text-sm mt-1">{t('alerts.withinRanges')}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {alerts.map((alert) => (
            <div
              key={alert.id}
              className={`p-4 rounded-lg border transition-colors ${
                alert.severity === 'critical'
                  ? 'bg-brand-900/20 border-brand-800'
                  : alert.severity === 'high'
                  ? 'bg-orange-900/20 border-orange-800'
                  : 'bg-amber-900/20 border-amber-800'
              }`}
            >
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`px-2 py-0.5 rounded text-xs font-bold uppercase ${
                      alert.severity === 'critical' ? 'bg-brand-900/30 text-brand-400' :
                      alert.severity === 'high' ? 'bg-orange-900/30 text-orange-400' :
                      'bg-amber-900/30 text-amber-400'
                    }`}>
                      {alert.severity}
                    </span>
                    <span className="text-xs text-neutral-500 uppercase">{alert.alert_type}</span>
                  </div>
                  <p className="text-white font-medium">{alert.item_name}</p>
                  <p className="text-neutral-400 text-sm mt-1">{alert.message}</p>
                  {alert.variance_amount !== undefined && (
                    <p className="text-neutral-500 text-xs mt-1">
                      {t('inventory.varianceUnits', { amount: alert.variance_amount })}
                    </p>
                  )}
                  <p className="text-neutral-600 text-xs mt-1">
                    {formatDateTime(new Date(alert.created_at))}
                  </p>
                </div>
                {!alert.acknowledged && (
                  <button
                    onClick={() => onAcknowledge(alert.id)}
                    disabled={actionLoading}
                    className="px-3 py-2 bg-neutral-700 text-neutral-300 rounded-lg hover:bg-neutral-600 transition-colors text-sm font-medium disabled:opacity-50 ml-4"
                  >
                    {t('alerts.acknowledge')}
                  </button>
                )}
                {alert.acknowledged && (
                  <span className="px-3 py-2 text-green-400 text-xs font-medium ml-4">
                    {t('alerts.acknowledged')}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
