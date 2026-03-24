import React from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle } from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';

const fmt = (v: number) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(v);

interface DeliveryTabProps {
  deliveryData: any;
  channelData: any;
}

export default function DeliveryTab({ deliveryData, channelData }: DeliveryTabProps) {
  const { t } = useTranslation('reports');

  return (
    <div className="space-y-6">
      {channelData?.channels && channelData.channels.length > 0 && (
        <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
          <h3 className="text-xl font-bold text-white mb-4">{t('sales.deliveryTab.channelComparison')}</h3>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={channelData.channels.map((c: any) => ({
              ...c,
              channel: c.channel === 'pos' ? 'In-Store' : c.channel === 'uber_eats' ? 'Uber Eats' : c.channel === 'rappi' ? 'Rappi' : c.channel === 'didi_food' ? 'DiDi Food' : c.channel,
            }))}>
              <CartesianGrid strokeDasharray="3 3" stroke="#404040" />
              <XAxis dataKey="channel" stroke="#737373" />
              <YAxis stroke="#737373" />
              <Tooltip formatter={(value) => fmt(value as number)} contentStyle={{ backgroundColor: '#171717', border: '1px solid #404040', borderRadius: '8px' }} />
              <Legend />
              <Bar dataKey="revenue" fill="#0d9488" name={t('sales.chartLegend.revenue')} />
              <Bar dataKey="order_count" fill="#737373" name={t('sales.chartLegend.orders')} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {deliveryData?.platforms && (
        <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
          <h3 className="text-xl font-bold text-white mb-4">{t('sales.deliveryTab.platformMargins')}</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {deliveryData.platforms.map((p: any, i: number) => (
              <div key={i} className="bg-neutral-800 p-4 rounded-lg">
                <h4 className="text-lg font-bold text-white mb-2">{p.display_name}</h4>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between"><span className="text-neutral-400">{t('sales.overview.columns.orders')}</span><span className="text-white">{p.order_count || 0}</span></div>
                  <div className="flex justify-between"><span className="text-neutral-400">{t('sales.chartLegend.revenue')}</span><span className="text-white">{fmt(p.revenue || 0)}</span></div>
                  <div className="flex justify-between"><span className="text-neutral-400">{t('sales.deliveryTab.commissionWithPercent', { percent: p.commission_percent })}</span><span className="text-brand-400">{fmt(p.total_commission || 0)}</span></div>
                  <div className="flex justify-between"><span className="text-neutral-400">{t('sales.deliveryTab.netRevenue')}</span><span className="text-green-400 font-bold">{fmt(p.net_revenue || 0)}</span></div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {(!deliveryData?.platforms || deliveryData.platforms.every((p: any) => !p.order_count)) && (
        <div className="bg-neutral-900 rounded-lg border border-neutral-800 p-12 text-center">
          <AlertCircle className="mx-auto text-neutral-600 mb-3" size={40} />
          <p className="text-neutral-400">{t('sales.deliveryTab.noDeliveryOrders')}</p>
        </div>
      )}
    </div>
  );
}
