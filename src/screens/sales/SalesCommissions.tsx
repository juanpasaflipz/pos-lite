import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSalesAuth } from '../../context/SalesAuthContext';
import {
  getCommissionSummary,
  getCommissions,
  getAllCommissions,
  markCommissionPaid,
  type CommissionPayout,
  type SalesCommission,
} from '../../api/salesApi';

export default function SalesCommissions() {
  const { t } = useTranslation('sales');
  const { isManager } = useSalesAuth();
  const [summary, setSummary] = useState<{ pending: number; paid: number; total: number } | null>(null);
  const [activeDeals, setActiveDeals] = useState<SalesCommission[]>([]);
  const [payouts, setPayouts] = useState<CommissionPayout[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const fetchData = async () => {
    setLoading(true);
    try {
      const [summaryRes, payoutsRes] = await Promise.all([
        getCommissionSummary(),
        isManager ? getAllCommissions() : getCommissions(),
      ]);
      setSummary(summaryRes.summary);
      setActiveDeals(summaryRes.active_commissions);
      setPayouts(payoutsRes);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [isManager]);

  const handleMarkPaid = async (id: number) => {
    try {
      await markCommissionPaid(id);
      fetchData();
    } catch (err: any) {
      setError(err.message);
    }
  };

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

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-white">{t('commissions.title')}</h1>

      {/* Summary Cards */}
      {summary && (
        <div className="grid grid-cols-3 gap-3">
          <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-4">
            <p className="text-xs text-neutral-500 uppercase tracking-wide">{t('commissions.pending')}</p>
            <p className="text-2xl font-bold text-yellow-400 mt-1">${summary.pending.toFixed(2)}</p>
          </div>
          <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-4">
            <p className="text-xs text-neutral-500 uppercase tracking-wide">{t('commissions.paid')}</p>
            <p className="text-2xl font-bold text-green-400 mt-1">${summary.paid.toFixed(2)}</p>
          </div>
          <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-4">
            <p className="text-xs text-neutral-500 uppercase tracking-wide">{t('commissions.total')}</p>
            <p className="text-2xl font-bold text-brand-400 mt-1">${summary.total.toFixed(2)}</p>
          </div>
        </div>
      )}

      {/* Active Commission Deals */}
      {activeDeals.length > 0 && (
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
          <h2 className="text-lg font-semibold text-white mb-4">{t('commissions.activeDeals')}</h2>
          <div className="space-y-2">
            {activeDeals.map((deal) => (
              <div
                key={deal.id}
                className="flex items-center justify-between bg-neutral-800/50 rounded-lg px-4 py-3"
              >
                <div>
                  <p className="text-sm font-medium text-white">{deal.tenant_name}</p>
                  <p className="text-xs text-neutral-500">
                    {deal.commission_percent}% for {deal.duration_months} months
                  </p>
                </div>
                <span
                  className={`text-xs px-2 py-1 rounded-full font-medium ${
                    deal.active ? 'bg-green-500/20 text-green-400' : 'bg-neutral-700 text-neutral-400'
                  }`}
                >
                  {deal.active ? 'Active' : 'Ended'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Payout History */}
      <div className="bg-neutral-900 border border-neutral-800 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-neutral-800">
          <h2 className="text-lg font-semibold text-white">Payout History</h2>
        </div>
        {payouts.length === 0 ? (
          <p className="text-neutral-500 text-sm px-5 py-8 text-center">No payouts yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-800">
                  <th className="text-left px-4 py-3 text-neutral-500 font-medium">{t('commissions.tenant')}</th>
                  <th className="text-left px-4 py-3 text-neutral-500 font-medium">{t('commissions.period')}</th>
                  <th className="text-right px-4 py-3 text-neutral-500 font-medium">{t('commissions.amount')}</th>
                  <th className="text-left px-4 py-3 text-neutral-500 font-medium">{t('commissions.status')}</th>
                  {isManager && <th className="px-4 py-3" />}
                </tr>
              </thead>
              <tbody>
                {payouts.map((p) => (
                  <tr key={p.id} className="border-b border-neutral-800/50">
                    <td className="px-4 py-3">
                      <p className="text-white">{p.tenant_name}</p>
                      {p.rep_name && <p className="text-xs text-neutral-500">{p.rep_name}</p>}
                    </td>
                    <td className="px-4 py-3 text-neutral-400">{p.period}</td>
                    <td className="px-4 py-3 text-right text-white font-medium">
                      ${Number(p.commission_amount).toFixed(2)}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`text-xs px-2 py-1 rounded-full font-medium ${
                          p.status === 'paid'
                            ? 'bg-green-500/20 text-green-400'
                            : 'bg-yellow-500/20 text-yellow-400'
                        }`}
                      >
                        {p.status}
                      </span>
                    </td>
                    {isManager && (
                      <td className="px-4 py-3">
                        {p.status === 'pending' && (
                          <button
                            onClick={() => handleMarkPaid(p.id)}
                            className="text-xs px-3 py-1 bg-brand-600 hover:bg-brand-700 text-white rounded-lg transition"
                          >
                            {t('commissions.markPaid')}
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
