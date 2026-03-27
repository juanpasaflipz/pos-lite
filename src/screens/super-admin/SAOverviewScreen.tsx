import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  getOverview,
  getActivity,
  type OverviewData,
  type ActivityData,
} from '../../api/superAdmin';

function formatCurrency(val: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(val);
}

function formatNumber(val: number): string {
  return new Intl.NumberFormat('en-US').format(val);
}

export default function SAOverviewScreen() {
  const { t } = useTranslation('superAdmin');
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [activity, setActivity] = useState<ActivityData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true);
    Promise.all([getOverview(), getActivity()])
      .then(([ov, act]) => {
        setOverview(ov);
        setActivity(act);
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-neutral-400 animate-pulse">{t('overview.loading')}</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-red-400">{error}</p>
      </div>
    );
  }

  if (!overview) return null;

  const kpis = [
    {
      label: t('overview.kpi.totalTenants'),
      value: formatNumber(overview.total_tenants),
      sub: t('overview.kpi.activeCount', { count: overview.active_tenants }),
    },
    {
      label: t('overview.kpi.mrr'),
      value: formatCurrency(overview.mrr),
      sub: `${overview.plan_breakdown.free} ${t('overview.plans.free')} / ${overview.plan_breakdown.pro} ${t('overview.plans.pro')}`,
    },
    {
      label: t('overview.kpi.totalOrders'),
      value: formatNumber(overview.total_orders),
    },
    {
      label: t('overview.kpi.platformRevenue'),
      value: formatCurrency(overview.total_revenue),
    },
  ];

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-black text-white tracking-tight">
        {t('tabs.overview')}
      </h2>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {kpis.map((kpi, i) => (
          <div
            key={i}
            className="bg-neutral-900 border border-neutral-800 rounded-xl p-5"
          >
            <p className="text-neutral-400 text-sm font-medium">{kpi.label}</p>
            <p className="text-2xl font-bold text-white mt-1">{kpi.value}</p>
            {kpi.sub && (
              <p className="text-neutral-500 text-xs mt-1">{kpi.sub}</p>
            )}
          </div>
        ))}
      </div>

      {/* Plan Distribution */}
      <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
        <h3 className="text-white font-semibold mb-3">
          {t('overview.planDistribution')}
        </h3>
        <div className="flex gap-6">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-neutral-500" />
            <span className="text-neutral-300 text-sm">
              {t('overview.plans.free')}: {overview.plan_breakdown.free}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-brand-600" />
            <span className="text-neutral-300 text-sm">
              {t('overview.plans.pro')}: {overview.plan_breakdown.pro}
            </span>
          </div>
        </div>
        {/* Simple bar */}
        <div className="mt-3 h-3 rounded-full bg-neutral-800 overflow-hidden flex">
          {overview.total_tenants > 0 && (
            <>
              <div
                className="h-full bg-neutral-500 transition-all"
                style={{ width: `${(overview.plan_breakdown.free / overview.total_tenants) * 100}%` }}
              />
              <div
                className="h-full bg-brand-600 transition-all"
                style={{ width: `${(overview.plan_breakdown.pro / overview.total_tenants) * 100}%` }}
              />
            </>
          )}
        </div>
      </div>

      {/* Activity */}
      {activity && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Most Active */}
          <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
            <h3 className="text-white font-semibold mb-3">
              {t('overview.mostActive')}
            </h3>
            {activity.most_active.length === 0 ? (
              <p className="text-neutral-500 text-sm">{t('overview.noData')}</p>
            ) : (
              <div className="space-y-2">
                {activity.most_active.map(ta => (
                  <div
                    key={ta.id}
                    className="flex items-center justify-between py-2 px-3 bg-neutral-800/50 rounded-lg"
                  >
                    <div>
                      <p className="text-white text-sm font-medium">{ta.name}</p>
                      <p className="text-neutral-500 text-xs capitalize">{ta.plan}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-white text-sm font-medium">
                        {formatNumber(ta.order_count)} {t('overview.orders')}
                      </p>
                      <p className="text-neutral-500 text-xs">
                        {formatCurrency(ta.revenue)}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Least Active */}
          <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
            <h3 className="text-white font-semibold mb-3">
              {t('overview.leastActive')}
            </h3>
            {activity.least_active.length === 0 ? (
              <p className="text-neutral-500 text-sm">{t('overview.noData')}</p>
            ) : (
              <div className="space-y-2">
                {activity.least_active.map(ta => (
                  <div
                    key={ta.id}
                    className="flex items-center justify-between py-2 px-3 bg-neutral-800/50 rounded-lg"
                  >
                    <div>
                      <p className="text-white text-sm font-medium">{ta.name}</p>
                      <p className="text-neutral-500 text-xs capitalize">{ta.plan}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-white text-sm font-medium">
                        {formatNumber(ta.order_count)} {t('overview.orders')}
                      </p>
                      <p className="text-neutral-500 text-xs">
                        {formatCurrency(ta.revenue)}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
