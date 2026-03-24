import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { SalesReport, TopItemsReport, EmployeePerformanceReport, HourlyReport } from '../../types';
import { AlertCircle } from 'lucide-react';

const fmt = (v: number) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(v);

interface OverviewTabProps {
  salesData: SalesReport | null;
  topItems: TopItemsReport[];
  employeePerf: EmployeePerformanceReport[];
  hourlyData: HourlyReport[];
}

export default function OverviewTab({ salesData, topItems, employeePerf, hourlyData }: OverviewTabProps) {
  const { t } = useTranslation('reports');

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
          <p className="text-neutral-400 text-sm font-medium">{t('sales.kpi.totalRevenue')}</p>
          <p className="text-3xl font-bold text-brand-500 mt-2">{fmt(salesData?.total_revenue || 0)}</p>
        </div>
        <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
          <p className="text-neutral-400 text-sm font-medium">{t('sales.kpi.orderCount')}</p>
          <p className="text-3xl font-bold text-white mt-2">{salesData?.order_count || 0}</p>
        </div>
        <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
          <p className="text-neutral-400 text-sm font-medium">{t('sales.kpi.avgTicket')}</p>
          <p className="text-3xl font-bold text-white mt-2">{fmt(salesData?.avg_ticket || 0)}</p>
        </div>
        <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
          <p className="text-neutral-400 text-sm font-medium">{t('sales.kpi.totalTips')}</p>
          <p className="text-3xl font-bold text-white mt-2">{fmt(salesData?.tip_total || 0)}</p>
        </div>
      </div>

      {hourlyData.length > 0 && (
        <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
          <h3 className="text-xl font-bold text-white mb-4">{t('sales.overview.hourlySales')}</h3>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={hourlyData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#404040" />
              <XAxis dataKey="hour" stroke="#737373" />
              <YAxis stroke="#737373" />
              <Tooltip formatter={(value) => fmt(value as number)} contentStyle={{ backgroundColor: '#171717', border: '1px solid #404040', borderRadius: '8px' }} labelStyle={{ color: '#a3a3a3' }} />
              <Legend />
              <Bar dataKey="revenue" fill="#0d9488" name={t('sales.chartLegend.revenue')} />
              <Bar dataKey="orders" fill="#737373" name={t('sales.chartLegend.orders')} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {topItems.length > 0 && (
        <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
          <h3 className="text-xl font-bold text-white mb-4">{t('sales.overview.topSelling')}</h3>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={topItems} layout="vertical" margin={{ left: 200, right: 30 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#404040" />
              <XAxis type="number" stroke="#737373" />
              <YAxis type="category" dataKey="item_name" width={190} tick={{ fontSize: 12, fill: '#a3a3a3' }} stroke="#737373" />
              <Tooltip formatter={(value) => fmt(value as number)} contentStyle={{ backgroundColor: '#171717', border: '1px solid #404040', borderRadius: '8px' }} labelStyle={{ color: '#a3a3a3' }} />
              <Legend />
              <Bar dataKey="revenue" fill="#0d9488" name={t('sales.chartLegend.revenue')} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {employeePerf.length > 0 && (
        <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
          <h3 className="text-xl font-bold text-white mb-4">{t('sales.overview.employeePerformance')}</h3>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-neutral-800 border-b border-neutral-700">
                <tr>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-neutral-300">{t('sales.overview.columns.employee')}</th>
                  <th className="px-6 py-3 text-right text-sm font-semibold text-neutral-300">{t('sales.overview.columns.orders')}</th>
                  <th className="px-6 py-3 text-right text-sm font-semibold text-neutral-300">{t('sales.overview.columns.totalSales')}</th>
                  <th className="px-6 py-3 text-right text-sm font-semibold text-neutral-300">{t('sales.overview.columns.avgTicket')}</th>
                  <th className="px-6 py-3 text-right text-sm font-semibold text-neutral-300">{t('sales.overview.columns.tips')}</th>
                </tr>
              </thead>
              <tbody>
                {employeePerf.map((emp) => (
                  <tr key={emp.employee_id} className="border-b border-neutral-800 hover:bg-neutral-800/50">
                    <td className="px-6 py-4 font-medium text-white">{emp.employee_name}</td>
                    <td className="px-6 py-4 text-right text-neutral-300">{emp.orders_processed}</td>
                    <td className="px-6 py-4 text-right text-neutral-300">{fmt(emp.total_sales)}</td>
                    <td className="px-6 py-4 text-right text-neutral-300">{fmt(emp.avg_ticket)}</td>
                    <td className="px-6 py-4 text-right font-medium text-green-400">{fmt(emp.tips_received)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {topItems.length === 0 && employeePerf.length === 0 && (
        <div className="bg-neutral-900 rounded-lg border border-neutral-800 p-12 text-center">
          <AlertCircle className="mx-auto text-neutral-600 mb-3" size={40} />
          <p className="text-neutral-400">{t('sales.noData')}</p>
        </div>
      )}
    </div>
  );
}
