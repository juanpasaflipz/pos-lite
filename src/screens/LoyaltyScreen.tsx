import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft, Heart, Users, BarChart3, Gift, Settings,
  Search, Plus, Phone, ChevronDown, ChevronUp,
} from 'lucide-react';
import {
  getLoyaltyCustomers,
  getLoyaltyCustomer,
  getLoyaltyAnalytics,
  getLoyaltyReferrals,
  getLoyaltyConfig,
  updateLoyaltyConfig as updateConfigAPI,
  addManualStamps,
} from '../api';
import { LoyaltyCustomer, LoyaltyAnalytics, LoyaltyConfig, StampCard } from '../types';
import { formatPrice } from '../utils/currency';
import { formatDate } from '../utils/dateFormat';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import FeatureGate from '../components/FeatureGate';

type Tab = 'customers' | 'analytics' | 'referrals' | 'settings';

export default function LoyaltyScreen() {
  const { t } = useTranslation('reports');
  const [activeTab, setActiveTab] = useState<Tab>('customers');

  const tabs: { key: Tab; label: string; icon: React.ReactNode }[] = [
    { key: 'customers', label: t('loyalty.tabs.customers'), icon: <Users size={18} /> },
    { key: 'analytics', label: t('loyalty.tabs.analytics'), icon: <BarChart3 size={18} /> },
    { key: 'referrals', label: t('loyalty.tabs.referrals'), icon: <Gift size={18} /> },
    { key: 'settings', label: t('loyalty.tabs.settings'), icon: <Settings size={18} /> },
  ];

  return (
    <FeatureGate feature="loyalty" featureLabel="Loyalty Program">
      <div className="min-h-screen bg-neutral-950">
        {/* Header */}
        <div className="bg-neutral-900 text-white p-6 border-b border-neutral-800">
          <div className="flex items-center gap-4">
            <Link to="/admin" className="p-2 hover:bg-neutral-800 rounded-lg transition-colors">
              <ArrowLeft size={24} />
            </Link>
            <Heart className="text-purple-500" size={28} />
            <h1 className="text-3xl font-black tracking-tighter">{t('loyalty.title')}</h1>
          </div>
        </div>

        {/* Tabs */}
        <div className="bg-neutral-900 border-b border-neutral-800 px-6">
          <div className="flex gap-1">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`flex items-center gap-2 px-5 py-3 font-semibold text-sm rounded-t-lg transition-colors ${
                  activeTab === tab.key
                    ? 'bg-neutral-950 text-purple-400 border-t-2 border-purple-500'
                    : 'text-neutral-400 hover:text-white hover:bg-neutral-800'
                }`}
              >
                {tab.icon}
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* Tab Content */}
        <div className="max-w-7xl mx-auto p-6">
          {activeTab === 'customers' && <CustomersTab />}
          {activeTab === 'analytics' && <AnalyticsTab />}
          {activeTab === 'referrals' && <ReferralsTab />}
          {activeTab === 'settings' && <SettingsTab />}
        </div>
      </div>
    </FeatureGate>
  );
}

/* ==================== Customers Tab ==================== */

