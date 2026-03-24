import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { getGetnetFees, getGetnetTransactions } from '../../api';
import { formatPrice } from '../../utils/currency';

interface GetnetDashboardProps {
  tenantId?: string;
}

const GetnetDashboard: React.FC<GetnetDashboardProps> = () => {
  const { t } = useTranslation('admin');
  const [fees, setFees] = useState<Array<{
    processor: string;
    transactions: number;
    gross: number;
    processorFees: number;
    platformFees: number;
    net: number;
  }>>([]);
  const [transactions, setTransactions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [dateRange, setDateRange] = useState({
    start: new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10),
    end: new Date().toISOString().slice(0, 10),
  });

  useEffect(() => {
    loadData();
  }, [dateRange]);

  const loadData = async () => {
    setLoading(true);
    try {
      const [feeData, txnData] = await Promise.all([
        getGetnetFees(dateRange.start, dateRange.end),
        getGetnetTransactions({ start_date: dateRange.start, end_date: dateRange.end, limit: 20 }),
      ]);
      setFees(feeData.summary || []);
      setTransactions(txnData || []);
    } catch {
      // Handle silently
    } finally {
      setLoading(false);
    }
  };

  const totals = fees.reduce((acc, f) => ({
    transactions: acc.transactions + f.transactions,
    gross: acc.gross + f.gross,
    processorFees: acc.processorFees + f.processorFees,
    platformFees: acc.platformFees + f.platformFees,
    net: acc.net + f.net,
  }), { transactions: 0, gross: 0, processorFees: 0, platformFees: 0, net: 0 });

  if (loading) {
    return <div className="text-neutral-400 text-center py-8">{t('getnet.loadingDashboard')}</div>;
  }

  return (
    <div className="space-y-6">
      {/* Date Range */}
      <div className="flex gap-3 items-center">
        <input
          type="date"
          value={dateRange.start}
          onChange={(e) => setDateRange(prev => ({ ...prev, start: e.target.value }))}
          className="bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-white text-sm"
        />
        <span className="text-neutral-500">—</span>
        <input
          type="date"
          value={dateRange.end}
          onChange={(e) => setDateRange(prev => ({ ...prev, end: e.target.value }))}
          className="bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-white text-sm"
        />
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-4">
          <p className="text-neutral-400 text-xs mb-1">{t('getnet.transactions')}</p>
          <p className="text-2xl font-bold text-white">{totals.transactions}</p>
        </div>
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-4">
          <p className="text-neutral-400 text-xs mb-1">{t('getnet.grossVolume')}</p>
          <p className="text-2xl font-bold text-white">{formatPrice(totals.gross)}</p>
        </div>
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-4">
          <p className="text-neutral-400 text-xs mb-1">{t('getnet.processorFees')}</p>
          <p className="text-2xl font-bold text-red-400">{formatPrice(totals.processorFees)}</p>
        </div>
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-4">
          <p className="text-neutral-400 text-xs mb-1">{t('getnet.netMerchant')}</p>
          <p className="text-2xl font-bold text-green-400">{formatPrice(totals.net)}</p>
        </div>
      </div>

      {/* Fees by Processor */}
      {fees.length > 0 && (
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-4">
          <h4 className="text-white font-bold mb-3">{t('getnet.breakdownByProcessor')}</h4>
          <div className="space-y-2">
            {fees.map((f) => (
              <div key={f.processor} className="flex items-center justify-between py-2 border-b border-neutral-800 last:border-0">
                <div>
                  <p className="text-white font-medium capitalize">{f.processor}</p>
                  <p className="text-neutral-500 text-xs">{f.transactions} {t('getnet.transactionsLabel')}</p>
                </div>
                <div className="text-right">
                  <p className="text-white">{formatPrice(f.gross)}</p>
                  <p className="text-red-400 text-xs">-{formatPrice(f.processorFees + f.platformFees)} {t('getnet.feesLabel')}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent Transactions */}
      {transactions.length > 0 && (
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-4">
          <h4 className="text-white font-bold mb-3">{t('getnet.recentTransactions')}</h4>
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {transactions.map((txn: any) => (
              <div key={txn.id} className="flex items-center justify-between py-2 border-b border-neutral-800 last:border-0">
                <div>
                  <p className="text-white text-sm">
                    {t('getnet.orderNumber', { number: txn.order_number || txn.order_id })}
                    {txn.is_tap_on_phone && <span className="ml-2 text-xs text-brand-400">NFC</span>}
                  </p>
                  <p className="text-neutral-500 text-xs">
                    {txn.card_brand} ****{txn.card_last_four} — {new Date(txn.created_at).toLocaleDateString()}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-white">{formatPrice(txn.amount_centavos / 100)}</p>
                  <p className={`text-xs ${txn.status === 'approved' ? 'text-green-400' : 'text-yellow-400'}`}>
                    {txn.status}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {fees.length === 0 && transactions.length === 0 && (
        <div className="text-center py-8">
          <p className="text-neutral-500">{t('getnet.noTransactions')}</p>
        </div>
      )}
    </div>
  );
};

export default GetnetDashboard;
