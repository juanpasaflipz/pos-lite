import { useTranslation } from 'react-i18next';
import { ChannelComparisonRow } from '../../api';
import { channelLabel } from '../../utils/channelLabels';
import { formatMoney as fmt, formatInt as intFmt } from '../../utils/currency';

interface ChannelBreakdownProps {
  channels: ChannelComparisonRow[];
}

// "Ventas por Canal" on the Overview tab. The reconciliation contract: the net
// column's footer total equals the Net Sales KPI above it — both come from the
// same canonical paid/timezone filter on the server.
export default function ChannelBreakdown({ channels }: ChannelBreakdownProps) {
  const { t } = useTranslation('reports');

  const active = channels.filter(c => c.order_count > 0);
  if (active.length <= 1) return null;

  const totals = active.reduce(
    (acc, c) => ({
      orders: acc.orders + Number(c.order_count || 0),
      revenue: acc.revenue + Number(c.revenue || 0),
      gross_revenue: acc.gross_revenue + Number(c.gross_revenue || 0),
    }),
    { orders: 0, revenue: 0, gross_revenue: 0 }
  );
  const avgTicket = totals.orders > 0 ? totals.gross_revenue / totals.orders : 0;

  return (
    <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
      <h3 className="text-xl font-bold text-white">{t('sales.overview.channelSection')}</h3>
      <p className="text-sm text-neutral-400 mt-1 mb-4">{t('sales.overview.channelSectionHint')}</p>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-neutral-800 border-b border-neutral-700">
            <tr>
              <th className="px-6 py-3 text-left text-sm font-semibold text-neutral-300">{t('sales.overview.columns.channel')}</th>
              <th className="px-6 py-3 text-right text-sm font-semibold text-neutral-300">{t('sales.overview.columns.orders')}</th>
              <th className="px-6 py-3 text-right text-sm font-semibold text-neutral-300">{t('sales.overview.columns.netSales')}</th>
              <th className="px-6 py-3 text-right text-sm font-semibold text-neutral-300">{t('sales.overview.columns.totalSales')}</th>
              <th className="px-6 py-3 text-right text-sm font-semibold text-neutral-300">{t('sales.overview.columns.avgTicket')}</th>
              <th className="px-6 py-3 text-right text-sm font-semibold text-neutral-300">{t('sales.overview.columns.mix')}</th>
            </tr>
          </thead>
          <tbody>
            {active.map(channel => (
              <tr key={channel.channel} className="border-b border-neutral-800 hover:bg-neutral-800/50">
                <td className="px-6 py-4 font-medium text-white">{channelLabel(t, channel.channel)}</td>
                <td className="px-6 py-4 text-right text-neutral-300">{intFmt(channel.order_count)}</td>
                <td className="px-6 py-4 text-right text-neutral-300">{fmt(channel.revenue)}</td>
                <td className="px-6 py-4 text-right text-neutral-300">{fmt(channel.gross_revenue)}</td>
                <td className="px-6 py-4 text-right text-neutral-300">{fmt(channel.avg_ticket)}</td>
                <td className="px-6 py-4 text-right text-neutral-300">
                  {totals.revenue > 0 ? `${((channel.revenue / totals.revenue) * 100).toFixed(1)}%` : '—'}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="bg-neutral-800/60 border-t-2 border-neutral-700">
            <tr>
              <td className="px-6 py-4 font-bold text-white">{t('sales.overview.columns.total')}</td>
              <td className="px-6 py-4 text-right font-bold text-white">{intFmt(totals.orders)}</td>
              <td className="px-6 py-4 text-right font-bold text-brand-500">{fmt(totals.revenue)}</td>
              <td className="px-6 py-4 text-right font-bold text-white">{fmt(totals.gross_revenue)}</td>
              <td className="px-6 py-4 text-right font-bold text-white">{fmt(avgTicket)}</td>
              <td className="px-6 py-4 text-right font-bold text-white">100%</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
