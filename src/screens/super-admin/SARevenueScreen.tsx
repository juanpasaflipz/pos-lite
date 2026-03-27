import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  getRevenue,
  getSignups,
  getChurn,
  type MonthlyData,
} from '../../api/superAdmin';

function formatCurrency(val: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(val);
}

export default function SARevenueScreen() {
  const { t } = useTranslation('superAdmin');
  const [revenue, setRevenue] = useState<MonthlyData[]>([]);
  const [signups, setSignups] = useState<MonthlyData[]>([]);
  const [churn, setChurn] = useState<MonthlyData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true);
    Promise.all([getRevenue(12), getSignups(12), getChurn(12)])
      .then(([rev, sig, ch]) => {
        setRevenue(rev);
        setSignups(sig);
        setChurn(ch);
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-neutral-400 animate-pulse">{t('revenue.loading')}</p>
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

  // Summary totals
  const totalRevenue = revenue.reduce((sum, r) => sum + (r.revenue || 0), 0);
  const totalOrders = revenue.reduce((sum, r) => sum + (r.order_count || 0), 0);
  const totalSignups = signups.reduce((sum, s) => sum + (s.count || 0), 0);
  const totalChurn = churn.reduce((sum, c) => sum + (c.count || 0), 0);

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-black text-white tracking-tight">
        {t('tabs.revenue')}
      </h2>

      {/* Summary KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
          <p className="text-neutral-400 text-sm font-medium">Total Revenue (12mo)</p>
          <p className="text-2xl font-bold text-white mt-1">{formatCurrency(totalRevenue)}</p>
        </div>
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
          <p className="text-neutral-400 text-sm font-medium">Total Orders (12mo)</p>
          <p className="text-2xl font-bold text-white mt-1">{totalOrders.toLocaleString()}</p>
        </div>
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
          <p className="text-neutral-400 text-sm font-medium">Total Signups (12mo)</p>
          <p className="text-2xl font-bold text-white mt-1">{totalSignups.toLocaleString()}</p>
        </div>
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
          <p className="text-neutral-400 text-sm font-medium">Total Churn (12mo)</p>
          <p className="text-2xl font-bold text-white mt-1">{totalChurn.toLocaleString()}</p>
        </div>
      </div>

      {/* Monthly Revenue & Orders */}
      <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
        <h3 className="text-white font-semibold mb-4">{t('revenue.monthlyRevenueOrders')}</h3>
        {revenue.length === 0 ? (
          <p className="text-neutral-500 text-sm">{t('revenue.noData')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-800 text-neutral-400">
                  <th className="text-left px-4 py-2 font-medium">Month</th>
                  <th className="text-right px-4 py-2 font-medium">{t('revenue.revenueLabel')}</th>
                  <th className="text-right px-4 py-2 font-medium">{t('revenue.ordersLabel')}</th>
                </tr>
              </thead>
              <tbody>
                {revenue.map((r, i) => (
                  <tr key={i} className="border-b border-neutral-800/50">
                    <td className="px-4 py-2.5 text-white">{r.month}</td>
                    <td className="px-4 py-2.5 text-right text-neutral-300">
                      {formatCurrency(r.revenue || 0)}
                    </td>
                    <td className="px-4 py-2.5 text-right text-neutral-300">
                      {(r.order_count || 0).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Monthly Signups */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
          <h3 className="text-white font-semibold mb-4">{t('overview.monthlySignups')}</h3>
          {signups.length === 0 ? (
            <p className="text-neutral-500 text-sm">{t('overview.noData')}</p>
          ) : (
            <div className="space-y-2">
              {signups.map((s, i) => (
                <div key={i} className="flex items-center justify-between py-1.5 px-3 bg-neutral-800/50 rounded-lg">
                  <span className="text-neutral-300 text-sm">{s.month}</span>
                  <span className="text-white text-sm font-medium">{s.count || 0} signups</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Monthly Churn */}
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
          <h3 className="text-white font-semibold mb-4">{t('overview.monthlyChurn')}</h3>
          {churn.length === 0 ? (
            <p className="text-neutral-500 text-sm">{t('overview.noCancellations')}</p>
          ) : (
            <div className="space-y-2">
              {churn.map((c, i) => (
                <div key={i} className="flex items-center justify-between py-1.5 px-3 bg-neutral-800/50 rounded-lg">
                  <span className="text-neutral-300 text-sm">{c.month}</span>
                  <span className={`text-sm font-medium ${(c.count || 0) > 0 ? 'text-red-400' : 'text-neutral-500'}`}>
                    {c.count || 0} churned
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
