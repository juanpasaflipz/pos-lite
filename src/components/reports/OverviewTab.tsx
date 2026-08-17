import React from 'react';
import { useTranslation } from 'react-i18next';
import { SalesReport, EmployeePerformanceReport, HourlyReport, ItemSalesReport } from '../../types';
import { ChannelComparisonReport } from '../../api';
import { AlertCircle, Filter } from 'lucide-react';
import LaborStrip from './LaborStrip';
import ChannelBreakdown from './ChannelBreakdown';

import { formatMoney as fmt, formatInt as intFmt } from '../../utils/currency';
const hourLabel = (hour: number) => `${String(hour).padStart(2, '0')}:00`;

type ItemSalesFilters = {
  customerId: number | 'all';
  hour: number | 'all';
  minQuantity: number;
  relatedItemId: number | 'all';
};

interface OverviewTabProps {
  salesData: SalesReport | null;
  itemSales: ItemSalesReport | null;
  employeePerf: EmployeePerformanceReport[];
  hourlyData: HourlyReport[];
  channelData: ChannelComparisonReport | null;
  itemSalesFilters: ItemSalesFilters;
  onItemSalesFiltersChange: React.Dispatch<React.SetStateAction<ItemSalesFilters>>;
}

export default function OverviewTab({
  salesData,
  itemSales,
  employeePerf,
  hourlyData,
  channelData,
  itemSalesFilters,
  onItemSalesFiltersChange,
}: OverviewTabProps) {
  const { t } = useTranslation('reports');
  const hasItemSales = !!itemSales && itemSales.items.length > 0;
  const activeHours = hourlyData.filter(hour => hour.orders > 0 || hour.revenue > 0);
  const discountTotal = salesData?.discount_total || 0;

  // Footer row so the table reconciles on screen: the net column adds up to the
  // Net Sales KPI and the order count to the Order Count KPI, for the same range.
  const hourlyTotals = activeHours.reduce(
    (acc, hour) => ({
      orders: acc.orders + Number(hour.orders || 0),
      revenue: acc.revenue + Number(hour.revenue || 0),
      gross_revenue: acc.gross_revenue + Number(hour.gross_revenue || 0),
    }),
    { orders: 0, revenue: 0, gross_revenue: 0 }
  );
  const hourlyAvgTicket = hourlyTotals.orders > 0
    ? hourlyTotals.gross_revenue / hourlyTotals.orders
    : 0;

  return (
    <div className="space-y-6">
      <LaborStrip />

      <div className="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-6 gap-4">
        <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
          <p className="text-neutral-400 text-sm font-medium">{t('sales.kpi.netSales')}</p>
          <p className="text-3xl font-bold text-brand-500 mt-2">{fmt(salesData?.total_revenue || 0)}</p>
        </div>
        <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
          <p className="text-neutral-400 text-sm font-medium">{t('sales.kpi.iva')}</p>
          <p className="text-3xl font-bold text-white mt-2">{fmt(salesData?.tax_total || 0)}</p>
        </div>
        <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
          <p className="text-neutral-400 text-sm font-medium">{t('sales.kpi.discounts')}</p>
          <p className={`text-3xl font-bold mt-2 ${discountTotal > 0 ? 'text-cockpit-attention-text' : 'text-white'}`}>
            {discountTotal > 0 ? `(${fmt(discountTotal)})` : fmt(discountTotal)}
          </p>
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

      {channelData && <ChannelBreakdown channels={channelData.channels} />}

      <div className="bg-neutral-900 rounded-lg border border-neutral-800">
        <div className="p-6 border-b border-neutral-800">
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
            <div>
              <h3 className="text-xl font-bold text-white">{t('sales.overview.itemSales.title')}</h3>
              <p className="text-sm text-neutral-400 mt-1">{t('sales.overview.itemSales.subtitle')}</p>
            </div>
            <div className="flex items-center gap-2 text-sm text-neutral-300">
              <Filter size={18} className="text-neutral-500" />
              <span>{t('sales.overview.itemSales.filters')}</span>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3 mt-5">
            <label className="block">
              <span className="block text-xs font-semibold text-neutral-400 mb-1">{t('sales.overview.itemSales.customer')}</span>
              <select
                value={itemSalesFilters.customerId}
                onChange={(e) => onItemSalesFiltersChange(prev => ({
                  ...prev,
                  customerId: e.target.value === 'all' ? 'all' : Number(e.target.value),
                }))}
                className="w-full min-h-[44px] rounded-lg bg-neutral-950 border border-neutral-700 px-3 text-white"
              >
                <option value="all">{t('sales.overview.itemSales.allCustomers')}</option>
                {itemSales?.customers.map(customer => (
                  <option key={customer.id} value={customer.id}>{customer.name}</option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="block text-xs font-semibold text-neutral-400 mb-1">{t('sales.overview.itemSales.hour')}</span>
              <select
                value={itemSalesFilters.hour}
                onChange={(e) => onItemSalesFiltersChange(prev => ({
                  ...prev,
                  hour: e.target.value === 'all' ? 'all' : Number(e.target.value),
                }))}
                className="w-full min-h-[44px] rounded-lg bg-neutral-950 border border-neutral-700 px-3 text-white"
              >
                <option value="all">{t('sales.overview.itemSales.allHours')}</option>
                {Array.from({ length: 24 }, (_, hour) => (
                  <option key={hour} value={hour}>{hourLabel(hour)}</option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="block text-xs font-semibold text-neutral-400 mb-1">{t('sales.overview.itemSales.minItems')}</span>
              <input
                type="number"
                min="0"
                value={itemSalesFilters.minQuantity}
                onChange={(e) => onItemSalesFiltersChange(prev => ({
                  ...prev,
                  minQuantity: Math.max(0, Number(e.target.value) || 0),
                }))}
                className="w-full min-h-[44px] rounded-lg bg-neutral-950 border border-neutral-700 px-3 text-white"
              />
            </label>

            <label className="block">
              <span className="block text-xs font-semibold text-neutral-400 mb-1">{t('sales.overview.itemSales.relatedItem')}</span>
              <select
                value={itemSalesFilters.relatedItemId}
                onChange={(e) => onItemSalesFiltersChange(prev => ({
                  ...prev,
                  relatedItemId: e.target.value === 'all' ? 'all' : Number(e.target.value),
                }))}
                className="w-full min-h-[44px] rounded-lg bg-neutral-950 border border-neutral-700 px-3 text-white"
              >
                <option value="all">{t('sales.overview.itemSales.anyItem')}</option>
                {itemSales?.item_options.map(item => (
                  <option key={item.item_id} value={item.item_id}>{item.item_name}</option>
                ))}
              </select>
            </label>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 border-b border-neutral-800">
          <div className="p-5 border-b md:border-b-0 md:border-r border-neutral-800">
            <p className="text-sm font-medium text-neutral-400">{t('sales.overview.itemSales.totalItems')}</p>
            <p className="text-3xl font-bold text-white mt-2">{intFmt(itemSales?.totals.quantity_sold || 0)}</p>
          </div>
          <div className="p-5 border-b md:border-b-0 md:border-r border-neutral-800">
            <p className="text-sm font-medium text-neutral-400">{t('sales.overview.itemSales.uniqueItems')}</p>
            <p className="text-3xl font-bold text-white mt-2">{intFmt(itemSales?.totals.unique_items || 0)}</p>
          </div>
          <div className="p-5">
            <p className="text-sm font-medium text-neutral-400">{t('sales.overview.itemSales.itemRevenue')}</p>
            <p className="text-3xl font-bold text-brand-500 mt-2">{fmt(itemSales?.totals.revenue || 0)}</p>
            <p className="text-xs text-neutral-500 mt-1">{t('sales.overview.itemSales.itemRevenueHint')}</p>
          </div>
        </div>

        {hasItemSales ? (
          <>
            <div className="p-6 border-b border-neutral-800">
              <h4 className="text-lg font-bold text-white mb-4">{t('sales.overview.itemSales.byCategory')}</h4>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-neutral-800 border-b border-neutral-700">
                    <tr>
                      <th className="px-4 py-3 text-left text-sm font-semibold text-neutral-300">{t('sales.overview.itemSales.columns.category')}</th>
                      <th className="px-4 py-3 text-right text-sm font-semibold text-neutral-300">{t('sales.overview.itemSales.columns.itemsSold')}</th>
                      <th className="px-4 py-3 text-right text-sm font-semibold text-neutral-300">{t('sales.overview.itemSales.columns.mix')}</th>
                      <th className="px-4 py-3 text-right text-sm font-semibold text-neutral-300">{t('sales.overview.itemSales.columns.uniqueItems')}</th>
                      <th className="px-4 py-3 text-right text-sm font-semibold text-neutral-300">{t('sales.overview.itemSales.columns.revenue')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {itemSales.categories.map(category => (
                      <tr key={category.category_id} className="border-b border-neutral-800 hover:bg-neutral-800/50">
                        <td className="px-4 py-4 font-medium text-white">{category.category_name}</td>
                        <td className="px-4 py-4 text-right text-white font-semibold">{intFmt(category.quantity_sold)}</td>
                        <td className="px-4 py-4 text-right text-neutral-300">{category.item_mix_percent}%</td>
                        <td className="px-4 py-4 text-right text-neutral-300">{intFmt(category.item_count)}</td>
                        <td className="px-4 py-4 text-right text-neutral-300">{fmt(category.revenue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="p-6">
              <h4 className="text-lg font-bold text-white mb-4">{t('sales.overview.itemSales.itemDetail')}</h4>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-neutral-800 border-b border-neutral-700">
                    <tr>
                      <th className="px-4 py-3 text-left text-sm font-semibold text-neutral-300">{t('sales.overview.itemSales.columns.item')}</th>
                      <th className="px-4 py-3 text-left text-sm font-semibold text-neutral-300">{t('sales.overview.itemSales.columns.category')}</th>
                      <th className="px-4 py-3 text-right text-sm font-semibold text-neutral-300">{t('sales.overview.itemSales.columns.itemsSold')}</th>
                      <th className="px-4 py-3 text-right text-sm font-semibold text-neutral-300">{t('sales.overview.itemSales.columns.orders')}</th>
                      <th className="px-4 py-3 text-right text-sm font-semibold text-neutral-300">{t('sales.overview.itemSales.columns.customers')}</th>
                      <th className="px-4 py-3 text-right text-sm font-semibold text-neutral-300">{t('sales.overview.itemSales.columns.avgPrice')}</th>
                      <th className="px-4 py-3 text-right text-sm font-semibold text-neutral-300">{t('sales.overview.itemSales.columns.revenue')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {itemSales.items.map(item => (
                      <tr key={`${item.category_id}-${item.item_id}-${item.item_name}`} className="border-b border-neutral-800 hover:bg-neutral-800/50">
                        <td className="px-4 py-4 font-medium text-white">{item.item_name}</td>
                        <td className="px-4 py-4 text-neutral-300">{item.category_name}</td>
                        <td className="px-4 py-4 text-right text-white font-semibold">{intFmt(item.quantity_sold)}</td>
                        <td className="px-4 py-4 text-right text-neutral-300">{intFmt(item.orders_count)}</td>
                        <td className="px-4 py-4 text-right text-neutral-300">{intFmt(item.customer_count)}</td>
                        <td className="px-4 py-4 text-right text-neutral-300">{fmt(item.avg_unit_price)}</td>
                        <td className="px-4 py-4 text-right text-neutral-300">{fmt(item.revenue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        ) : (
          <div className="p-12 text-center">
            <AlertCircle className="mx-auto text-neutral-600 mb-3" size={40} />
            <p className="text-neutral-400">{t('sales.noData')}</p>
          </div>
        )}
      </div>

      {activeHours.length > 0 && (
        <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
          <h3 className="text-xl font-bold text-white">{t('sales.overview.hourlySales')}</h3>
          <p className="text-sm text-neutral-400 mt-1 mb-4">{t('sales.overview.hourlySalesHint')}</p>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-neutral-800 border-b border-neutral-700">
                <tr>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-neutral-300">{t('sales.overview.columns.hour')}</th>
                  <th className="px-6 py-3 text-right text-sm font-semibold text-neutral-300">{t('sales.overview.columns.orders')}</th>
                  <th className="px-6 py-3 text-right text-sm font-semibold text-neutral-300">{t('sales.overview.columns.netSales')}</th>
                  <th className="px-6 py-3 text-right text-sm font-semibold text-neutral-300">{t('sales.overview.columns.totalSales')}</th>
                  <th className="px-6 py-3 text-right text-sm font-semibold text-neutral-300">{t('sales.overview.columns.avgTicket')}</th>
                </tr>
              </thead>
              <tbody>
                {activeHours.map(hour => (
                  <tr key={hour.hour} className="border-b border-neutral-800 hover:bg-neutral-800/50">
                    <td className="px-6 py-4 font-medium text-white">{hourLabel(hour.hour)}</td>
                    <td className="px-6 py-4 text-right text-neutral-300">{intFmt(hour.orders)}</td>
                    <td className="px-6 py-4 text-right text-neutral-300">{fmt(hour.revenue)}</td>
                    <td className="px-6 py-4 text-right text-neutral-300">{fmt(hour.gross_revenue)}</td>
                    <td className="px-6 py-4 text-right text-neutral-300">{fmt(hour.avg_ticket)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-neutral-800/60 border-t-2 border-neutral-700">
                <tr>
                  <td className="px-6 py-4 font-bold text-white">{t('sales.overview.columns.total')}</td>
                  <td className="px-6 py-4 text-right font-bold text-white">{intFmt(hourlyTotals.orders)}</td>
                  <td className="px-6 py-4 text-right font-bold text-brand-500">{fmt(hourlyTotals.revenue)}</td>
                  <td className="px-6 py-4 text-right font-bold text-white">{fmt(hourlyTotals.gross_revenue)}</td>
                  <td className="px-6 py-4 text-right font-bold text-white">{fmt(hourlyAvgTicket)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
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
                  <th className="px-6 py-3 text-right text-sm font-semibold text-neutral-300">{t('sales.overview.columns.netSales')}</th>
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
                    <td className="px-6 py-4 text-right text-neutral-300">{fmt(emp.gross_sales)}</td>
                    <td className="px-6 py-4 text-right text-neutral-300">{fmt(emp.avg_ticket)}</td>
                    <td className="px-6 py-4 text-right font-medium text-cockpit-in-text">{fmt(emp.tips_received)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {employeePerf.length === 0 && !hasItemSales && (
        <div className="bg-neutral-900 rounded-lg border border-neutral-800 p-12 text-center">
          <AlertCircle className="mx-auto text-neutral-600 mb-3" size={40} />
          <p className="text-neutral-400">{t('sales.noData')}</p>
        </div>
      )}
    </div>
  );
}
