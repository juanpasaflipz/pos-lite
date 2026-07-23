import React, { useState, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Download, X } from 'lucide-react';
import {
  getSalesReport,
  getItemSalesReport,
  getEmployeePerformance,
  getHourlyReport,
  getCashCardBreakdown,
  getCOGSReport,
  getCategoryMargins,
  getContributionMargin,
  getDeliveryMargins,
  getChannelComparison,
  getPaymentFees,
  getRefundSummary,
  getFinancialProjection,
  getMenuEngineering,
} from '../api';
import { useAuth } from '../context/AuthContext';
import { formatPrice } from '../utils/currency';
import { formatDate, todayInTz } from '../utils/dateFormat';
import BrandLogo from '../components/BrandLogo';
import { usePlan } from '../context/PlanContext';
import {
  SalesReport,
  ItemSalesReport,
  EmployeePerformanceReport,
  HourlyReport,
  CashCardBreakdown,
  COGSReport,
  CategoryMargins,
  ContributionMarginReport,
  PaymentFeeSummary,
  RefundSummary,
  FinancialProjection,
  MenuEngineeringReport,
} from '../types';
import OverviewTab from '../components/reports/OverviewTab';
import CashCardTab from '../components/reports/CashCardTab';
import COGSTab from '../components/reports/COGSTab';
import CategoriesTab from '../components/reports/CategoriesTab';
import MarginTab from '../components/reports/MarginTab';
import DeliveryTab from '../components/reports/DeliveryTab';
import FeesTab from '../components/reports/FeesTab';
import RefundsTab from '../components/reports/RefundsTab';
import FinancialsTab from '../components/reports/FinancialsTab';
import MenuEngineeringTab from '../components/reports/MenuEngineeringTab';
import PayrollTab from '../components/reports/PayrollTab';
import BreakEvenTab from '../components/reports/BreakEvenTab';

type Period = 'today' | 'week' | 'month' | 'yesterday' | 'last_week' | 'last_month' | 'custom';
type Tab = 'overview' | 'cashcard' | 'cogs' | 'categories' | 'margin' | 'delivery' | 'fees' | 'refunds' | 'financials' | 'engineering' | 'payroll' | 'breakeven';

const VALID_TABS: Tab[] = ['overview', 'cashcard', 'cogs', 'categories', 'margin', 'delivery', 'fees', 'refunds', 'financials', 'engineering', 'payroll', 'breakeven'];

