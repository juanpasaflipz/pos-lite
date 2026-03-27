import React, { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Search, ChevronRight } from 'lucide-react';
import { getTenants, type TenantRecord } from '../../api/superAdmin';

export default function SATenantsScreen() {
  const { t } = useTranslation('superAdmin');
  const [tenants, setTenants] = useState<TenantRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Filters
  const [search, setSearch] = useState('');
  const [planFilter, setPlanFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const fetchTenants = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await getTenants({
        search: search || undefined,
        plan: planFilter || undefined,
        status: statusFilter || undefined,
      });
      setTenants(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [search, planFilter, statusFilter]);

  useEffect(() => {
    const timer = setTimeout(fetchTenants, 300);
    return () => clearTimeout(timer);
  }, [fetchTenants]);

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-black text-white tracking-tight">
        {t('tabs.tenants')}
      </h2>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={t('tenants.searchPlaceholder')}
            className="w-full pl-9 pr-4 py-2.5 bg-neutral-900 border border-neutral-800 rounded-lg text-white text-sm placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
          />
        </div>

        <select
          value={planFilter}
          onChange={e => setPlanFilter(e.target.value)}
          className="px-3 py-2.5 bg-neutral-900 border border-neutral-800 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-brand-600"
        >
          <option value="">{t('tenants.allPlans')}</option>
          <option value="free">{t('tenants.free')}</option>
          <option value="pro">{t('tenants.pro')}</option>
        </select>

        <select
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          className="px-3 py-2.5 bg-neutral-900 border border-neutral-800 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-brand-600"
        >
          <option value="">All Status</option>
          <option value="active">{t('tenants.active')}</option>
          <option value="inactive">{t('tenants.inactive')}</option>
        </select>
      </div>

      {/* Table */}
      {error && <p className="text-red-400 text-sm">{error}</p>}

      {loading ? (
        <p className="text-neutral-400 animate-pulse py-8 text-center">
          {t('tenants.loading')}
        </p>
      ) : tenants.length === 0 ? (
        <p className="text-neutral-500 py-8 text-center">{t('tenants.noTenants')}</p>
      ) : (
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-800 text-neutral-400">
                  <th className="text-left px-4 py-3 font-medium">{t('tenants.columns.name')}</th>
                  <th className="text-left px-4 py-3 font-medium">Subdomain</th>
                  <th className="text-left px-4 py-3 font-medium">{t('tenants.columns.plan')}</th>
                  <th className="text-left px-4 py-3 font-medium">{t('tenants.columns.status')}</th>
                  <th className="text-right px-4 py-3 font-medium">{t('tenants.columns.orders')}</th>
                  <th className="text-left px-4 py-3 font-medium">Created</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {tenants.map(tenant => (
                  <tr
                    key={tenant.id}
                    className="border-b border-neutral-800/50 hover:bg-neutral-800/30 transition-colors"
                  >
                    <td className="px-4 py-3">
                      <Link
                        to={`/super-admin/tenants/${tenant.id}`}
                        className="text-white font-medium hover:text-brand-400 transition-colors"
                      >
                        {tenant.name}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-neutral-400">{tenant.subdomain}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                          tenant.plan === 'pro'
                            ? 'bg-brand-600/20 text-brand-400'
                            : 'bg-neutral-700/50 text-neutral-300'
                        }`}
                      >
                        {tenant.plan}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center gap-1.5 text-xs font-medium ${
                          tenant.active ? 'text-green-400' : 'text-neutral-500'
                        }`}
                      >
                        <span className={`w-1.5 h-1.5 rounded-full ${tenant.active ? 'bg-green-400' : 'bg-neutral-500'}`} />
                        {tenant.active ? t('tenants.active') : t('tenants.inactive')}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-neutral-300">
                      {new Intl.NumberFormat('en-US').format(tenant.order_count)}
                    </td>
                    <td className="px-4 py-3 text-neutral-400">
                      {formatDate(tenant.created_at)}
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        to={`/super-admin/tenants/${tenant.id}`}
                        className="text-neutral-500 hover:text-white transition-colors"
                      >
                        <ChevronRight size={16} />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
