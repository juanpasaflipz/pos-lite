import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { PaymentFeeSummary } from '../../types';
import { formatPrice } from '../../utils/currency';

interface FeesTabProps {
  feesData: PaymentFeeSummary;
}

export default function FeesTab({ feesData }: FeesTabProps) {
  const { t } = useTranslation('reports');

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
          <p className="text-neutral-400 text-sm">{t('sales.kpi.totalRevenue')}</p>
          <p className="text-2xl font-bold text-white">{formatPrice(feesData.total_revenue || 0)}</p>
        </div>
        <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
          <p className="text-neutral-400 text-sm">{t('sales.fees.totalFees')}</p>
          <p className="text-2xl font-bold text-brand-400">{formatPrice(feesData.total_fees || 0)}</p>
        </div>
        <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
          <p className="text-neutral-400 text-sm">{t('sales.fees.netRevenue')}</p>
          <p className="text-2xl font-bold text-green-400">{formatPrice(feesData.net_revenue || 0)}</p>
        </div>
        <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
          <p className="text-neutral-400 text-sm">{t('sales.fees.feePercent')}</p>
          <p className="text-2xl font-bold text-amber-400">{(feesData.fee_percent || 0).toFixed(2)}%</p>
        </div>
      </div>

      {feesData.daily && feesData.daily.length > 0 && (
        <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
          <h3 className="text-lg font-bold text-white mb-4">{t('sales.fees.dailyFeeBreakdown')}</h3>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={feesData.daily}>
              <CartesianGrid strokeDasharray="3 3" stroke="#333" />
              <XAxis dataKey="date" stroke="#888" tick={{ fontSize: 12 }} />
              <YAxis stroke="#888" />
              <Tooltip contentStyle={{ backgroundColor: '#171717', border: '1px solid #333', borderRadius: '8px' }} />
              <Legend />
              <Bar dataKey="revenue" fill="#16a34a" name={t('sales.fees.chartRevenue')} />
              <Bar dataKey="fees" fill="#0d9488" name={t('sales.fees.chartFees')} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