// Local YYYY-MM-DD (matches the user's wall clock; tenant tz handled server-side).
const localYmd = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export default function ReportsScreen() {
  const { t } = useTranslation('reports');
  const { currentEmployee } = useAuth();
  const { limits, timezone: tenantTz, weekStartDow, isFree } = usePlan();
  // Repackaged 2026-07-23: free plan keeps a rolling report window
  // (limits.reportsHistoryDays, server-clamped in resolveDateRange); full
  // history + break-even + cost variables are Pro. The chip below is the
  // only client change needed — the server clamp keeps old presets working.
  const historyLimited = Number.isFinite(limits.reportsHistoryDays);
  const [searchParams, setSearchParams] = useSearchParams();
  const [period, setPeriod] = useState<Period>('today');
  // Custom range — initialized to "last 7 days" so the picker has sensible defaults.
  const initEnd = new Date(); initEnd.setHours(0, 0, 0, 0);
  const initStart = new Date(initEnd); initStart.setDate(initEnd.getDate() - 6);
  const [customStart, setCustomStart] = useState<string>(localYmd(initStart));
  const [customEnd, setCustomEnd] = useState<string>(localYmd(initEnd));
  const requestedTab = (searchParams.get('tab') || '').toLowerCase();
  const initialTab: Tab = (VALID_TABS as string[]).includes(requestedTab) ? (requestedTab as Tab) : 'overview';
  const [tab, setTabState] = useState<Tab>(initialTab);
  const setTab = (next: Tab) => {
    setTabState(next);
    const params = new URLSearchParams(searchParams);
    if (next === 'overview') params.delete('tab');
    else params.set('tab', next);
    setSearchParams(params, { replace: true });
  };
  const [salesData, setSalesData] = useState<SalesReport | null>(null);
  const [itemSales, setItemSales] = useState<ItemSalesReport | null>(null);
  const [employeePerf, setEmployeePerf] = useState<EmployeePerformanceReport[]>([]);
  const [hourlyData, setHourlyData] = useState<HourlyReport[]>([]);
  const [cashCard, setCashCard] = useState<CashCardBreakdown | null>(null);
  const [cogsData, setCogsData] = useState<COGSReport | null>(null);
  const [categoryData, setCategoryData] = useState<CategoryMargins | null>(null);
  const [marginData, setMarginData] = useState<ContributionMarginReport | null>(null);
  const [deliveryData, setDeliveryData] = useState<any>(null);
  const [channelData, setChannelData] = useState<any>(null);
  const [feesData, setFeesData] = useState<PaymentFeeSummary | null>(null);
  const [refundData, setRefundData] = useState<RefundSummary | null>(null);
  const [financialData, setFinancialData] = useState<FinancialProjection | null>(null);
  const [engineeringData, setEngineeringData] = useState<MenuEngineeringReport | null>(null);
  const [financialMonth, setFinancialMonth] = useState(() => todayInTz(tenantTz).slice(0, 7));
  const [itemSalesFilters, setItemSalesFilters] = useState({
    customerId: 'all' as number | 'all',
    hour: 'all' as number | 'all',
    minQuantity: 0,
    relatedItemId: 'all' as number | 'all',
  });
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canEditFinancials = !!(currentEmployee && ['admin', 'manager'].includes(currentEmployee.role) && limits.reports.editVariables);

  useEffect(() => {
    // Refetch when the custom range edits stabilize. Guard against partial
    // dates so we don't spam requests while the user is typing.
    if (period === 'custom' && (!customStart || !customEnd || customStart > customEnd)) return;
    fetchReportData();
  }, [period, tab, financialMonth, itemSalesFilters, customStart, customEnd]);

  const fetchReportData = async () => {
    if (tab === 'payroll' || tab === 'breakeven') {
      // PayrollTab and BreakEvenTab manage their own data loading.
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      setError(null);

      const opts = rangeOpts(period);
      if (tab === 'overview') {
        const [sales, itemSalesData, perf, hourly] = await Promise.all([
          getSalesReport(period, opts),
          getItemSalesReport(period, itemSalesFilters, opts),
          getEmployeePerformance(period, opts),
          getHourlyReport(),
        ]);
        setSalesData(sales);
        setItemSales(itemSalesData);
        setEmployeePerf(perf);
        setHourlyData(hourly);
      } else if (tab === 'cashcard') {
        const data = await getCashCardBreakdown(period, opts);
        setCashCard(data);
      } else if (tab === 'cogs') {
        const data = await getCOGSReport(period, opts);
        setCogsData(data);
      } else if (tab === 'categories') {
        const data = await getCategoryMargins(period, opts);
        setCategoryData(data);
      } else if (tab === 'margin') {
        const data = await getContributionMargin(period, opts);
        setMarginData(data);
      } else if (tab === 'delivery') {
        const [del, chan] = await Promise.all([
          getDeliveryMargins(period, opts),
          getChannelComparison(period, opts),
        ]);
        setDeliveryData(del);
        setChannelData(chan);
      } else if (tab === 'fees') {
        const data = await getPaymentFees(period, opts);
        setFeesData(data);
      } else if (tab === 'refunds') {
        const data = await getRefundSummary(opts.start_date, opts.end_date);
        setRefundData(data);
      } else if (tab === 'engineering') {
        const data = await getMenuEngineering(period, opts);
        setEngineeringData(data);
      } else if (tab === 'financials') {
        const data = await getFinancialProjection(financialMonth);
        setFinancialData(data);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.fetchReports'));
    } finally {
      setLoading(false);
    }
  };

  // Escape a single value for CSV (RFC 4180): wrap in quotes, double-up inner quotes.
  const csvCell = (v: unknown): string => {
    const s = v == null ? '' : String(v);
    return `"${s.replace(/"/g, '""')}"`;
  };
  const csvRow = (cells: unknown[]): string => cells.map(csvCell).join(',');

  // Multi-section CSV: pulls every report relevant for reconciliation
  // (summary, per-day, per-payment-method, per-category, per-item, per-employee)
  // regardless of which tab is currently active. Each section is preceded by a
  // == Section == marker so spreadsheets can be split by hand if needed.
  const generateCSV = async () => {
    setExporting(true);
    setError(null);
    try {
      const opts = rangeOpts(period);
      const [sales, items, employees, cashCardData, dailySeries] = await Promise.all([
        getSalesReport(period, opts),
        getItemSalesReport(period, {}, opts),
        getEmployeePerformance(period, opts),
        getCashCardBreakdown(period, opts).catch(() => null),
        getContributionMargin(period, opts).catch(() => null),
      ]);

      const lines: string[] = [];
      const push = (...rows: string[]) => lines.push(...rows);
      const blank = () => lines.push('');

      // -- Resumen --
      push(`== ${t('sales.csv.sectionSummary')} ==`);
      push(csvRow([t('sales.csvHeaders.metric'), t('sales.csvHeaders.value')]));
      push(csvRow([t('sales.csvHeaders.period'), `${getPeriodLabel(period)} (${getDateRangeLabel(period)})`]));
      push(csvRow([t('sales.csvHeaders.netSales'), sales.total_revenue ?? 0]));
      push(csvRow([t('sales.csvHeaders.iva'), sales.tax_total ?? 0]));
      push(csvRow([t('sales.csvHeaders.orderCount'), sales.order_count ?? 0]));
      push(csvRow([t('sales.csvHeaders.avgTicket'), sales.avg_ticket ?? 0]));
      push(csvRow([t('sales.csvHeaders.totalTips'), sales.tip_total ?? 0]));

      // -- Por día --
      if (dailySeries && dailySeries.data.length > 0) {
        blank();
        push(`== ${t('sales.csv.sectionDaily')} ==`);
        push(csvRow([
          t('sales.csv.colDate'),
          t('sales.csv.colOrders'),
          t('sales.csv.colRevenue'),
        ]));
        for (const d of dailySeries.data) {
          push(csvRow([d.date, d.orders, d.revenue]));
        }
      }

      // -- Por método de pago --
      if (cashCardData && cashCardData.breakdown.length > 0) {
        blank();
        push(`== ${t('sales.csv.sectionPaymentMethod')} ==`);
        push(csvRow([
          t('sales.csv.colMethod'),
          t('sales.csv.colOrders'),
          t('sales.csv.colTotal'),
          t('sales.csv.colTips'),
          t('sales.csv.colPctOrders'),
          t('sales.csv.colPctRevenue'),
        ]));
        for (const b of cashCardData.breakdown) {
          push(csvRow([
            b.display_name || b.payment_source || b.payment_method,
            b.count,
            b.total,
            b.tips,
            `${b.percentage}%`,
            `${b.revenue_percentage}%`,
          ]));
        }
      }

      // -- Por categoría --
      if (items.categories.length > 0) {
        blank();
        push(`== ${t('sales.csv.sectionCategory')} ==`);
        push(csvRow([
          t('sales.csv.colCategory'),
          t('sales.csv.colQty'),
          t('sales.csv.colRevenue'),
          t('sales.csv.colItemMix'),
        ]));
        for (const c of items.categories) {
          push(csvRow([
            c.category_name,
            c.quantity_sold,
            c.revenue,
            `${c.item_mix_percent}%`,
          ]));
        }
      }

      // -- Por artículo --
      if (items.items.length > 0) {
        blank();
        push(`== ${t('sales.csv.sectionItem')} ==`);
        push(csvRow([
          t('sales.csv.colCategory'),
          t('sales.csv.colItem'),
          t('sales.csv.colQty'),
          t('sales.csv.colOrders'),
          t('sales.csv.colRevenue'),
          t('sales.csv.colAvgPrice'),
          t('sales.csv.colItemMix'),
        ]));
        for (const it of items.items) {
          push(csvRow([
            it.category_name,
            it.item_name,
            it.quantity_sold,
            it.orders_count,
            it.revenue,
            it.avg_unit_price,
            `${it.item_mix_percent}%`,
          ]));
        }
      }

      // -- Por empleado --
      const empWithSales = employees.filter(e => (e.orders_processed || 0) > 0);
      if (empWithSales.length > 0) {
        blank();
        push(`== ${t('sales.csv.sectionEmployee')} ==`);
        push(csvRow([
          t('sales.csv.colEmployee'),
          t('sales.csv.colOrders'),
          t('sales.csv.colSales'),
          t('sales.csv.colAvgTicket'),
          t('sales.csv.colTips'),
        ]));
        for (const e of empWithSales) {
          push(csvRow([
            e.employee_name,
            e.orders_processed,
            e.total_sales,
            e.avg_ticket,
            e.tips_received,
          ]));
        }
      }

      const { start, end } = getPeriodRange(period);
      const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const rangeSlug = iso(start) === iso(end) ? iso(start) : `${iso(start)}_${iso(end)}`;
      const filename = `sales-report-${period}-${rangeSlug}.csv`;

      // BOM + CRLF so Excel opens it with UTF-8 and respects sections cleanly.
      const csv = '\uFEFF' + lines.join('\r\n') + '\r\n';
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.fetchReports'));
    } finally {
      setExporting(false);
    }
  };

  const getPeriodLabel = (p: Period) => {
    switch (p) {
      case 'today': return t('sales.periods.today');
      case 'week': return t('sales.periods.week');
      case 'month': return t('sales.periods.month');
      case 'yesterday': return t('sales.periods.yesterday');
      case 'last_week': return t('sales.periods.lastWeek');
      case 'last_month': return t('sales.periods.lastMonth');
      case 'custom': return t('sales.periods.custom');
    }
  };

  // Returns { start, end } as local-midnight Dates for label rendering.
  // Mirrors the backend getPeriodRange so the label matches the data.
  // Week anchor follows weekStartDow from PlanContext (mirror of
  // payroll_settings.period_start_dow). Defaults to Monday.
  const getPeriodRange = (p: Period): { start: Date; end: Date } => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    const daysBack = ((end.getDay() - weekStartDow + 7) % 7);
    switch (p) {
      case 'today':
        return { start, end };
      case 'yesterday': {
        start.setDate(start.getDate() - 1);
        end.setDate(end.getDate() - 1);
        return { start, end };
      }
      case 'week':
        start.setDate(start.getDate() - daysBack);
        return { start, end };
      case 'last_week': {
        const thisWeekStart = new Date(end);
        thisWeekStart.setDate(end.getDate() - daysBack);
        const lastEnd = new Date(thisWeekStart);
        lastEnd.setDate(thisWeekStart.getDate() - 1);
        const lastStart = new Date(lastEnd);
        lastStart.setDate(lastEnd.getDate() - 6);
        return { start: lastStart, end: lastEnd };
      }
      case 'month':
        start.setDate(1);
        return { start, end };
      case 'last_month': {
        const lastEnd = new Date(end.getFullYear(), end.getMonth(), 0);
        const lastStart = new Date(lastEnd.getFullYear(), lastEnd.getMonth(), 1);
        return { start: lastStart, end: lastEnd };
      }
      case 'custom': {
        const [sy, sm, sd] = customStart.split('-').map(Number);
        const [ey, em, ed] = customEnd.split('-').map(Number);
        return {
          start: new Date(sy, sm - 1, sd),
          end: new Date(ey, em - 1, ed),
        };
      }
    }
  };

  const getPeriodStart = (p: Period): Date => getPeriodRange(p).start;

  // Pack the date range into ReportRangeOpts for every backend call.
  // Always send explicit dates so the server treats the frontend's choice
  // (dow, custom picker) as authoritative.
  const rangeOpts = (p: Period) => {
    const { start, end } = getPeriodRange(p);
    return {
      start_date: localYmd(start),
      end_date: localYmd(end),
      week_start_dow: weekStartDow,
    };
  };

  const getDateRangeLabel = (p: Period): string => {
    const { start, end } = getPeriodRange(p);
    const sameDay = localYmd(start) === localYmd(end);
    if (p === 'today' || p === 'yesterday' || sameDay) {
      return formatDate(start, { year: 'numeric', month: 'short', day: 'numeric' });
    }
    const sameYear = start.getFullYear() === end.getFullYear();
    const startStr = formatDate(start, sameYear
      ? { month: 'short', day: 'numeric' }
      : { year: 'numeric', month: 'short', day: 'numeric' });
    const endStr = formatDate(end, { year: 'numeric', month: 'short', day: 'numeric' });
    return `${startStr} – ${endStr}`;
  };

  const canSeePayroll = !!(currentEmployee && (
    currentEmployee.role === 'admin' ||
    currentEmployee.permissions?.includes('manage_payroll')
  ));

  const tabs: { key: Tab; label: string }[] = [
    { key: 'overview', label: t('sales.tabs.overview') },
    { key: 'cashcard', label: t('sales.tabs.cashCard') },
    { key: 'cogs', label: t('sales.tabs.cogs') },
    { key: 'categories', label: t('sales.tabs.categories') },
    { key: 'margin', label: t('sales.tabs.margin') },
    { key: 'delivery', label: t('sales.tabs.delivery') },
    { key: 'fees', label: t('sales.tabs.fees') },
    { key: 'refunds', label: t('sales.tabs.refunds') },
    { key: 'engineering', label: '⭐ ' + t('sales.tabs.menuEngineering') },
    { key: 'financials', label: t('sales.tabs.financials') },
    { key: 'breakeven', label: '⭐ ' + t('sales.tabs.breakeven') },
    ...(canSeePayroll ? [{ key: 'payroll' as Tab, label: t('sales.tabs.payroll') }] : []),
  ];

  return (
    <div className="min-h-screen bg-neutral-950">
      <div className="bg-neutral-900 text-white p-6 border-b border-neutral-800">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link to="/admin" className="p-2 hover:bg-neutral-800 rounded-lg transition-colors">
              <ArrowLeft size={24} />
            </Link>
            <h1 className="text-3xl font-black tracking-tighter">{t('sales.title')}</h1>
          </div>
          <div className="flex items-center gap-4">
            <button
              onClick={generateCSV}
              disabled={exporting}
              className="px-6 py-3 bg-brand-600 text-white rounded-lg font-medium hover:bg-brand-700 transition-colors flex items-center gap-2 min-h-[44px] disabled:opacity-60 disabled:cursor-wait"
            >
              <Download size={20} />
              {exporting ? t('sales.exporting') : t('sales.exportCsv')}
            </button>
            <BrandLogo className="h-10" />
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto p-6">
        {error && (
          <div className="bg-brand-900/30 border border-brand-800 rounded-lg p-4 mb-6 flex justify-between items-center">
            <p className="text-brand-300">{error}</p>
            <button onClick={() => setError(null)} className="text-brand-400 hover:text-brand-300">
              <X size={20} />
            </button>
          </div>
        )}

        {historyLimited && isFree && (
          <div className="bg-amber-900/20 border border-amber-800/50 rounded-lg px-4 py-3 mb-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-amber-300 text-sm">{t('sales.freeHistoryNotice', { days: limits.reportsHistoryDays })}</p>
            <Link to="/account" className="text-amber-200 text-sm font-bold underline underline-offset-2 hover:text-amber-100">
              {t('sales.upgradeCta')}
            </Link>
          </div>
        )}

        {/* Period Selector */}
        <div className="flex flex-wrap gap-2 mb-2">
          {(['today', 'yesterday', 'week', 'last_week', 'month', 'last_month', 'custom'] as const).map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`px-5 py-3 rounded-lg font-medium transition-colors min-h-[44px] ${
                period === p
                  ? 'bg-brand-600 text-white'
                  : 'bg-neutral-900 text-neutral-300 border border-neutral-800 hover:bg-neutral-800'
              }`}
            >
              {getPeriodLabel(p)}
            </button>
          ))}
        </div>
        {period === 'custom' && (
          <div className="flex flex-wrap items-end gap-3 mb-2 p-3 rounded-lg bg-neutral-900 border border-neutral-800">
            <label className="flex flex-col text-xs text-neutral-400">
              <span className="mb-1">{t('sales.customRange.from')}</span>
              <input
                type="date"
                value={customStart}
                max={customEnd || undefined}
                onChange={e => setCustomStart(e.target.value)}
                className="px-3 py-2 rounded-md bg-neutral-800 text-white border border-neutral-700 min-h-[40px]"
              />
            </label>
            <label className="flex flex-col text-xs text-neutral-400">
              <span className="mb-1">{t('sales.customRange.to')}</span>
              <input
                type="date"
                value={customEnd}
                min={customStart || undefined}
                onChange={e => setCustomEnd(e.target.value)}
                className="px-3 py-2 rounded-md bg-neutral-800 text-white border border-neutral-700 min-h-[40px]"
              />
            </label>
            {customStart && customEnd && customStart > customEnd && (
              <span className="text-xs text-cockpit-out-text">{t('sales.customRange.invalid')}</span>
            )}
          </div>
        )}
        <div className="text-sm text-neutral-400 mb-4" aria-live="polite">
          {getDateRangeLabel(period)}
        </div>

        {/* Tab Selector */}
        <div className="flex gap-2 mb-6 overflow-x-auto">
          {tabs.map((tabItem) => (
            <button
              key={tabItem.key}
              onClick={() => setTab(tabItem.key)}
              className={`px-4 py-2 rounded-lg font-medium text-sm transition-colors whitespace-nowrap ${
                tab === tabItem.key
                  ? 'bg-neutral-700 text-white'
                  : 'bg-neutral-900 text-neutral-400 hover:bg-neutral-800'
              }`}
            >
              {tabItem.label}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="space-y-6">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="h-64 bg-neutral-900 rounded-lg border border-neutral-800 animate-pulse" />
            ))}
          </div>
        ) : (
          <>
            {tab === 'overview' && (
              <OverviewTab
                salesData={salesData}
                itemSales={itemSales}
                employeePerf={employeePerf}
                hourlyData={hourlyData}
                itemSalesFilters={itemSalesFilters}
                onItemSalesFiltersChange={setItemSalesFilters}
              />
            )}
            {tab === 'cashcard' && cashCard && (
              <CashCardTab cashCard={cashCard} />
            )}
            {tab === 'cogs' && cogsData && (
              <COGSTab cogsData={cogsData} />
            )}
            {tab === 'categories' && categoryData && (
              <CategoriesTab categoryData={categoryData} />
            )}
            {tab === 'margin' && marginData && (
              <MarginTab marginData={marginData} />
            )}
            {tab === 'delivery' && (
              <DeliveryTab deliveryData={deliveryData} channelData={channelData} />
            )}
            {tab === 'fees' && feesData && (
              <FeesTab feesData={feesData} />
            )}
            {tab === 'refunds' && refundData && (
              <RefundsTab refundData={refundData} />
            )}
            {tab === 'engineering' && engineeringData && (
              <MenuEngineeringTab data={engineeringData} />
            )}
            {tab === 'financials' && (
              <FinancialsTab
                financialData={financialData}
                financialMonth={financialMonth}
                canEditFinancials={canEditFinancials}
                loading={loading}
                onMonthChange={setFinancialMonth}
                onRefresh={fetchReportData}
                onError={setError}
              />
            )}
            {tab === 'payroll' && canSeePayroll && <PayrollTab />}
            {tab === 'breakeven' && <BreakEvenTab />}
          </>
        )}
      </div>
    </div>
  );
}
