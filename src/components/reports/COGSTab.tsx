import React from 'react';
import { useTranslation } from 'react-i18next';
import { COGSReport } from '../../types';

const fmt = (v: number) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(v);

interface COGSTabProps {
  cogsData: COGSReport;
}

export default function COGSTab({ cogsData }: COGSTabProps) {
  const { t } = useTranslation('reports');

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
          <p className="text-neutral-400 text-sm">{t('sales.kpi.totalRevenue')}</p>
          <p className="text-3xl font-bold text-brand-500 mt-2">{fmt(cogsData.totals.total_revenue)}</p>
        </div>
        <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
          <p className="text-neutral-400 text-sm">{t('sales.cogs.totalCogs')}</p>
          <p className="text-3xl font-bold text-amber-500 mt-2">{fmt(cogsData.totals.total_cogs)}</p>
        </div>
        <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
          <p className="text-neutral-400 text-sm">{t('sales.cogs.grossMargin')}</p>
          <p className="text-3xl font-bold text-green-400 mt-2">{fmt(cogsData.totals.total_margin)}</p>
        </div>
        <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
          <p className="text-neutral-400 text-sm">{t('sales.cogs.marginPercent')}</p>
          <p className="text-3xl font-bold text-white mt-2">{cogsData.totals.overall_margin_percent}%</p>
        </div>
      </div>

      <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
        <h3 className="text-xl font-bold text-white mb-4">{t('sales.cogs.perItemCogs')}</h3>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-neutral-800 border-b border-neutral-700">
              <tr>
                <th className="px-4 py-3 text-left text-sm font-semibold text-neutral-300">{t('sales.cogs.columns.item')}</th>
                <th className="px-4 py-3 text-right text-sm font-semibold text-neutral-300">{t('sales.cogs.columns.qty')}</th>
                <th className="px-4 py-3 text-right text-sm font-semibold text-neutral-300">{t('sales.cogs.columns.revenue')}</th>
                <th className="px-4 py-3 text-right text-sm font-semibold text-neutral-300">{t('sales.cogs.columns.cogs')}</th>
                <th className="px-4 py-3 text-right text-sm font-semibold text-neutral-300">{t('sales.cogs.columns.margin')}</th>
                <th className="px-4 py-3 text-right text-sm font-semibold text-neutral-300">{t('sales.cogs.columns.marginPercent')}</th>
              </tr>
            </thead>
            <tbody>
              {cogsData.items.map((item, i) => (
                <tr key={i} className="border-b border-neutral-800 hover:bg-neutral-800/50">
                  <td className="px-4 py-3 font-medium text-white">{item.item_name}</td>
                  <td className="px-4 py-3 text-right text-neutral-300">{item.quantity_sold}</td>
                  <td className="px-4 py-3 text-right text-neutral-300">{fmt(item.revenue)}</td>
                  <td className="px-4 py-3 text-right text-amber-400">{fmt(item.cogs)}</td>
                  <td className="px-4 py-3 text-right text-green-400">{fmt(item.margin)}</td>
                  <td className="px-4 py-3 text-right">
                    <span className={`font-bold ${item.margin_percent >= 60 ? 'text-green-400' : item.margin_percent >= 40 ? 'text-amber-400' : 'text-brand-400'}`}>
                      {item.margin_percent}%
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
