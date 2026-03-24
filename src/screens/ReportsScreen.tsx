import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Download, X } from 'lucide-react';
import {
  getSalesReport,
  getTopItems,
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
import BrandLogo from '../components/BrandLogo';
import { usePlan } from '../context/PlanContext';
import {
  SalesReport,
  TopItemsReport,
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

type Period = 'today' | 'week' | 'month';
type Tab = 'overview' | 'cashcard' | 'cogs' | 'categories' | 'margin' | 'delivery' | 'fees' | 'refunds' | 'financials' | 'engineering';

export default function ReportsScreen() {
  const { t } = useTranslation('reports');
  const { currentEmployee } = useAuth();
  const { limits } = usePlan();
  const [period, setPeriod] = useState<Period>('today');
  const [tab, setTab] = useState<Tab>('overview');
  const [salesData, setSalesData] = useState<SalesReport | null>(null);
  const [topItems, setTopItems] = useState<TopItemsReport[]>([]);
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
  const [financialMonth, setFinancialMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const canEditFinancials = !!(currentEmployee && ['admin', 'manager'].includes(currentEmployee.role) && limits.reports.editVariables);

  useEffect(() => {
    fetchReportData();
  }, [period, tab, financialMonth]);

  const fetchReportData = async () => {
    try {
      setLoading(true);
      setError(null);

      if (tab === 'overview') {
        const [sales, items, perf, hourly] = await Promise.all([
          getSalesReport(period),
          getTopItems(period, 10),
          getEmployeePerformance(period),
          getHourlyReport(),
        ]);
        setSalesData(sales);
        setTopItems(items);
        setEmployeePerf(perf);
        setHourlyData(hourly);
      } else if (tab === 'cashcard') {
        const data = await getCashCardBreakdown(period);
        setCashCard(data);
      } else if (tab === 'cogs') {
        const data = await getCOGSReport(period);
        setCogsData(data);
      } else if (tab === 'categories') {
        const data = await getCategoryMargins(period);
        setCategoryData(data);
      } else if (tab === 'margin') {
        const data = await getContributionMargin(period);
        setMarginData(data);
      } else if (tab === 'delivery') {
        const [del, chan] = await Promise.all([
          getDeliveryMargins(period),
          getChannelComparison(period),
        ]);
        setDeliveryData(del);
        setChannelData(chan);
      } else if (tab === 'fees') {
        const data = await getPaymentFees(period);
        setFeesData(data);
      } else if (tab === 'refunds') {
        const data = await getRefundSummary();
        setRefundData(data);
      } else if (tab === 'engineering') {
        const data = await getMenuEngineering(period);
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

  const generateCSV = () => {
    const headers = [t('sales.csvHeaders.metric'), t('sales.csvHeaders.value')];
    const rows = [
      [t('sales.csvHeaders.period'), period],
      [t('sales.csvHeaders.totalRevenue'), salesData?.total_revenue || 0],
      [t('sales.csvHeaders.orderCount'), salesData?.order_count || 0],
      [t('sales.csvHeaders.avgTicket'), salesData?.avg_ticket || 0],
      [t('sales.csvHeaders.totalTips'), salesData?.tip_total || 0],
    ];

    let csv = headers.join(',') + '\n';
    rows.forEach((row) => {
      csv += row.map((cell) => `"${cell}"`).join(',') + '\n';
    });

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sales-report-${period}-${new Date().toISOString().split('T')[0]}.csv`;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);
  };

  const getPeriodLabel = (p: Period) => {
    switch (p) {
      case 'today': return t('sales.periods.today');
      case 'week': return t('sales.periods.week');
      case 'month': return t('sales.periods.month');
    }
  };

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
              className="px-6 py-3 bg-brand-600 text-white rounded-lg font-medium hover:bg-brand-700 transition-colors flex items-center gap-2 min-h-[44px]"
            >
              <Download size={20} />
              {t('sales.exportCsv')}
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

        {/* Period Selector */}
        <div className="flex gap-3 mb-4">
          {(['today', 'week', 'month'] as const).map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`px-6 py-3 rounded-lg font-medium transition-colors min-h-[44px] ${
                period === p
                  ? 'bg-brand-600 text-white'
                  : 'bg-neutral-900 text-neutral-300 border border-neutral-800 hover:bg-neutral-800'
              }`}
            >
              {getPeriodLabel(p)}
            </button>
          ))}
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
              <OverviewTab salesData={salesData} topItems={topItems} employeePerf={employeePerf} hourlyData={hourlyData} />
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
          </>
        )}
      </div>
    </div>
  );
}
