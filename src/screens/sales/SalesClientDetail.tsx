import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams, useNavigate } from 'react-router-dom';
import { getClientDetail, type ClientDetail } from '../../api/salesApi';

export default function SalesClientDetail() {
  const { t } = useTranslation('sales');
  const { tenantId } = useParams<{ tenantId: string }>();
  const navigate = useNavigate();
  const [data, setData] = useState<ClientDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!tenantId) return;
    getClientDetail(tenantId)
      .then(setData)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [tenantId]);

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <div className="text-brand-600 animate-pulse">Loading...</div>
      </div>
    );
  }

  if (error) {
    return <div className="text-red-400 bg-red-900/20 border border-red-800 rounded-lg p-4">{error}</div>;
  }

  if (!data) return null;

  const { tenant, stats } = data;

  const statCards = [
    { label: t('clients.totalOrders'), value: stats.total_orders, color: 'text-blue-400' },
    { label: t('clients.totalRevenue'), value: `$${Number(stats.total_revenue).toFixed(2)}`, color: 'text-green-400' },
    { label: t('clients.orders30d'), value: stats.orders_30d, color: 'text-purple-400' },
    { label: 'Revenue (30d)', value: `$${Number(stats.revenue_30d).toFixed(2)}`, color: 'text-emerald-400' },
    { label: t('clients.employees'), value: stats.employees, color: 'text-orange-400' },
    { label: t('clients.menuItems'), value: stats.menu_items, color: 'text-cyan-400' },
  ];

  return (
    <div className="space-y-6">
      {/* Back button */}
      <button
        onClick={() => navigate('/sales/clients')}
        className="text-neutral-400 hover:text-white text-sm transition flex items-center gap-1"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
        {t('clients.title')}
      </button>

      {/* Tenant Info */}
      <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-xl font-bold text-white">{tenant.name}</h1>
            <p className="text-neutral-500 text-sm mt-1">{tenant.id}</p>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`text-xs px-2.5 py-1 rounded-full font-medium capitalize ${
                tenant.plan === 'pro'
                  ? 'bg-brand-600/20 text-brand-400'
                  : 'bg-neutral-700 text-neutral-300'
              }`}
            >
              {tenant.plan}
            </span>
            <span
              className={`text-xs px-2.5 py-1 rounded-full font-medium ${
                tenant.active
                  ? 'bg-green-500/20 text-green-400'
                  : 'bg-red-500/20 text-red-400'
              }`}
            >
              {tenant.active ? 'Active' : 'Inactive'}
            </span>
          </div>
        </div>
        <p className="text-xs text-neutral-600 mt-2">
          Created: {new Date(tenant.created_at).toLocaleDateString()}
        </p>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {statCards.map((s) => (
          <div key={s.label} className="bg-neutral-900 border border-neutral-800 rounded-xl p-4">
            <p className="text-xs text-neutral-500 uppercase tracking-wide">{s.label}</p>
            <p className={`text-2xl font-bold mt-1 ${s.color}`}>{s.value}</p>
          </div>
        ))}
      </div>

      {/* Last Order */}
      <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
        <h2 className="text-sm font-medium text-neutral-400 mb-1">{t('clients.lastOrder')}</h2>
        <p className="text-white">
          {stats.last_order_at
            ? new Date(stats.last_order_at).toLocaleString()
            : 'No orders yet'}
        </p>
      </div>
    </div>
  );
}
