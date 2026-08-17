import { useTranslation } from 'react-i18next';
import { AlertCircle } from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';

import { DeliveryMarginsReport, ChannelComparisonReport } from '../../api';
import { CHART_PALETTE_6 } from '../../utils/chartPalette';
import { channelLabel } from '../../utils/channelLabels';
import { formatMoney as fmt, formatInt as intFmt } from '../../utils/currency';

interface DeliveryTabProps {
  deliveryData: DeliveryMarginsReport | null;
  channelData: ChannelComparisonReport | null;
}

const CHART_SURFACE = '#171717'; // neutral-900 card background
const GRID_STROKE = '#404040'; // neutral-700
const AXIS_STROKE = '#737373'; // neutral-500
const TOOLTIP_STYLE = {
  backgroundColor: '#171717',
  border: '1px solid #404040',
  borderRadius: '8px',
} as const;

// The Delivery tab reads as a reconciliation: Ventas Totales (what the customer
// paid — the base platforms charge commission on) minus commission = Neto a
// Casa. Commissions with no reconciled pesos (live-tagged POS re-rings) are
// estimated at the configured percent and marked ≈.
export default function DeliveryTab({ deliveryData, channelData }: DeliveryTabProps) {
  const { t } = useTranslation('reports');

  const platforms = (deliveryData?.platforms || []).filter(p => p.order_count > 0);
  const daily = deliveryData?.daily || [];
  const channels = (channelData?.channels || []).filter(c => c.order_count > 0);

  const totals = platforms.reduce(
    (acc, p) => ({
      orders: acc.orders + Number(p.order_count || 0),
      gross: acc.gross + Number(p.gross_revenue || 0),
      net: acc.net + Number(p.revenue || 0),
      commission: acc.commission + Number(p.total_commission || 0),
      estimated: acc.estimated + Number(p.estimated_commission || 0),
      estimatedOrders: acc.estimatedOrders + Number(p.estimated_order_count || 0),
      netToHouse: acc.netToHouse + Number(p.net_to_house || 0),
    }),
    { orders: 0, gross: 0, net: 0, commission: 0, estimated: 0, estimatedOrders: 0, netToHouse: 0 }
  );
  const totalEffectivePct = totals.gross > 0
    ? ((totals.commission + totals.estimated) / totals.gross) * 100
    : 0;

  // Color follows the platform, in the server's stable display_name order —
  // filtering a day out of the trend must not repaint the survivors.
  const platformColor = new Map(
    (deliveryData?.platforms || []).map((p, i) => [p.display_name, CHART_PALETTE_6[i % CHART_PALETTE_6.length]])
  );

  // Pivot the daily rows into one object per day for the stacked trend.
  const trendDays = Array.from(new Set(daily.map(d => d.day))).sort();
  const trendData = trendDays.map(day => {
    const row: Record<string, number | string> = { day };
    for (const d of daily.filter(x => x.day === day)) {
      row[d.display_name] = d.commission;
    }
    return row;
  });
  const trendSeries = Array.from(new Set(daily.map(d => d.display_name)));

  if (platforms.length === 0 && channels.length === 0) {
    return (
      <div className="bg-neutral-900 rounded-lg border border-neutral-800 p-12 text-center">
        <AlertCircle className="mx-auto text-neutral-600 mb-3" size={40} />
        <p className="text-neutral-400">{t('sales.deliveryTab.noDeliveryOrders')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {platforms.length > 0 && (
        <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
          <h3 className="text-xl font-bold text-white">{t('sales.deliveryTab.reconciliation')}</h3>
          <p className="text-sm text-neutral-400 mt-1 mb-4">{t('sales.deliveryTab.reconciliationHint')}</p>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-neutral-800 border-b border-neutral-700">
                <tr>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-neutral-300">{t('sales.deliveryTab.provider')}</th>
                  <th className="px-6 py-3 text-right text-sm font-semibold text-neutral-300">{t('sales.overview.columns.orders')}</th>
                  <th className="px-6 py-3 text-right text-sm font-semibold text-neutral-300">{t('sales.deliveryTab.grossSales')}</th>
                  <th className="px-6 py-3 text-right text-sm font-semibold text-neutral-300">{t('sales.deliveryTab.netSales')}</th>
                  <th className="px-6 py-3 text-right text-sm font-semibold text-neutral-300">{t('sales.deliveryTab.commission')}</th>
                  <th className="px-6 py-3 text-right text-sm font-semibold text-neutral-300">{t('sales.deliveryTab.effectiveCommission')}</th>
                  <th className="px-6 py-3 text-right text-sm font-semibold text-neutral-300">{t('sales.deliveryTab.netToHouse')}</th>
                </tr>
              </thead>
              <tbody>
                {platforms.map(p => (
                  <tr key={p.platform_id} className="border-b border-neutral-800 hover:bg-neutral-800/50">
                    <td className="px-6 py-4 font-medium text-white">
                      <span
                        className="inline-block w-2.5 h-2.5 rounded-full mr-2 align-middle"
                        style={{ backgroundColor: platformColor.get(p.display_name) }}
                      />
                      {p.display_name}
                    </td>
                    <td className="px-6 py-4 text-right text-neutral-300">{intFmt(p.order_count)}</td>
                    <td className="px-6 py-4 text-right text-neutral-300">{fmt(p.gross_revenue)}</td>
                    <td className="px-6 py-4 text-right text-neutral-300">{fmt(p.revenue)}</td>
                    <td className="px-6 py-4 text-right text-neutral-300">
                      {fmt(p.total_commission)}
                      {p.estimated_commission > 0 && (
                        <span
                          className="text-cockpit-attention-text ml-1"
                          title={t('sales.deliveryTab.estimatedNote', { n: p.estimated_order_count })}
                        >
                          + ≈{fmt(p.estimated_commission)}*
                        </span>
                      )}
                    </td>
                    <td className="px-6 py-4 text-right text-neutral-300">
                      <div>{p.effective_commission_percent.toFixed(1)}%</div>
                      <div className="text-xs text-neutral-500">
                        {t('sales.deliveryTab.configuredPercent', { percent: p.commission_percent })}
                      </div>
                    </td>
                    <td className="px-6 py-4 text-right font-medium text-cockpit-in-text">{fmt(p.net_to_house)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-neutral-800/60 border-t-2 border-neutral-700">
                <tr>
                  <td className="px-6 py-4 font-bold text-white">{t('sales.deliveryTab.totals')}</td>
                  <td className="px-6 py-4 text-right font-bold text-white">{intFmt(totals.orders)}</td>
                  <td className="px-6 py-4 text-right font-bold text-white">{fmt(totals.gross)}</td>
                  <td className="px-6 py-4 text-right font-bold text-white">{fmt(totals.net)}</td>
                  <td className="px-6 py-4 text-right font-bold text-white">
                    {fmt(totals.commission)}
                    {totals.estimated > 0 && (
                      <span className="text-cockpit-attention-text ml-1">+ ≈{fmt(totals.estimated)}*</span>
                    )}
                  </td>
                  <td className="px-6 py-4 text-right font-bold text-white">{totalEffectivePct.toFixed(1)}%</td>
                  <td className="px-6 py-4 text-right font-bold text-cockpit-in-text">{fmt(totals.netToHouse)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          {totals.estimated > 0 && (
            <p className="text-sm text-cockpit-attention-text mt-3">
              * {t('sales.deliveryTab.estimatedNote', { n: totals.estimatedOrders })}
            </p>
          )}
        </div>
      )}

      {channels.length > 0 && (
        <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
          <h3 className="text-xl font-bold text-white mb-4">{t('sales.deliveryTab.channelComparison')}</h3>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={channels.map(c => ({ ...c, label: channelLabel(t, c.channel) }))}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} vertical={false} />
              <XAxis dataKey="label" stroke={AXIS_STROKE} tickLine={false} />
              <YAxis stroke={AXIS_STROKE} tickLine={false} axisLine={false} />
              <Tooltip
                formatter={(value) => fmt(value as number)}
                contentStyle={TOOLTIP_STYLE}
                cursor={{ fill: 'rgba(255,255,255,0.04)' }}
              />
              <Bar
                dataKey="gross_revenue"
                fill={CHART_PALETTE_6[0]}
                name={t('sales.overview.columns.totalSales')}
                radius={[4, 4, 0, 0]}
                maxBarSize={56}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {trendData.length > 1 && trendSeries.length > 0 && (
        <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
          <h3 className="text-xl font-bold text-white mb-4">{t('sales.deliveryTab.commissionTrend')}</h3>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={trendData}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} vertical={false} />
              <XAxis dataKey="day" stroke={AXIS_STROKE} tickLine={false} />
              <YAxis stroke={AXIS_STROKE} tickLine={false} axisLine={false} />
              <Tooltip
                formatter={(value) => fmt(value as number)}
                contentStyle={TOOLTIP_STYLE}
                cursor={{ fill: 'rgba(255,255,255,0.04)' }}
              />
              <Legend />
              {trendSeries.map(name => (
                <Bar
                  key={name}
                  dataKey={name}
                  stackId="commission"
                  fill={platformColor.get(name)}
                  stroke={CHART_SURFACE}
                  strokeWidth={2}
                  maxBarSize={40}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
