import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { ContributionMarginReport } from '../../types';

const fmt = (v: number) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(v);

interface MarginTabProps {
  marginData: ContributionMarginReport;
}

export default function MarginTab({ marginData }: MarginTabProps) {
  const { t } = useTranslation('reports');

  return (
    <div className="space-y-6">
      <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
        <h3 className="text-xl font-bold text-white mb-4">{t('sales.margin.dailyContribution')}</h3>
        <ResponsiveContainer width="100%" height={350}>
          <LineChart data={marginData.data}>
            <CartesianGrid strokeDasharray="3 3" stroke="#404040" />
            <XAxis dataKey="date" stroke="#737373" tick={{ fontSize: 11 }} />
            <YAxis stroke="#737373" />
            <Tooltip formatter={(value) => fmt(value as number)} contentStyle={{ backgroundColor: '#171717', border: '1px solid #404040', borderRadius: '8px' }} />
            <Legend />
            <Line type="monotone" dataKey="revenue" stroke="#0d9488" strokeWidth={2} name={t('sales.chartLegend.revenue')} />
            <Line type="monotone" dataKey="cogs" stroke="#d97706" strokeWidth={2} name={t('sales.chartLegend.cogs')} />
            <Line type="monotone" dataKey="contribution_margin" stroke="#16a34a" strokeWidth={3} name={t('sales.chartLegend.contributionMargin')} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
        <h3 className="text-xl font-bold text-white mb-4">{t('sales.margin.dailyBreakdown')}</h3>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-neutral-800 border-b border-neutral-700">
              <tr>
                <th className="px-4 py-3 text-left text-sm font-semibold text-neutral-300">{t('sales.margin.date')}</th>
                <th className="px-4 py-3 text-right text-sm font-semibold text-neutral-300">{t('sales.overview.columns.orders')}</th>
                <th className="px-4 py-3 text-right text-sm font-semibold text-neutral-300">{t('sales.chartLegend.revenue')}</th>
                <th className="px-4 py-3 text-right text-sm font-semibold text-neutral-300">{t('sales.chartLegend.cogs')}</th>
                <th className="px-4 py-3 text-right text-sm font-semibold text-neutral-300">{t('sales.chartLegend.margin')}</th>
                <th className="px-4 py-3 text-right text-sm font-semibold text-neutral-300">%</th>
              </tr>
            </thead>
            <tbody>
              {marginData.data.map((day, i) => (
                <tr key={i} className="border-b border-neutral-800">
                  <td className="px-4 py-3 text-white">{day.date}</td>
                  <td className="px-4 py-3 text-right text-neutral-300">{day.orders}</td>
                  <td className="px-4 py-3 text-right text-neutral-300">{fmt(day.revenue)}</td>
                  <td className="px-4 py-3 text-right text-amber-400">{fmt(day.cogs)}</td>
                  <td className="px-4 py-3 text-right text-green-400">{fmt(day.contribution_margin)}</td>
                  <td className="px-4 py-3 text-right font-bold text-white">{day.margin_percent}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
