import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer,
  LineChart, Line, XAxis, YAxis, CartesianGrid,
} from 'recharts';
import { RefundSummary } from '../../types';
import { formatPrice } from '../../utils/currency';

const COLORS = ['#0d9488', '#16a34a', '#2563eb', '#ca8a04', '#7c3aed', '#ea580c'];

interface RefundsTabProps {
  refundData: RefundSummary;
}

export default function RefundsTab({ refundData }: RefundsTabProps) {
  const { t } = useTranslation('reports');

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
          <p className="text-neutral-400 text-sm">{t('sales.refunds.totalRefunds')}</p>
          <p className="text-2xl font-bold text-white">{refundData.total_refunds}</p>
        </div>
        <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
          <p className="text-neutral-400 text-sm">{t('sales.refunds.totalRefunded')}</p>
          <p className="text-2xl font-bold text-brand-400">{formatPrice(refundData.total_refunded_amount || 0)}</p>
        </div>
      </div>

      {refundData.by_reason && refundData.by_reason.length > 0 && (
        <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
          <h3 className="text-lg font-bold text-white mb-4">{t('sales.refunds.byReason')}</h3>
          <ResponsiveContainer width="100%" height={300}>
            <PieChart>
              <Pie
                data={refundData.by_reason}
                dataKey="count"
                nameKey="reason"
                cx="50%"
                cy="50%"
                outerRadius={100}
                label={(entry: any) => entry.reason}
              >
                {refundData.by_reason.map((_: any, i: number) => (
                  <Cell key={i} fill={COLORS[i % COLORS.length]} />
                ))}
              </Pie>
              <Tooltip contentStyle={{ backgroundColor: '#171717', border: '1px solid #333', borderRadius: '8px' }} />
            </PieChart>
          </ResponsiveContainer>
        </div>
      )}

      {refundData.by_employee && refundData.by_employee.length > 0 && (
        <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
          <h3 className="text-lg font-bold text-white mb-4">{t('sales.refunds.byEmployee')}</h3>
          <div className="space-y-2">
            {refundData.by_employee.map((emp: any, i: number) => (
              <div key={i} className="flex items-center justify-between p-3 bg-neutral-800 rounded-lg">
                <span className="text-white font-medium">{emp.employee_name}</span>
                <div className="text-right">
                  <span className="text-neutral-400 text-sm mr-3">{t('sales.refunds.refundsCount', { count: emp.count })}</span>
                  <span className="text-brand-400 font-bold">{formatPrice(emp.amount)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {refundData.daily && refundData.daily.length > 0 && (
        <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
          <h3 className="text-lg font-bold text-white mb-4">{t('sales.refunds.dailyTrend')}</h3>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={refundData.daily}>
              <CartesianGrid strokeDasharray="3 3" stroke="#333" />
              <XAxis dataKey="date" stroke="#888" tick={{ fontSize: 12 }} />
              <YAxis stroke="#888" />
              <Tooltip contentStyle={{ backgroundColor: '#171717', border: '1px solid #333', borderRadius: '8px' }} />
              <Line type="monotone" dataKey="amount" stroke="#0d9488" strokeWidth={2} name={t('sales.refunds.amount')} />
              <Line type="monotone" dataKey="count" stroke="#ca8a04" strokeWidth={2} name={t('sales.refunds.count')} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
