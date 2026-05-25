import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Users, DollarSign, ShoppingBag, TrendingUp } from 'lucide-react';
import { getOverview, getActivity, type OverviewData, type ActivityData } from '../../../api/superAdmin';

const KPICard: React.FC<{
  label: string;
  value: string;
  sub?: string;
  icon: React.ReactNode;
}> = ({ label, value, sub, icon }) => (
  <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
    <div className="flex items-center justify-between mb-3">
      <span className="text-xs uppercase tracking-wider text-neutral-500">{label}</span>
      <div className="text-brand-500">{icon}</div>
    </div>
    <div className="text-3xl font-bold text-white">{value}</div>
    {sub && <div className="text-sm text-neutral-400 mt-1">{sub}</div>}
  </div>
);

const fmtCurrency = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);

const fmtNumber = (n: number) => new Intl.NumberFormat('en-US').format(n);

const OverviewTab: React.FC = () => {
  const { t } = useTranslation('superAdmin');
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [activity, setActivity] = useState<ActivityData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([getOverview(), getActivity()])
      .then(([ov, ac]) => {
        setOverview(ov);
        setActivity(ac);
      })
      .catch((e) => setError(e.message));
  }, []);

  if (error) return <div className="text-cockpit-red">{error}</div>;
  if (!overview) return <div className="text-neutral-400">{t('overview.loading')}</div>;

  const totalTenants = overview.total_tenants ?? 0;
  const active = overview.active_tenants ?? 0;
  const free = overview.plan_breakdown?.free ?? 0;
  const pro = overview.plan_breakdown?.pro ?? 0;
  const mrr = overview.mrr ?? 0;

  return (
    <div className="space-y-6">
      {/* KPIs */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <KPICard
          label={t('overview.kpi.totalTenants')}
          value={fmtNumber(totalTenants)}
          sub={t('overview.kpi.activeCount', { count: active })}
          icon={<Users size={20} />}
        />
        <KPICard
          label={t('overview.kpi.mrr')}
          value={fmtCurrency(mrr)}
          sub={`${pro} ${t('overview.plans.pro')} / ${free} ${t('overview.plans.free')}`}
          icon={<TrendingUp size={20} />}
        />
        <KPICard
          label={t('overview.kpi.totalOrders')}
          value={fmtNumber(overview.total_orders ?? 0)}
          icon={<ShoppingBag size={20} />}
        />
        <KPICard
          label={t('overview.kpi.platformRevenue')}
          value={fmtCurrency(overview.total_revenue ?? 0)}
          icon={<DollarSign size={20} />}
        />
      </div>

      {/* Plan distribution */}
      <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
        <h3 className="text-sm font-semibold text-neutral-300 mb-4">{t('overview.planDistribution')}</h3>
        {totalTenants === 0 ? (
          <p className="text-sm text-neutral-500">{t('overview.noData')}</p>
        ) : (
          <div className="space-y-3">
            {[
              { key: 'pro', label: t('overview.plans.pro'), count: pro, color: 'bg-brand-600' },
              { key: 'free', label: t('overview.plans.free'), count: free, color: 'bg-neutral-600' },
            ].map((row) => {
              const pct = totalTenants > 0 ? (row.count / totalTenants) * 100 : 0;
              return (
                <div key={row.key}>
                  <div className="flex justify-between text-sm mb-1">
                    <span className="text-neutral-300">{row.label}</span>
                    <span className="text-neutral-400">{row.count} ({pct.toFixed(0)}%)</span>
                  </div>
                  <div className="h-2 bg-neutral-800 rounded-full overflow-hidden">
                    <div className={`h-full ${row.color}`} style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Activity */}
      {activity && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <ActivityList title={t('overview.mostActive')} items={activity.most_active} />
          <ActivityList title={t('overview.leastActive')} items={activity.least_active} />
        </div>
      )}
    </div>
  );
};

const ActivityList: React.FC<{ title: string; items: ActivityData['most_active'] }> = ({ title, items }) => {
  const { t } = useTranslation('superAdmin');
  return (
    <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
      <h3 className="text-sm font-semibold text-neutral-300 mb-4">{title}</h3>
      {items.length === 0 ? (
        <p className="text-sm text-neutral-500">{t('overview.noData')}</p>
      ) : (
        <ul className="space-y-2">
          {items.map((row) => (
            <li key={row.id} className="flex items-center justify-between text-sm">
              <div>
                <span className="text-neutral-200">{row.name}</span>
                <span className="ml-2 text-xs text-neutral-500">{row.plan}</span>
              </div>
              <div className="text-neutral-400">
                {fmtNumber(row.order_count)} {t('overview.orders')} · {fmtCurrency(row.revenue)}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default OverviewTab;
