import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { CategoryMargins } from '../../types';

const fmt = (v: number) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(v);

interface CategoriesTabProps {
  categoryData: CategoryMargins;
}

export default function CategoriesTab({ categoryData }: CategoriesTabProps) {
  const { t } = useTranslation('reports');

  return (
    <div className="space-y-6">
      <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
        <h3 className="text-xl font-bold text-white mb-4">{t('sales.categories.revenueVsCogs')}</h3>
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={categoryData.categories}>
            <CartesianGrid strokeDasharray="3 3" stroke="#404040" />
            <XAxis dataKey="category_name" stroke="#737373" />
            <YAxis stroke="#737373" />
            <Tooltip formatter={(value) => fmt(value as number)} contentStyle={{ backgroundColor: '#171717', border: '1px solid #404040', borderRadius: '8px' }} />
            <Legend />
            <Bar dataKey="revenue" fill="#0d9488" name={t('sales.chartLegend.revenue')} />
            <Bar dataKey="cogs" fill="#d97706" name={t('sales.chartLegend.cogs')} />
            <Bar dataKey="margin" fill="#16a34a" name={t('sales.chartLegend.margin')} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
        <h3 className="text-xl font-bold text-white mb-4">{t('sales.categories.categoryDetails')}</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {categoryData.categories.map((cat, i) => (
            <div key={i} className="bg-neutral-800 p-4 rounded-lg">
              <h4 className="text-lg font-bold text-white mb-3">{cat.category_name}</h4>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between"><span className="text-neutral-400">{t('sales.categories.revenue')}</span><span className="text-white font-bold">{fmt(cat.revenue)}</span></div>
                <div className="flex justify-between"><span className="text-neutral-400">{t('sales.categories.cogs')}</span><span className="text-amber-400 font-bold">{fmt(cat.cogs)}</span></div>
                <div className="flex justify-between"><span className="text-neutral-400">{t('sales.categories.margin')}</span><span className="text-green-400 font-bold">{fmt(cat.margin)}</span></div>
                <div className="flex justify-between"><span className="text-neutral-400">{t('sales.categories.marginPercent')}</span>
                  <span className={`font-bold ${cat.margin_percent >= 60 ? 'text-green-400' : cat.margin_percent >= 40 ? 'text-amber-400' : 'text-brand-400'}`}>
                    {cat.margin_percent}%
                  </span>
                </div>
                <div className="flex justify-between"><span className="text-neutral-400">{t('sales.categories.itemsSold')}</span><span className="text-white">{cat.quantity_sold}</span></div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
