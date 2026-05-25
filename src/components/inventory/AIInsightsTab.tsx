import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  ClipboardList,
  BarChart3,
  CheckCircle,
  Trash2,
  TrendingUp,
  TrendingDown,
  Brain,
  ChevronDown,
  ChevronRight,
  Sparkles,
  Lock,
} from 'lucide-react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts';
import { InventoryInsights } from '../../types';
import { CHART_PALETTE_10 as VELOCITY_COLORS } from '../../utils/chartPalette';

interface AIInsightsTabProps {
  limits: { ai: { mode: string } };
  insights: InventoryInsights | null;
  insightsLoading: boolean;
  expandedRisk: Record<string, boolean>;
  onExpandedRiskChange: (expanded: Record<string, boolean>) => void;
}

export default function AIInsightsTab({
  limits,
  insights,
  insightsLoading,
  expandedRisk,
  onExpandedRiskChange,
}: AIInsightsTabProps) {
  const { t } = useTranslation('inventory');

  const velocityChartData = useMemo(() => {
    if (!insights?.velocityChart?.length) return [];
    const dateSet = new Set<string>();
    for (const item of insights.velocityChart) {
      for (const d of item.daily) dateSet.add(d.date);
    }
    const dates = Array.from(dateSet).sort();
    return dates.map(date => {
      const row: Record<string, unknown> = { date: date.slice(5) };
      for (const item of insights.velocityChart) {
        const dayData = item.daily.find(d => d.date === date);
        row[item.name] = dayData?.quantity_used || 0;
      }
      return row;
    });
  }, [insights?.velocityChart]);

  if (limits.ai.mode === 'none') {
    return (
      <div className="bg-neutral-900 p-12 rounded-lg border border-neutral-800 text-center">
        <Lock className="mx-auto text-neutral-600 mb-4" size={48} />
        <h3 className="text-xl font-bold text-white mb-2">{t('insights.upgradeTitle')}</h3>
        <p className="text-neutral-400 max-w-md mx-auto">{t('insights.upgradeMessage')}</p>
      </div>
    );
  }

  if (insightsLoading) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-28 bg-neutral-800 rounded-lg animate-pulse"></div>
          ))}
        </div>
        <div className="h-72 bg-neutral-800 rounded-lg animate-pulse"></div>
        <div className="h-48 bg-neutral-800 rounded-lg animate-pulse"></div>
      </div>
    );
  }

  if (!insights) {
    return (
      <div className="bg-neutral-900 p-12 rounded-lg border border-neutral-800 text-center">
        <Brain className="mx-auto text-neutral-600 mb-4" size={48} />
        <p className="text-neutral-400">{t('insights.empty')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* KPI Dashboard Header */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-neutral-900 p-5 rounded-lg border border-neutral-800">
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle className="text-cockpit-red" size={18} />
            <p className="text-neutral-400 text-sm">{t('insights.kpis.itemsAtRisk')}</p>
          </div>
          <p className="text-3xl font-bold text-cockpit-red">{insights.kpis.itemsAtRisk}</p>
          <p className="text-neutral-500 text-xs mt-1">
            {t('insights.kpis.criticalAndHigh', { critical: insights.kpis.criticalCount, high: insights.kpis.highCount })}
          </p>
        </div>

        <div className="bg-neutral-900 p-5 rounded-lg border border-neutral-800">
          <div className="flex items-center gap-2 mb-2">
            <ClipboardList className="text-cockpit-yellow" size={18} />
            <p className="text-neutral-400 text-sm">{t('insights.kpis.prepActions')}</p>
          </div>
          <p className="text-3xl font-bold text-cockpit-yellow">{insights.kpis.prepActionsNeeded}</p>
          <p className="text-neutral-500 text-xs mt-1">{t('insights.kpis.actionsNeeded')}</p>
        </div>

        <div className="bg-neutral-900 p-5 rounded-lg border border-neutral-800">
          <div className="flex items-center gap-2 mb-2">
            {insights.kpis.wasteTrendPercent <= 0
              ? <TrendingDown className="text-cockpit-green" size={18} />
              : <TrendingUp className="text-cockpit-red" size={18} />
            }
            <p className="text-neutral-400 text-sm">{t('insights.kpis.wasteTrend')}</p>
          </div>
          <p className={`text-3xl font-bold ${insights.kpis.wasteTrendPercent <= 0 ? 'text-cockpit-green' : 'text-cockpit-red'}`}>
            {insights.kpis.wasteTrendPercent > 0 ? '+' : ''}{insights.kpis.wasteTrendPercent}%
          </p>
          <p className="text-neutral-500 text-xs mt-1">{t('insights.kpis.vsLastPeriod')}</p>
        </div>

        <div className="bg-neutral-900 p-5 rounded-lg border border-neutral-800">
          <div className="flex items-center gap-2 mb-2">
            <Brain className="text-brand-400" size={18} />
            <p className="text-neutral-400 text-sm">{t('insights.kpis.acceptanceRate')}</p>
          </div>
          <p className="text-3xl font-bold text-brand-400">{insights.kpis.acceptanceRate}%</p>
          <p className="text-neutral-500 text-xs mt-1">{t('insights.kpis.ofSuggestions')}</p>
        </div>
      </div>

      {/* Consumption Velocity Chart */}
      <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
        <div className="flex items-center gap-2 mb-1">
          <TrendingUp className="text-brand-500" size={20} />
          <h3 className="font-semibold text-white">{t('insights.velocity.title')}</h3>
        </div>
        <p className="text-neutral-500 text-xs mb-4">{t('insights.velocity.subtitle')}</p>
        {velocityChartData.length > 0 ? (
          <ResponsiveContainer width="100%" height={320}>
            <LineChart data={velocityChartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#333" />
              <XAxis dataKey="date" stroke="#666" tick={{ fill: '#999', fontSize: 12 }} />
              <YAxis stroke="#666" tick={{ fill: '#999', fontSize: 12 }} />
              <Tooltip
                contentStyle={{ backgroundColor: '#1a1a1a', border: '1px solid #333', borderRadius: 8 }}
                labelStyle={{ color: '#ccc' }}
                itemStyle={{ color: '#ccc' }}
              />
              <Legend wrapperStyle={{ color: '#999', fontSize: 12 }} />
              {insights.velocityChart.map((item, idx) => (
                <Line
                  key={item.inventory_item_id}
                  type="monotone"
                  dataKey={item.name}
                  stroke={VELOCITY_COLORS[idx % VELOCITY_COLORS.length]}
                  strokeWidth={2}
                  dot={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <div className="text-center py-12">
            <BarChart3 className="mx-auto text-neutral-600 mb-3" size={40} />
            <p className="text-neutral-400">{t('insights.velocity.noData')}</p>
          </div>
        )}
      </div>

      {/* Smart Reorder Recommendations */}
      <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
        <div className="flex items-center gap-2 mb-4">
          <Sparkles className="text-brand-500" size={20} />
          <h3 className="font-semibold text-white">{t('insights.reorder.title')}</h3>
        </div>
        {insights.forecasts.length === 0 ? (
          <div className="text-center py-8">
            <CheckCircle className="mx-auto text-cockpit-green mb-3" size={40} />
            <p className="text-neutral-400">{t('insights.reorder.noData')}</p>
          </div>
        ) : (
          <div className="space-y-3">
            {(['critical', 'high', 'medium', 'low'] as const).map((level) => {
              const levelItems = insights.forecasts.filter(f => f.risk_level === level);
              if (levelItems.length === 0) return null;
              const isExpanded = expandedRisk[level];
              return (
                <div key={level}>
                  <button
                    onClick={() => onExpandedRiskChange({ ...expandedRisk, [level]: !expandedRisk[level] })}
                    className="flex items-center gap-2 w-full text-left py-2"
                  >
                    {isExpanded ? <ChevronDown size={16} className="text-neutral-400" /> : <ChevronRight size={16} className="text-neutral-400" />}
                    <span className={`px-2 py-0.5 rounded text-xs font-bold uppercase ${
                      level === 'critical' ? 'bg-cockpit-red/30 text-cockpit-red' :
                      level === 'high' ? 'bg-cockpit-yellow/30 text-cockpit-yellow' :
                      level === 'medium' ? 'bg-cockpit-yellow/30 text-cockpit-yellow' :
                      'bg-cockpit-green/30 text-cockpit-green'
                    }`}>
                      {level}
                    </span>
                    <span className="text-neutral-500 text-sm">{t('insights.reorder.items', { count: levelItems.length })}</span>
                  </button>
                  {isExpanded && (
                    <div className="space-y-2 ml-6">
                      {levelItems.map((f) => (
                        <div key={f.inventory_item_id} className="flex items-center justify-between p-3 bg-neutral-800 rounded-lg">
                          <div>
                            <p className="text-white font-medium">{f.name}</p>
                            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1">
                              <span className="text-neutral-500 text-xs">
                                {t('insights.reorder.currentStock', { qty: f.current_quantity, unit: f.unit })}
                              </span>
                              {f.avg_daily_usage > 0 && (
                                <span className="text-neutral-500 text-xs">
                                  {t('insights.reorder.avgDaily', { usage: f.avg_daily_usage.toFixed(1), unit: f.unit })}
                                </span>
                              )}
                              {f.days_until_stockout != null && (
                                <span className="text-neutral-500 text-xs">
                                  {t('insights.reorder.daysUntilStockout', { days: f.days_until_stockout })}
                                </span>
                              )}
                            </div>
                          </div>
                          {f.suggested_reorder_qty && (
                            <span className="text-brand-400 text-sm font-medium whitespace-nowrap ml-4">
                              {t('insights.reorder.suggestedReorder', { qty: f.suggested_reorder_qty, unit: f.unit })}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Prep Forecast */}
      {insights.prepForecast && (
        <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
          <div className="flex items-center justify-between mb-4">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <ClipboardList className="text-brand-500" size={20} />
                <h3 className="font-semibold text-white">{t('insights.prep.title')}</h3>
              </div>
              <p className="text-neutral-500 text-xs">
                {t('insights.prep.subtitle')} {insights.prepForecast.target_date} ({insights.prepForecast.day_of_week})
                {' — '}{t('insights.prep.estOrders', { count: insights.prepForecast.estimated_orders })}
              </p>
            </div>
          </div>
          {(() => {
            const actionItems = insights.prepForecast.items?.filter(i => i.prep_action !== 'sufficient') || [];
            if (actionItems.length === 0) {
              return (
                <div className="text-center py-8">
                  <CheckCircle className="mx-auto text-cockpit-green mb-3" size={32} />
                  <p className="text-neutral-400">{t('insights.prep.noActions')}</p>
                </div>
              );
            }
            return (
              <div className="space-y-2">
                {actionItems.map((item) => (
                  <div key={item.inventory_item_id} className="flex items-center justify-between p-3 bg-neutral-800 rounded-lg">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <p className="text-white font-medium">{item.item_name}</p>
                        <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                          item.prep_action === 'restock_needed' ? 'bg-cockpit-red/30 text-cockpit-red' : 'bg-cockpit-yellow/30 text-cockpit-yellow'
                        }`}>
                          {item.prep_action === 'restock_needed' ? t('insights.prep.restockNeeded') : t('insights.prep.prepExtra')}
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1">
                        <span className="text-neutral-500 text-xs">
                          {t('insights.prep.deficit', { qty: Math.abs(item.deficit).toFixed(1), unit: item.unit })}
                        </span>
                        {item.menu_items_using?.length > 0 && (
                          <span className="text-neutral-500 text-xs">
                            {t('insights.prep.usedBy', { items: item.menu_items_using.map(m => m.menu_item_name).join(', ') })}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            );
          })()}
        </div>
      )}

      {/* Waste Intelligence */}
      <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
        <div className="flex items-center gap-2 mb-1">
          <Trash2 className="text-cockpit-red" size={20} />
          <h3 className="font-semibold text-white">{t('insights.waste.title')}</h3>
        </div>
        <p className="text-neutral-500 text-xs mb-4">{t('insights.waste.chartTitle')}</p>
        {insights.wasteDailyTrend.length > 0 ? (
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={insights.wasteDailyTrend.map(d => ({ ...d, date: d.date.slice(5) }))}>
              <CartesianGrid strokeDasharray="3 3" stroke="#333" />
              <XAxis dataKey="date" stroke="#666" tick={{ fill: '#999', fontSize: 12 }} />
              <YAxis stroke="#666" tick={{ fill: '#999', fontSize: 12 }} />
              <Tooltip
                contentStyle={{ backgroundColor: '#1a1a1a', border: '1px solid #333', borderRadius: 8 }}
                labelStyle={{ color: '#ccc' }}
                formatter={(value: number) => [`$${value.toFixed(2)}`, 'Cost']}
              />
              <Bar dataKey="total_cost" fill="#C94B1B" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <div className="text-center py-8 mb-4">
            <Trash2 className="mx-auto text-neutral-600 mb-3" size={32} />
            <p className="text-neutral-400">{t('insights.waste.noChartData')}</p>
          </div>
        )}

        {insights.wasteAlerts.length > 0 && (
          <div className="mt-6">
            <h4 className="text-white font-semibold mb-3">{t('insights.waste.alertsTitle')}</h4>
            <div className="space-y-2">
              {insights.wasteAlerts.map((alert, idx) => (
                <div key={idx} className="p-3 bg-neutral-800 rounded-lg border border-cockpit-red/30">
                  <p className="text-white font-medium">{alert.item_name || alert.message || 'Waste Alert'}</p>
                  <div className="flex flex-wrap gap-x-4 mt-1">
                    {alert.waste_rate != null && (
                      <span className="text-cockpit-red text-xs">{t('insights.waste.wasteRate', { rate: (alert.waste_rate * 100).toFixed(1) })}</span>
                    )}
                    {alert.top_reason && (
                      <span className="text-neutral-500 text-xs">{t('insights.waste.topReason', { reason: alert.top_reason })}</span>
                    )}
                    {alert.total_waste_cost != null && (
                      <span className="text-cockpit-red text-xs">{t('insights.waste.cost', { cost: alert.total_waste_cost.toFixed(2) })}</span>
                    )}
                  </div>
                  {alert.message && alert.item_name && (
                    <p className="text-neutral-500 text-xs mt-1">{alert.message}</p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
        {insights.wasteAlerts.length === 0 && insights.wasteDailyTrend.length > 0 && (
          <p className="text-neutral-500 text-sm mt-4">{t('insights.waste.noAlerts')}</p>
        )}
      </div>

      {/* Push/Avoid Items */}
      {(insights.pushItems.length > 0 || insights.avoidItems.length > 0) && (
        <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
          <div className="flex items-center gap-2 mb-4">
            <Sparkles className="text-brand-500" size={20} />
            <h3 className="font-semibold text-white">{t('insights.push.title')}</h3>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <h4 className="text-cockpit-green font-semibold text-sm mb-3">{t('insights.push.pushTitle')}</h4>
              {insights.pushItems.length > 0 ? (
                <div className="space-y-2">
                  {insights.pushItems.map((item) => (
                    <div key={item.menu_item_id} className="p-3 bg-cockpit-green/10 border border-cockpit-green/30 rounded-lg">
                      <p className="text-white font-medium">{item.name}</p>
                      <div className="flex flex-wrap gap-x-4 mt-1">
                        <span className="text-cockpit-green text-xs">{t('insights.push.reason', { reason: item.reason })}</span>
                        {item.ingredient_name && (
                          <span className="text-neutral-500 text-xs">{t('insights.push.ingredient', { name: item.ingredient_name })}</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-neutral-500 text-sm">{t('insights.push.noPush')}</p>
              )}
            </div>
            <div>
              <h4 className="text-cockpit-red font-semibold text-sm mb-3">{t('insights.push.avoidTitle')}</h4>
              {insights.avoidItems.length > 0 ? (
                <div className="space-y-2">
                  {insights.avoidItems.map((item) => (
                    <div key={item.menu_item_id} className="p-3 bg-cockpit-red/10 border border-cockpit-red/30 rounded-lg">
                      <p className="text-white font-medium">{item.name}</p>
                      <div className="flex flex-wrap gap-x-4 mt-1">
                        <span className="text-cockpit-red text-xs">{t('insights.push.reason', { reason: item.reason })}</span>
                        {item.ingredient_name && (
                          <span className="text-neutral-500 text-xs">{t('insights.push.ingredient', { name: item.ingredient_name })}</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-neutral-500 text-sm">{t('insights.push.noAvoid')}</p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