function CustomersTab() {
  const { t } = useTranslation('reports');
  const [customers, setCustomers] = useState<LoyaltyCustomer[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [expandedDetail, setExpandedDetail] = useState<any>(null);

  const fetchCustomers = async (s?: string, p?: number) => {
    setLoading(true);
    try {
      const res = await getLoyaltyCustomers({ search: s || search, page: p || page, limit: 15 });
      setCustomers(res.data);
      setTotal(res.total);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchCustomers('', 1); }, []);

  const handleSearch = () => {
    setPage(1);
    fetchCustomers(search, 1);
  };

  const toggleExpand = async (id: number) => {
    if (expandedId === id) {
      setExpandedId(null);
      setExpandedDetail(null);
      return;
    }
    setExpandedId(id);
    try {
      const detail = await getLoyaltyCustomer(id);
      setExpandedDetail(detail);
    } catch {
      setExpandedDetail(null);
    }
  };

  const handleAddStamp = async (customerId: number) => {
    try {
      await addManualStamps(customerId, 1);
      fetchCustomers();
      if (expandedId === customerId) {
        const detail = await getLoyaltyCustomer(customerId);
        setExpandedDetail(detail);
      }
    } catch {
      // ignore
    }
  };

  const renderStampDots = (earned: number, required: number) => {
    const dots = [];
    for (let i = 0; i < required; i++) {
      dots.push(
        <div
          key={i}
          className={`w-4 h-4 rounded-full ${
            i < earned ? 'bg-purple-500' : 'bg-neutral-700'
          }`}
        />
      );
    }
    return <div className="flex gap-1">{dots}</div>;
  };

  return (
    <div className="space-y-4">
      {/* Search */}
      <div className="flex gap-3">
        <div className="flex-1 relative">
          <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            placeholder={t('loyalty.customers.searchPlaceholder')}
            className="w-full pl-10 pr-4 py-3 bg-neutral-900 border border-neutral-800 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:border-purple-600"
          />
        </div>
        <button onClick={handleSearch} className="px-6 py-3 bg-purple-600 text-white font-bold rounded-lg hover:bg-purple-700 transition-colors">
          {t('common:buttons.search')}
        </button>
      </div>

      {/* Table */}
      <div className="bg-neutral-900 rounded-lg border border-neutral-800 overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-neutral-800 text-neutral-400 text-sm">
              <th className="text-left p-4">{t('loyalty.customers.columns.customer')}</th>
              <th className="text-left p-4">{t('loyalty.customers.columns.phone')}</th>
              <th className="text-left p-4">{t('loyalty.customers.columns.stamps')}</th>
              <th className="text-right p-4">{t('loyalty.customers.columns.orders')}</th>
              <th className="text-right p-4">{t('loyalty.customers.columns.spent')}</th>
              <th className="text-left p-4">{t('loyalty.customers.columns.lastVisit')}</th>
              <th className="p-4"></th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={7} className="p-8 text-center text-neutral-500">{t('common:states.loading')}</td></tr>
            ) : customers.length === 0 ? (
              <tr><td colSpan={7} className="p-8 text-center text-neutral-500">{t('loyalty.customers.noCustomers')}</td></tr>
            ) : (
              customers.map((c) => (
                <React.Fragment key={c.id}>
                  <tr
                    onClick={() => toggleExpand(c.id)}
                    className="border-b border-neutral-800 hover:bg-neutral-800/50 cursor-pointer transition-colors"
                  >
                    <td className="p-4 font-medium text-white">{c.name}</td>
                    <td className="p-4 text-neutral-300">{c.phone}</td>
                    <td className="p-4">
                      {c.activeCard && renderStampDots(c.activeCard.stamps_earned, c.activeCard.stamps_required)}
                    </td>
                    <td className="p-4 text-right text-neutral-300">{c.orders_count}</td>
                    <td className="p-4 text-right text-neutral-300">{formatPrice(c.total_spent)}</td>
                    <td className="p-4 text-neutral-400 text-sm">
                      {c.last_visit ? formatDate(new Date(c.last_visit)) : '\u2014'}
                    </td>
                    <td className="p-4">
                      {expandedId === c.id ? <ChevronUp size={16} className="text-neutral-400" /> : <ChevronDown size={16} className="text-neutral-400" />}
                    </td>
                  </tr>
                  {expandedId === c.id && expandedDetail && (
                    <tr>
                      <td colSpan={7} className="bg-neutral-800/30 p-4">
                        <div className="grid grid-cols-3 gap-4">
                          <div>
                            <p className="text-xs text-neutral-400 mb-1">{t('loyalty.customers.detail.referralCode')}</p>
                            <p className="text-purple-400 font-bold">{expandedDetail.referral_code}</p>
                          </div>
                          <div>
                            <p className="text-xs text-neutral-400 mb-1">{t('loyalty.customers.detail.totalStamps')}</p>
                            <p className="text-white font-bold">{expandedDetail.stamps_earned}</p>
                          </div>
                          <div>
                            <p className="text-xs text-neutral-400 mb-1">{t('loyalty.customers.detail.smsOptIn')}</p>
                            <p className="text-white">{expandedDetail.sms_opt_in ? t('loyalty.customers.detail.yes') : t('loyalty.customers.detail.no')}</p>
                          </div>
                        </div>

                        {/* Stamp Cards */}
                        {expandedDetail.cards?.length > 0 && (
                          <div className="mt-4">
                            <p className="text-xs text-neutral-400 mb-2">{t('loyalty.customers.detail.stampCards')}</p>
                            <div className="space-y-2">
                              {expandedDetail.cards.map((card: StampCard) => (
                                <div key={card.id} className="flex items-center justify-between bg-neutral-800 rounded-lg p-3">
                                  <div className="flex items-center gap-3">
                                    {renderStampDots(card.stamps_earned, card.stamps_required)}
                                    <span className="text-sm text-neutral-300">
                                      {card.stamps_earned}/{card.stamps_required}
                                    </span>
                                  </div>
                                  <div className="flex items-center gap-2">
                                    {card.completed === 1 && !card.redeemed && (
                                      <span className="text-xs bg-green-600/20 text-green-400 px-2 py-1 rounded">{t('loyalty.customers.detail.ready')}</span>
                                    )}
                                    {card.redeemed === 1 && (
                                      <span className="text-xs bg-neutral-700 text-neutral-400 px-2 py-1 rounded">{t('loyalty.customers.detail.redeemed')}</span>
                                    )}
                                    {!card.completed && (
                                      <span className="text-xs bg-purple-600/20 text-purple-400 px-2 py-1 rounded">{t('loyalty.customers.detail.active')}</span>
                                    )}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Recent Events */}
                        {expandedDetail.recentEvents?.length > 0 && (
                          <div className="mt-4">
                            <p className="text-xs text-neutral-400 mb-2">{t('loyalty.customers.detail.recentActivity')}</p>
                            <div className="space-y-1 max-h-32 overflow-y-auto">
                              {expandedDetail.recentEvents.slice(0, 5).map((ev: any) => (
                                <div key={ev.id} className="flex items-center justify-between text-sm">
                                  <span className="text-neutral-300">
                                    +{ev.stamps_added} {ev.stamps_added > 1 ? t('loyalty.customers.detail.stamps') : t('loyalty.customers.detail.stamp')} ({ev.event_type})
                                  </span>
                                  <span className="text-neutral-500 text-xs">
                                    {formatDate(new Date(ev.created_at))}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        <button
                          onClick={(e) => { e.stopPropagation(); handleAddStamp(c.id); }}
                          className="mt-4 flex items-center gap-2 px-4 py-2 bg-purple-600 text-white text-sm font-bold rounded-lg hover:bg-purple-700 transition-colors"
                        >
                          <Plus size={14} /> {t('loyalty.customers.addStamp')}
                        </button>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {total > 15 && (
        <div className="flex items-center justify-between">
          <p className="text-neutral-400 text-sm">{total} {t('loyalty.customers.customersTotal')}</p>
          <div className="flex gap-2">
            <button
              onClick={() => { setPage((p) => Math.max(1, p - 1)); fetchCustomers(search, Math.max(1, page - 1)); }}
              disabled={page <= 1}
              className="px-4 py-2 bg-neutral-800 text-white rounded-lg disabled:opacity-50"
            >
              {t('loyalty.customers.prev')}
            </button>
            <span className="px-4 py-2 text-neutral-400">{t('loyalty.customers.page')} {page}</span>
            <button
              onClick={() => { setPage((p) => p + 1); fetchCustomers(search, page + 1); }}
              disabled={page * 15 >= total}
              className="px-4 py-2 bg-neutral-800 text-white rounded-lg disabled:opacity-50"
            >
              {t('loyalty.customers.next')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ==================== Analytics Tab ==================== */

function AnalyticsTab() {
  const { t } = useTranslation('reports');
  const [analytics, setAnalytics] = useState<LoyaltyAnalytics | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getLoyaltyAnalytics()
      .then(setAnalytics)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="text-neutral-500 text-center py-8">{t('loyalty.analytics.loading')}</div>;
  if (!analytics) return <div className="text-neutral-500 text-center py-8">{t('loyalty.analytics.failedToLoad')}</div>;

  const chartData = [...(analytics.signupsByMonth || [])].reverse();

  return (
    <div className="space-y-6">
      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
          <p className="text-neutral-400 text-sm">{t('loyalty.analytics.kpi.totalMembers')}</p>
          <p className="text-3xl font-bold text-purple-400 mt-1">{analytics.totalMembers}</p>
        </div>
        <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
          <p className="text-neutral-400 text-sm">{t('loyalty.analytics.kpi.newThisMonth')}</p>
          <p className="text-3xl font-bold text-white mt-1">{analytics.newThisMonth}</p>
        </div>
        <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
          <p className="text-neutral-400 text-sm">{t('loyalty.analytics.kpi.activeCards')}</p>
          <p className="text-3xl font-bold text-white mt-1">{analytics.activeCards}</p>
        </div>
        <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
          <p className="text-neutral-400 text-sm">{t('loyalty.analytics.kpi.redemptionRate')}</p>
          <p className="text-3xl font-bold text-green-400 mt-1">{analytics.redemptionRate}%</p>
        </div>
      </div>

      {/* Signups Chart */}
      {chartData.length > 0 && (
        <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
          <h3 className="text-lg font-bold text-white mb-4">{t('loyalty.analytics.signupsOverTime')}</h3>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                <XAxis dataKey="month" stroke="#888" fontSize={12} />
                <YAxis stroke="#888" fontSize={12} />
                <Tooltip
                  contentStyle={{ backgroundColor: '#262626', border: '1px solid #404040', borderRadius: '8px' }}
                  labelStyle={{ color: '#fff' }}
                />
                <Bar dataKey="count" fill="#9333ea" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Top Customers */}
      {analytics.topCustomers.length > 0 && (
        <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
          <h3 className="text-lg font-bold text-white mb-4">{t('loyalty.analytics.topCustomers')}</h3>
          <div className="space-y-2">
            {analytics.topCustomers.map((c, i) => (
              <div key={c.id} className="flex items-center justify-between p-3 bg-neutral-800 rounded-lg">
                <div className="flex items-center gap-3">
                  <span className="text-neutral-500 font-bold w-6 text-right">#{i + 1}</span>
                  <div>
                    <p className="text-white font-medium">{c.name}</p>
                    <p className="text-neutral-400 text-xs">{c.orders_count} {t('loyalty.analytics.orders')}</p>
                  </div>
                </div>
                <p className="text-purple-400 font-bold">{formatPrice(c.total_spent)}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ==================== Referrals Tab ==================== */

function ReferralsTab() {
  const { t } = useTranslation('reports');
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getLoyaltyReferrals()
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="text-neutral-500 text-center py-8">{t('loyalty.referrals.loading')}</div>;
  if (!data) return <div className="text-neutral-500 text-center py-8">{t('loyalty.referrals.failedToLoad')}</div>;

  return (
    <div className="space-y-6">
      <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
        <p className="text-neutral-400 text-sm">{t('loyalty.referrals.totalReferrals')}</p>
        <p className="text-3xl font-bold text-purple-400 mt-1">{data.totalReferrals}</p>
      </div>

      {/* Leaderboard */}
      {data.leaderboard.length > 0 && (
        <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
          <h3 className="text-lg font-bold text-white mb-4">{t('loyalty.referrals.leaderboard')}</h3>
          <div className="space-y-2">
            {data.leaderboard.map((r: any, i: number) => (
              <div key={r.id} className="flex items-center justify-between p-3 bg-neutral-800 rounded-lg">
                <div className="flex items-center gap-3">
                  <span className="text-neutral-500 font-bold w-6 text-right">#{i + 1}</span>
                  <div>
                    <p className="text-white font-medium">{r.name}</p>
                    <p className="text-neutral-400 text-xs">{t('loyalty.referrals.code')} {r.referral_code}</p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-purple-400 font-bold">{r.referral_count} {t('loyalty.referrals.referralCount')}</p>
                  <p className="text-neutral-400 text-xs">+{r.total_bonus_stamps} {t('loyalty.referrals.bonusStamps')}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent */}
      {data.recentReferrals.length > 0 && (
        <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
          <h3 className="text-lg font-bold text-white mb-4">{t('loyalty.referrals.recentReferrals')}</h3>
          <div className="space-y-2">
            {data.recentReferrals.map((r: any) => (
              <div key={r.id} className="flex items-center justify-between p-3 bg-neutral-800 rounded-lg">
                <div>
                  <p className="text-white text-sm">
                    <span className="text-purple-400 font-medium">{r.referrer_name}</span>
                    {' '}{t('loyalty.referrals.referred')}{' '}
                    <span className="text-purple-400 font-medium">{r.referee_name}</span>
                  </p>
                  <p className="text-neutral-400 text-xs">{formatDate(new Date(r.created_at))}</p>
                </div>
                <p className="text-green-400 text-sm">+{r.referrer_stamps_added} {t('loyalty.referrals.stampsEach')}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {data.leaderboard.length === 0 && data.recentReferrals.length === 0 && (
        <div className="text-neutral-500 text-center py-8">{t('loyalty.referrals.noReferrals')}</div>
      )}
    </div>
  );
}

/* ==================== Settings Tab ==================== */

function SettingsTab() {
  const { t } = useTranslation('reports');
  const [config, setConfig] = useState<LoyaltyConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getLoyaltyConfig()
      .then(setConfig)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async (key: string, value: string) => {
    setSaving(true);
    try {
      const updated = await updateConfigAPI(key, value);
      setConfig(updated);
    } catch {
      // ignore
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="text-neutral-500 text-center py-8">{t('loyalty.settings.loading')}</div>;
  if (!config) return <div className="text-neutral-500 text-center py-8">{t('loyalty.settings.failedToLoad')}</div>;

  const settings = [
    { key: 'stamps_required', label: t('loyalty.settings.stampsRequired'), type: 'number' as const },
    { key: 'reward_description', label: t('loyalty.settings.rewardDescription'), type: 'text' as const },
    { key: 'referral_bonus_stamps', label: t('loyalty.settings.referralBonusStamps'), type: 'number' as const },
    { key: 'sms_enabled', label: t('loyalty.settings.smsNotifications'), type: 'toggle' as const },
  ];

  return (
    <div className="max-w-2xl space-y-4">
      {settings.map((s) => {
        const entry = config[s.key];
        if (!entry) return null;
        return (
          <div key={s.key} className="bg-neutral-900 p-5 rounded-lg border border-neutral-800">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-white font-medium">{s.label}</p>
                {entry.description && <p className="text-neutral-400 text-xs mt-1">{entry.description}</p>}
              </div>
              {s.type === 'toggle' ? (
                <button
                  onClick={() => handleSave(s.key, entry.value === 'true' ? 'false' : 'true')}
                  disabled={saving}
                  className={`w-14 h-7 rounded-full transition-colors relative ${
                    entry.value === 'true' ? 'bg-purple-600' : 'bg-neutral-700'
                  }`}
                >
                  <div className={`w-5 h-5 bg-white rounded-full absolute top-1 transition-all ${
                    entry.value === 'true' ? 'left-8' : 'left-1'
                  }`} />
                </button>
              ) : (
                <input
                  type={s.type}
                  defaultValue={entry.value}
                  onBlur={(e) => {
                    if (e.target.value !== entry.value) handleSave(s.key, e.target.value);
                  }}
                  className="w-48 bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-white text-right focus:outline-none focus:border-purple-600"
                />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
