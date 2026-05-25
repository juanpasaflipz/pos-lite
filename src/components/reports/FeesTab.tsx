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

const PROCESSOR_LABELS: Record<string, string> = {
  mp_terminal: 'Mercado Pago Terminal',
  stripe: 'Stripe',
};

export default function FeesTab({ feesData }: FeesTabProps) {
  const { t } = useTranslation('reports');
  const processors = feesData.by_processor || [];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
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
          <p className="text-2xl font-bold text-cockpit-green">{formatPrice(feesData.net_revenue || 0)}</p>
        </div>
        <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
          <p className="text-neutral-400 text-sm">{t('sales.fees.feePercent')}</p>
          <p className="text-2xl font-bold text-cockpit-yellow">{(feesData.fee_percent || 0).toFixed(2)}%</p>
        </div>
        <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
          <p className="text-neutral-400 text-sm">{t('sales.fees.tipsCollected')}</p>
          <p className="text-2xl font-bold text-cockpit-blue">{formatPrice(feesData.tips_collected || 0)}</p>
        </div>
      </div>

      <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
        <h3 className="text-lg font-bold text-white mb-4">{t('sales.fees.byProcessor')}</h3>
        {processors.length === 0 ? (
          <p className="text-neutral-500 text-sm">{t('sales.fees.noProcessorData')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-neutral-400 text-xs uppercase tracking-wide">
                <tr className="border-b border-neutral-800">
                  <th className="text-left py-2 pr-4 font-medium">{t('sales.fees.processorColumn')}</th>
                  <th className="text-right py-2 px-2 font-medium">{t('sales.fees.processorCount')}</th>
                  <th className="text-right py-2 px-2 font-medium">{t('sales.fees.processorRevenue')}</th>
                  <th className="text-right py-2 px-2 font-medium">{t('sales.fees.processorFees')}</th>
                  <th className="text-right py-2 px-2 font-medium">{t('sales.fees.processorFeeRate')}</th>
                  <th className="text-right py-2 px-2 font-medium">{t('sales.fees.processorTips')}</th>
                  <th className="text-right py-2 pl-2 font-medium">{t('sales.fees.processorNet')}</th>
                </tr>
              </thead>
              <tbody>
                {processors.map((p) => (
                  <tr key={p.processor} className="border-b border-neutral-800/60 last:border-0">
                    <td className="py-2.5 pr-4 text-white font-medium">{PROCESSOR_LABELS[p.processor] || p.processor}</td>
                    <td className="py-2.5 px-2 text-neutral-300 text-right">{p.count}</td>
                    <td className="py-2.5 px-2 text-neutral-300 text-right">{formatPrice(p.revenue)}</td>
                    <td className="py-2.5 px-2 text-brand-400 text-right">{formatPrice(p.fees)}</td>
                    <td className="py-2.5 px-2 text-cockpit-yellow text-right">{p.fee_percent.toFixed(2)}%</td>
                    <td className="py-2.5 px-2 text-cockpit-blue text-right">{formatPrice(p.tips)}</td>
                    <td className="py-2.5 pl-2 text-cockpit-green text-right">{formatPrice(p.net)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
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
              <Bar dataKey="revenue" fill="#1F5B34" name={t('sales.fees.chartRevenue')} />
              <Bar dataKey="fees" fill="#C94B1B" name={t('sales.fees.chartFees')} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
