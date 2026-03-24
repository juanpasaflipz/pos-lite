import React from 'react';
import { useTranslation } from 'react-i18next';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts';
import { CashCardBreakdown } from '../../types';

const COLORS = ['#0d9488', '#16a34a', '#2563eb', '#ca8a04', '#7c3aed', '#ea580c'];
const fmt = (v: number) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(v);

interface CashCardTabProps {
  cashCard: CashCardBreakdown;
}

export default function CashCardTab({ cashCard }: CashCardTabProps) {
  const { t } = useTranslation('reports');

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
          <p className="text-neutral-400 text-sm">{t('sales.kpi.totalOrders')}</p>
          <p className="text-3xl font-bold text-white mt-2">{cashCard.total_orders}</p>
        </div>
        <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
          <p className="text-neutral-400 text-sm">{t('sales.kpi.totalRevenue')}</p>
          <p className="text-3xl font-bold text-brand-500 mt-2">{fmt(cashCard.total_revenue)}</p>
        </div>
        <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
          <p className="text-neutral-400 text-sm">{t('sales.cashCard.paymentSplit')}</p>
          <div className="mt-2">
            {cashCard.breakdown.map((b, i) => (
              <p key={i} className="text-lg font-bold text-white">
                {b.payment_method === 'card' ? t('sales.cashCard.card') : t('sales.cashCard.cash')}: {b.percentage}%
              </p>
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
          <h3 className="text-xl font-bold text-white mb-4">{t('sales.cashCard.revenueByMethod')}</h3>
          <ResponsiveContainer width="100%" height={250}>
            <PieChart>
              <Pie
                data={cashCard.breakdown.map(b => ({ name: b.payment_method === 'card' ? t('sales.cashCard.card') : t('sales.cashCard.cash'), value: b.total || 0 }))}
                cx="50%"
                cy="50%"
                innerRadius={60}
                outerRadius={100}
                dataKey="value"
                label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
              >
                {cashCard.breakdown.map((_, i) => (
                  <Cell key={i} fill={COLORS[i]} />
                ))}
              </Pie>
              <Tooltip formatter={(value: number) => fmt(value)} />
            </PieChart>
          </ResponsiveContainer>
        </div>

        <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
          <h3 className="text-xl font-bold text-white mb-4">{t('sales.cashCard.breakdownDetails')}</h3>
          <div className="space-y-4">
            {cashCard.breakdown.map((b, i) => (
              <div key={i} className="p-4 bg-neutral-800 rounded-lg">
                <div className="flex justify-between items-center mb-2">
                  <span className="text-lg font-bold text-white">{b.payment_method === 'card' ? t('sales.cashCard.card') : t('sales.cashCard.cash')}</span>
                  <span className="text-lg font-bold text-brand-400">{fmt(b.total || 0)}</span>
                </div>
                <div className="flex justify-between text-sm text-neutral-400">
                  <span>{t('sales.cashCard.ordersCount', { count: b.count, percent: b.percentage })}</span>
                  <span>{t('sales.cashCard.tips')} {fmt(b.tips || 0)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
