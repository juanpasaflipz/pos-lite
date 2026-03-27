import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { getDashboard, type DashboardData } from '../../api/salesApi';

const STATUS_COLORS: Record<string, string> = {
  new: 'bg-blue-500/20 text-blue-400',
  contacted: 'bg-yellow-500/20 text-yellow-400',
  demo_scheduled: 'bg-purple-500/20 text-purple-400',
  negotiating: 'bg-orange-500/20 text-orange-400',
  converted: 'bg-green-500/20 text-green-400',
  lost: 'bg-red-500/20 text-red-400',
};

export default function SalesDashboard() {
  const { t } = useTranslation('sales');
  const navigate = useNavigate();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    getDashboard()
      .then(setData)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-brand-600 animate-pulse">Loading...</div>
      </div>
    );
  }

  if (error) {
    return <div className="text-red-400 bg-red-900/20 border border-red-800 rounded-lg p-4">{error}</div>;
  }

  if (!data) return null;

  const kpis = [
    { label: t('dashboard.newLeads'), value: data.leads.new_leads, color: 'text-blue-400' },
    { label: t('dashboard.contacted'), value: data.leads.contacted, color: 'text-yellow-400' },
    { label: t('dashboard.demoScheduled'), value: data.leads.demo_scheduled, color: 'text-purple-400' },
    { label: t('dashboard.negotiating'), value: data.leads.negotiating, color: 'text-orange-400' },
    { label: t('dashboard.converted'), value: data.leads.converted, color: 'text-green-400' },
    { label: t('dashboard.lost'), value: data.leads.lost, color: 'text-red-400' },
    { label: t('dashboard.activeClients'), value: data.active_clients, color: 'text-brand-400' },
    {
      label: t('dashboard.pendingCommissions'),
      value: `$${(data.commissions.earned - data.commissions.paid).toFixed(0)}`,
      color: 'text-emerald-400',
    },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-white">{t('dashboard.title')}</h1>

      {/* KPI Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {kpis.map((kpi) => (
          <div key={kpi.label} className="bg-neutral-900 border border-neutral-800 rounded-xl p-4">
            <p className="text-xs text-neutral-500 uppercase tracking-wide">{kpi.label}</p>
            <p className={`text-2xl font-bold mt-1 ${kpi.color}`}>{kpi.value}</p>
          </div>
        ))}
      </div>

      {/* Recent Leads */}
      <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
        <h2 className="text-lg font-semibold text-white mb-4">{t('dashboard.recentLeads')}</h2>

        {data.recent_leads.length === 0 ? (
          <p className="text-neutral-500 text-sm">{t('leads.noLeads')}</p>
        ) : (
          <div className="space-y-2">
            {data.recent_leads.map((lead) => (
              <button
                key={lead.id}
                onClick={() => navigate(`/sales/leads/${lead.id}`)}
                className="w-full flex items-center justify-between bg-neutral-800/50 hover:bg-neutral-800 rounded-lg px-4 py-3 transition text-left"
              >
                <div>
                  <p className="text-sm font-medium text-white">
                    {lead.restaurant_name || lead.name || lead.email}
                  </p>
                  <p className="text-xs text-neutral-500 mt-0.5">{lead.email}</p>
                </div>
                <span
                  className={`text-xs px-2 py-1 rounded-full font-medium ${
                    STATUS_COLORS[lead.status] || 'bg-neutral-700 text-neutral-300'
                  }`}
                >
                  {t(`leads.statuses.${lead.status}`, lead.status)}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
