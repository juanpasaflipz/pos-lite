import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Building2, DollarSign, ShoppingBag, Receipt, Store, Search, LogOut,
} from 'lucide-react';
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid,
} from 'recharts';
import {
  getOrgOverview, getOrgStores, getOrgTimeseries, getOrgTopItems,
  type OrgInfo, type OrgOverview, type OrgStore, type OrgDayPoint, type OrgTopItem,
} from '../../api/org';
import LanguageSwitcher from '../../components/LanguageSwitcher';

const fmtMXN = (n: number) =>
  new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }).format(n);

const fmtNum = (n: number) => new Intl.NumberFormat('es-MX').format(n);

const KPICard: React.FC<{ label: string; value: string; sub?: string; icon: React.ReactNode }> = ({
  label, value, sub, icon,
}) => (
  <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
    <div className="flex items-center justify-between mb-3">
      <span className="text-xs uppercase tracking-wider text-neutral-500">{label}</span>
      <div className="text-brand-500">{icon}</div>
    </div>
    <div className="text-3xl font-bold text-white">{value}</div>
    {sub && <div className="text-sm text-neutral-400 mt-1">{sub}</div>}
  </div>
);

type SortKey = 'today_revenue' | 'week_revenue' | 'month_revenue' | 'avg_ticket';

interface Props {
  org: OrgInfo;
  onSignOut: () => void;
}

const OrgDashboardScreen: React.FC<Props> = ({ org, onSignOut }) => {
  const { t } = useTranslation('org');
  const [overview, setOverview] = useState<OrgOverview | null>(null);
  const [stores, setStores] = useState<OrgStore[]>([]);
  const [series, setSeries] = useState<OrgDayPoint[]>([]);
  const [topItems, setTopItems] = useState<OrgTopItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('today_revenue');

  useEffect(() => {
    Promise.all([getOrgOverview(), getOrgStores(), getOrgTimeseries(30), getOrgTopItems(8)])
      .then(([ov, st, ts, ti]) => {
        setOverview(ov);
        setStores(st);
        setSeries(ts);
        setTopItems(ti);
      })
      .catch((e) => setError(e.message));
  }, []);

  const visibleStores = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = q
      ? stores.filter((s) => s.name.toLowerCase().includes(q) || s.subdomain.toLowerCase().includes(q))
      : stores;
    return [...filtered].sort((a, b) => (b[sortKey] ?? 0) - (a[sortKey] ?? 0));
  }, [stores, search, sortKey]);

  const maxItemRevenue = topItems.length > 0 ? topItems[0].revenue : 0;

  if (error) {
    return (
      <div className="min-h-screen bg-neutral-950 flex items-center justify-center">
        <div className="text-red-400">{error}</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-neutral-950 text-white">
      {/* Header */}
      <header className="border-b border-neutral-800 bg-neutral-950/90 sticky top-0 z-10 backdrop-blur">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-lg bg-brand-600/20 text-brand-500 flex items-center justify-center shrink-0">
              <Building2 size={20} />
            </div>
            <div className="min-w-0">
              <h1 className="font-bold leading-tight truncate">{org.name}</h1>
              <p className="text-xs text-neutral-500">
                {t('header.subtitle', { count: overview?.store_count ?? 0 })}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <LanguageSwitcher />
            <button
              onClick={onSignOut}
              className="min-h-10 px-3 py-2 rounded-lg border border-neutral-700 text-neutral-300 hover:border-brand-500 hover:text-white text-sm flex items-center gap-2 transition-colors"
            >
              <LogOut size={16} />
              <span className="hidden sm:inline">{t('header.signOut')}</span>
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-6">
        {/* KPIs */}
        {overview ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <KPICard
              label={t('kpi.todayRevenue')}
              value={fmtMXN(overview.today_revenue)}
              sub={t('kpi.vsYesterday', { value: fmtMXN(overview.yesterday_revenue) })}
              icon={<DollarSign size={20} />}
            />
            <KPICard
              label={t('kpi.todayOrders')}
              value={fmtNum(overview.today_orders)}
              icon={<ShoppingBag size={20} />}
            />
            <KPICard
              label={t('kpi.monthRevenue')}
              value={fmtMXN(overview.month_revenue)}
              sub={t('kpi.weekRevenue', { value: fmtMXN(overview.week_revenue) })}
              icon={<Store size={20} />}
            />
            <KPICard
              label={t('kpi.avgTicket')}
              value={fmtMXN(overview.avg_ticket_30d)}
              sub={t('kpi.orders30d', { count: overview.month_orders })}
              icon={<Receipt size={20} />}
            />
          </div>
        ) : (
          <div className="text-neutral-400">{t('loading')}</div>
        )}

        {/* Revenue chart + top items */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2 bg-neutral-900 border border-neutral-800 rounded-xl p-5">
            <h3 className="text-sm font-semibold text-neutral-300 mb-4">{t('chart.title')}</h3>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={series} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="orgRev" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--brand-500, #A8542A)" stopOpacity={0.45} />
                      <stop offset="100%" stopColor="var(--brand-500, #A8542A)" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#262626" vertical={false} />
                  <XAxis
                    dataKey="day"
                    tick={{ fill: '#737373', fontSize: 11 }}
                    tickFormatter={(d: string) => d.slice(5)}
                    tickLine={false}
                    axisLine={{ stroke: '#404040' }}
                  />
                  <YAxis
                    tick={{ fill: '#737373', fontSize: 11 }}
                    tickFormatter={(v: number) => `$${Math.round(v / 1000)}k`}
                    tickLine={false}
                    axisLine={false}
                    width={44}
                  />
                  <Tooltip
                    contentStyle={{ background: '#171717', border: '1px solid #404040', borderRadius: 8 }}
                    labelStyle={{ color: '#a3a3a3' }}
                    formatter={(value: number, key: string) =>
                      key === 'revenue' ? [fmtMXN(value), t('chart.revenue')] : [fmtNum(value), t('chart.orders')]}
                  />
                  <Area
                    type="monotone"
                    dataKey="revenue"
                    stroke="var(--brand-500, #A8542A)"
                    strokeWidth={2}
                    fill="url(#orgRev)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
            <h3 className="text-sm font-semibold text-neutral-300 mb-4">{t('topItems.title')}</h3>
            {topItems.length === 0 ? (
              <p className="text-sm text-neutral-500">{t('noData')}</p>
            ) : (
              <ul className="space-y-3">
                {topItems.map((item) => (
                  <li key={item.item_name}>
                    <div className="flex justify-between text-sm mb-1 gap-2">
                      <span className="text-neutral-200 truncate">{item.item_name}</span>
                      <span className="text-neutral-400 shrink-0">{fmtMXN(item.revenue)}</span>
                    </div>
                    <div className="h-1.5 bg-neutral-800 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-brand-600 rounded-full"
                        style={{ width: `${maxItemRevenue > 0 ? (item.revenue / maxItemRevenue) * 100 : 0}%` }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* Stores table */}
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl overflow-hidden">
          <div className="p-5 pb-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-neutral-300">
              {t('stores.title', { count: stores.length })}
            </h3>
            <div className="flex items-center gap-2">
              <div className="relative">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t('stores.search')}
                  className="min-h-10 pl-8 pr-3 py-2 rounded-lg bg-neutral-800 border border-neutral-700 text-sm text-white focus:outline-none focus:border-brand-500 w-full sm:w-56"
                />
              </div>
              <select
                value={sortKey}
                onChange={(e) => setSortKey(e.target.value as SortKey)}
                className="min-h-10 px-3 py-2 rounded-lg bg-neutral-800 border border-neutral-700 text-sm text-neutral-200 focus:outline-none focus:border-brand-500"
              >
                <option value="today_revenue">{t('stores.sort.today')}</option>
                <option value="week_revenue">{t('stores.sort.week')}</option>
                <option value="month_revenue">{t('stores.sort.month')}</option>
                <option value="avg_ticket">{t('stores.sort.ticket')}</option>
              </select>
            </div>
          </div>

          <div className="overflow-x-auto max-h-[560px] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-neutral-900 z-10">
                <tr className="text-left text-xs uppercase tracking-wider text-neutral-500 border-b border-neutral-800">
                  <th className="px-5 py-3 font-medium">{t('stores.col.store')}</th>
                  <th className="px-4 py-3 font-medium text-right">{t('stores.col.today')}</th>
                  <th className="px-4 py-3 font-medium text-right hidden sm:table-cell">{t('stores.col.orders')}</th>
                  <th className="px-4 py-3 font-medium text-right hidden md:table-cell">{t('stores.col.week')}</th>
                  <th className="px-4 py-3 font-medium text-right">{t('stores.col.month')}</th>
                  <th className="px-4 py-3 font-medium text-right hidden lg:table-cell">{t('stores.col.ticket')}</th>
                </tr>
              </thead>
              <tbody>
                {visibleStores.map((s, i) => (
                  <tr key={s.id} className="border-b border-neutral-800/60 hover:bg-neutral-800/40">
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <span className="text-xs text-neutral-600 w-6 text-right shrink-0">{i + 1}</span>
                        <div className="min-w-0">
                          <div className="text-neutral-100 truncate">{s.name}</div>
                          <div className="text-xs text-neutral-500 truncate">{s.subdomain}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right text-neutral-100 font-medium">{fmtMXN(s.today_revenue)}</td>
                    <td className="px-4 py-3 text-right text-neutral-400 hidden sm:table-cell">{fmtNum(s.today_orders)}</td>
                    <td className="px-4 py-3 text-right text-neutral-400 hidden md:table-cell">{fmtMXN(s.week_revenue)}</td>
                    <td className="px-4 py-3 text-right text-neutral-300">{fmtMXN(s.month_revenue)}</td>
                    <td className="px-4 py-3 text-right text-neutral-400 hidden lg:table-cell">{fmtMXN(s.avg_ticket)}</td>
                  </tr>
                ))}
                {visibleStores.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-5 py-8 text-center text-neutral-500">
                      {t('noData')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </main>
    </div>
  );
};

export default OrgDashboardScreen;
