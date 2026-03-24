import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft, Truck, RefreshCw, BarChart3, Tag, MessageSquare,
  TrendingUp, DollarSign, Users, Plus, Trash2, Send, Store,
} from 'lucide-react';
import {
  getDeliveryPlatforms,
  updateDeliveryPlatform,
  getDeliveryOrders,
  updateDeliveryOrderStatus,
  getDeliveryAnalytics,
  getMarkupRules,
  createMarkupRule,
  deleteMarkupRule,
  getMarkupPreview,
  getVirtualBrands,
  createVirtualBrand,
  getRecaptureCandidates,
  sendRecaptureSMS,
} from '../api';
import { DeliveryPlatform, DeliveryOrder } from '../types';
import { formatPrice } from '../utils/currency';
import BrandLogo from '../components/BrandLogo';
import FeatureGate from '../components/FeatureGate';
import DeliverySetupModal from '../components/delivery/DeliverySetupModal';
import BackToSetupButton from '../components/BackToSetupButton';

type Tab = 'orders' | 'analytics' | 'markups' | 'brands' | 'recapture' | 'platforms';

export default function DeliveryScreen() {
  const { t } = useTranslation('inventory');
  const [platforms, setPlatforms] = useState<DeliveryPlatform[]>([]);
  const [orders, setOrders] = useState<DeliveryOrder[]>([]);
  const [analytics, setAnalytics] = useState<any>(null);
  const [markupRules, setMarkupRules] = useState<any[]>([]);
  const [markupPreview, setMarkupPreview] = useState<any[]>([]);
  const [virtualBrands, setVirtualBrands] = useState<any[]>([]);
  const [recaptureCandidates, setRecaptureCandidates] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('analytics');
  const [selectedPlatform, setSelectedPlatform] = useState<number | null>(null);
  const [showDeliverySetup, setShowDeliverySetup] = useState(false);

  useEffect(() => {
    fetchData();
  }, []);

  useEffect(() => {
    if (tab === 'analytics') fetchAnalytics();
    if (tab === 'markups') fetchMarkups();
    if (tab === 'brands') fetchBrands();
    if (tab === 'recapture') fetchRecapture();
  }, [tab]);

  const fetchData = async () => {
    try {
      setLoading(true);
      const [platformsData, ordersData] = await Promise.all([
        getDeliveryPlatforms(),
        getDeliveryOrders(),
      ]);
      setPlatforms(platformsData);
      setOrders(ordersData);
    } catch (err) {
      console.error('Failed to load delivery data:', err);
    } finally {
      setLoading(false);
    }
  };

  const fetchAnalytics = async () => {
    try {
      const data = await getDeliveryAnalytics();
      setAnalytics(data);
    } catch (err) {
      console.error('Failed to load analytics:', err);
    }
  };

  const fetchMarkups = async () => {
    try {
      const rules = await getMarkupRules();
      setMarkupRules(rules);
    } catch (err) {
      console.error('Failed to load markups:', err);
    }
  };

  const fetchBrands = async () => {
    try {
      const brands = await getVirtualBrands();
      setVirtualBrands(brands);
    } catch (err) {
      console.error('Failed to load virtual brands:', err);
    }
  };

  const fetchRecapture = async () => {
    try {
      const candidates = await getRecaptureCandidates();
      setRecaptureCandidates(candidates);
    } catch (err) {
      console.error('Failed to load recapture candidates:', err);
    }
  };

  const handleTogglePlatform = async (platform: DeliveryPlatform) => {
    try {
      await updateDeliveryPlatform(platform.id, { active: !platform.active });
      fetchData();
    } catch (err) {
      console.error('Failed to toggle platform:', err);
    }
  };

  const handleUpdateOrderStatus = async (orderId: number, status: string) => {
    try {
      await updateDeliveryOrderStatus(orderId, status);
      fetchData();
    } catch (err) {
      console.error('Failed to update delivery order:', err);
    }
  };

  const handleDeleteMarkup = async (id: number) => {
    try {
      await deleteMarkupRule(id);
      fetchMarkups();
    } catch (err) {
      console.error('Failed to delete markup:', err);
    }
  };

  const handlePreviewMarkup = async (platformId: number) => {
    try {
      setSelectedPlatform(platformId);
      const preview = await getMarkupPreview(platformId);
      setMarkupPreview(preview);
    } catch (err) {
      console.error('Failed to preview markup:', err);
    }
  };

  const handleSendRecapture = async (candidate: any) => {
    const phone = prompt('Enter customer phone number:');
    if (!phone) return;
    try {
      await sendRecaptureSMS({
        phone,
        customer_name: candidate.customer_name,
        platform: candidate.platform,
        delivery_order_id: candidate.delivery_order_id,
      });
      alert('SMS sent!');
      fetchRecapture();
    } catch (err) {
      console.error('Failed to send recapture SMS:', err);
      alert('Failed to send SMS');
    }
  };

  const getPlatformColor = (name: string) => {
    switch (name) {
      case 'uber_eats': return 'bg-green-600';
      case 'rappi': return 'bg-orange-500';
      case 'didi_food': return 'bg-orange-600';
      default: return 'bg-neutral-600';
    }
  };

  const tabs: { id: Tab; icon: React.ReactNode; label: string }[] = [
    { id: 'analytics', icon: <BarChart3 size={16} />, label: t('delivery.tabs.analytics') },
    { id: 'orders', icon: <Truck size={16} />, label: t('delivery.tabs.orders') },
    { id: 'markups', icon: <Tag size={16} />, label: t('delivery.tabs.markups') },
    { id: 'brands', icon: <Store size={16} />, label: t('delivery.tabs.brands') },
    { id: 'recapture', icon: <MessageSquare size={16} />, label: t('delivery.tabs.recapture') },
    { id: 'platforms', icon: <TrendingUp size={16} />, label: t('delivery.tabs.config') },
  ];

  return (
    <FeatureGate feature="delivery" featureLabel="Delivery Management">
    <div className="min-h-screen bg-neutral-950">
      <div className="bg-neutral-900 text-white p-6 border-b border-neutral-800">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link to="/admin" className="p-2 hover:bg-neutral-800 rounded-lg transition-colors">
              <ArrowLeft size={24} />
            </Link>
            <h1 className="text-3xl font-black tracking-tighter">{t('delivery.title')}</h1>
          </div>
          <div className="flex items-center gap-4">
            <button
              onClick={fetchData}
              className="p-2 hover:bg-neutral-800 rounded-lg transition-colors"
            >
              <RefreshCw size={20} />
            </button>
            <BrandLogo className="h-10" />
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto p-6">
        {/* Tabs */}
        <div className="flex gap-2 mb-6 overflow-x-auto pb-2">
          {tabs.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-lg font-medium text-sm whitespace-nowrap transition-colors ${
                tab === t.id ? 'bg-brand-600 text-white' : 'bg-neutral-900 text-neutral-300 border border-neutral-800 hover:bg-neutral-800'
              }`}
            >
              {t.icon} {t.label}
            </button>
          ))}
        </div>

        {loading && tab === 'orders' ? (
          <div className="space-y-4">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="h-24 bg-neutral-900 rounded-lg border border-neutral-800 animate-pulse" />
            ))}
          </div>
        ) : (
          <>
            {/* ===== Analytics Tab ===== */}
            {tab === 'analytics' && platforms.length === 0 && (
              <div className="bg-neutral-900 rounded-lg border border-neutral-800 p-12 text-center">
                <Truck size={48} className="mx-auto text-neutral-600 mb-4" />
                <h3 className="text-white text-lg font-bold mb-2">{t('delivery.noPlatforms')}</h3>
                <p className="text-neutral-400 text-sm mb-6">{t('delivery.noPlatformsSetupHint')}</p>
                <button
                  onClick={() => setShowDeliverySetup(true)}
                  className="px-6 py-2.5 bg-brand-600 hover:bg-brand-500 text-white rounded-xl font-bold transition-colors"
                >
                  {t('delivery.setupDelivery')}
                </button>
              </div>
            )}
            {tab === 'analytics' && platforms.length > 0 && (
              <div className="space-y-6">
                {/* Summary Cards */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-4">
                    <div className="flex items-center gap-2 text-neutral-400 text-sm mb-1">
                      <DollarSign size={16} /> {t('delivery.analytics.posRevenue')}
                    </div>
                    <p className="text-2xl font-bold text-white">
                      {formatPrice(analytics?.pos?.revenue || 0)}
                    </p>
                    <p className="text-xs text-neutral-500">{analytics?.pos?.order_count || 0} orders</p>
                  </div>
                  <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-4">
                    <div className="flex items-center gap-2 text-neutral-400 text-sm mb-1">
                      <Truck size={16} /> {t('delivery.analytics.deliveryRevenue')}
                    </div>
                    <p className="text-2xl font-bold text-brand-400">
                      {formatPrice(analytics?.delivery?.revenue || 0)}
                    </p>
                    <p className="text-xs text-neutral-500">{analytics?.delivery?.order_count || 0} orders</p>
                  </div>
                  <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-4">
                    <div className="flex items-center gap-2 text-neutral-400 text-sm mb-1">
                      <TrendingUp size={16} /> {t('delivery.analytics.avgPosTicket')}
                    </div>
                    <p className="text-2xl font-bold text-white">
                      {formatPrice(analytics?.pos?.avg_order || 0)}
                    </p>
                  </div>
                  <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-4">
                    <div className="flex items-center gap-2 text-neutral-400 text-sm mb-1">
                      <TrendingUp size={16} /> {t('delivery.analytics.avgDeliveryTicket')}
                    </div>
                    <p className="text-2xl font-bold text-brand-400">
                      {formatPrice(analytics?.delivery?.avg_order || 0)}
                    </p>
                  </div>
                </div>

                {/* Per-Platform Breakdown */}
                <div className="bg-neutral-900 border border-neutral-800 rounded-lg">
                  <div className="p-4 border-b border-neutral-800">
                    <h3 className="font-bold text-white">{t('delivery.analytics.platformBreakdown')}</h3>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-neutral-400 border-b border-neutral-800">
                          <th className="text-left p-3">{t('delivery.analytics.platform')}</th>
                          <th className="text-right p-3">{t('delivery.analytics.ordersColumn')}</th>
                          <th className="text-right p-3">{t('delivery.analytics.grossRevenue')}</th>
                          <th className="text-right p-3">{t('delivery.analytics.commissionColumn')}</th>
                          <th className="text-right p-3">{t('delivery.analytics.netRevenue')}</th>
                          <th className="text-right p-3">{t('delivery.analytics.avgOrder')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(analytics?.platforms || []).map((p: any) => (
                          <tr key={p.platform_id} className="border-b border-neutral-800/50">
                            <td className="p-3">
                              <span className={`px-2 py-0.5 rounded text-xs font-bold text-white ${getPlatformColor(p.name)}`}>
                                {p.display_name}
                              </span>
                            </td>
                            <td className="text-right p-3 text-white">{p.order_count}</td>
                            <td className="text-right p-3 text-white">{formatPrice(p.gross_revenue)}</td>
                            <td className="text-right p-3 text-brand-400">-{formatPrice(p.total_commission)} ({p.commission_percent}%)</td>
                            <td className="text-right p-3 text-green-400 font-bold">{formatPrice(p.net_revenue)}</td>
                            <td className="text-right p-3 text-neutral-300">{formatPrice(p.avg_order_value)}</td>
                          </tr>
                        ))}
                        {(!analytics?.platforms || analytics.platforms.length === 0) && (
                          <tr><td colSpan={6} className="p-8 text-center text-neutral-500">{t('delivery.analytics.noDataYet')}</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}

            {/* ===== Orders Tab ===== */}
            {tab === 'orders' && (
              <div className="space-y-4">
                {orders.length === 0 ? (
                  <div className="bg-neutral-900 rounded-lg border border-neutral-800 p-12 text-center">
                    <Truck size={48} className="mx-auto text-neutral-600 mb-4" />
                    <p className="text-neutral-400 text-lg">{t('delivery.noOrders')}</p>
                    <p className="text-neutral-500 text-sm mt-1">{t('delivery.ordersHint')}</p>
                  </div>
                ) : (
                  orders.map((order: any) => (
                    <div key={order.id} className="bg-neutral-900 rounded-lg border border-neutral-800 p-4">
                      <div className="flex items-start justify-between mb-3">
                        <div>
                          <div className="flex items-center gap-2 mb-1">
                            <span className={`px-2 py-0.5 rounded text-xs font-bold text-white ${getPlatformColor(order.platform_name?.toLowerCase().replace(/\s/g, '_'))}`}>
                              {order.platform_name}
                            </span>
                            <span className="text-white font-bold">{t('delivery.orderNumber', { number: order.order_number })}</span>
                          </div>
                          <p className="text-neutral-400 text-sm">{order.customer_name}</p>
                          {order.delivery_address && (
                            <p className="text-neutral-500 text-xs mt-1">{order.delivery_address}</p>
                          )}
                        </div>
                        <div className="text-right">
                          <p className="font-bold text-brand-500">{formatPrice(order.total || 0)}</p>
                          <p className="text-xs text-neutral-500">{order.platform_status}</p>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        {order.platform_status === 'received' && (
                          <button
                            onClick={() => handleUpdateOrderStatus(order.id, 'confirmed')}
                            className="px-3 py-1 bg-green-600 text-white text-sm rounded-lg font-medium hover:bg-green-700"
                          >
                            {t('delivery.actions.confirm')}
                          </button>
                        )}
                        {order.platform_status === 'confirmed' && (
                          <button
                            onClick={() => handleUpdateOrderStatus(order.id, 'ready_for_pickup')}
                            className="px-3 py-1 bg-amber-600 text-white text-sm rounded-lg font-medium hover:bg-amber-700"
                          >
                            {t('delivery.actions.readyForPickup')}
                          </button>
                        )}
                        {order.platform_status === 'ready_for_pickup' && (
                          <button
                            onClick={() => handleUpdateOrderStatus(order.id, 'picked_up')}
                            className="px-3 py-1 bg-blue-600 text-white text-sm rounded-lg font-medium hover:bg-blue-700"
                          >
                            {t('delivery.actions.pickedUp')}
                          </button>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}

            {/* ===== Markup Rules Tab ===== */}
            {tab === 'markups' && (
              <div className="space-y-6">
                <div className="bg-neutral-900 border border-neutral-800 rounded-lg">
                  <div className="p-4 border-b border-neutral-800 flex items-center justify-between">
                    <h3 className="font-bold text-white">{t('delivery.markups.title')}</h3>
                    <p className="text-xs text-neutral-500">{t('delivery.markups.subtitle')}</p>
                  </div>
                  <div className="p-4">
                    {markupRules.length === 0 ? (
                      <p className="text-neutral-500 text-center py-8">{t('delivery.markups.noRules')}</p>
                    ) : (
                      <div className="space-y-3">
                        {markupRules.map((rule: any) => (
                          <div key={rule.id} className="flex items-center justify-between bg-neutral-800/50 rounded-lg p-3">
                            <div>
                              <span className="text-white font-medium">
                                {rule.item_name || rule.category_name || 'Unknown'}
                              </span>
                              <span className="text-neutral-500 text-sm ml-2">on {rule.platform_name}</span>
                            </div>
                            <div className="flex items-center gap-3">
                              <span className="text-brand-400 font-bold">
                                +{rule.markup_value}{rule.markup_type === 'percent' ? '%' : ' MXN'}
                              </span>
                              <button onClick={() => handleDeleteMarkup(rule.id)} className="text-neutral-500 hover:text-brand-400">
                                <Trash2 size={16} />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* Markup Preview */}
                <div className="bg-neutral-900 border border-neutral-800 rounded-lg">
                  <div className="p-4 border-b border-neutral-800">
                    <h3 className="font-bold text-white mb-3">{t('delivery.markups.pricePreview')}</h3>
                    <div className="flex gap-2">
                      {platforms.filter(p => p.active).map(p => (
                        <button
                          key={p.id}
                          onClick={() => handlePreviewMarkup(p.id)}
                          className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                            selectedPlatform === p.id ? 'bg-brand-600 text-white' : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700'
                          }`}
                        >
                          {p.display_name}
                        </button>
                      ))}
                    </div>
                  </div>
                  {markupPreview.length > 0 && (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-neutral-400 border-b border-neutral-800">
                            <th className="text-left p-3">{t('delivery.markups.item')}</th>
                            <th className="text-right p-3">{t('delivery.markups.posPrice')}</th>
                            <th className="text-right p-3">{t('delivery.markups.markup')}</th>
                            <th className="text-right p-3">{t('delivery.markups.deliveryPrice')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {markupPreview.map((item: any) => (
                            <tr key={item.id} className="border-b border-neutral-800/50">
                              <td className="p-3">
                                <span className="text-white">{item.name}</span>
                                <span className="text-neutral-500 text-xs ml-2">{item.category_name}</span>
                              </td>
                              <td className="text-right p-3 text-neutral-300">{formatPrice(item.base_price)}</td>
                              <td className="text-right p-3 text-brand-400">
                                {item.markup_value > 0 ? `+${item.markup_value}${item.markup_type === 'percent' ? '%' : ''}` : '-'}
                              </td>
                              <td className="text-right p-3 text-white font-bold">{formatPrice(item.delivery_price)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ===== Virtual Brands Tab ===== */}
            {tab === 'brands' && (
              <div className="space-y-6">
                <div className="bg-neutral-900 border border-neutral-800 rounded-lg">
                  <div className="p-4 border-b border-neutral-800 flex items-center justify-between">
                    <div>
                      <h3 className="font-bold text-white">{t('delivery.brands.title')}</h3>
                      <p className="text-xs text-neutral-500 mt-1">{t('delivery.brands.subtitle')}</p>
                    </div>
                  </div>
                  <div className="p-4">
                    {virtualBrands.length === 0 ? (
                      <div className="text-center py-8">
                        <Store size={40} className="mx-auto text-neutral-600 mb-3" />
                        <p className="text-neutral-500">{t('delivery.brands.noBrands')}</p>
                        <p className="text-neutral-600 text-sm mt-1">{t('delivery.brands.noBrandsHint')}</p>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {virtualBrands.map((brand: any) => (
                          <div key={brand.id} className="flex items-center justify-between bg-neutral-800/50 rounded-lg p-4">
                            <div>
                              <h4 className="text-white font-bold">{brand.name}</h4>
                              <p className="text-neutral-500 text-sm">{brand.platform_name} &middot; {brand.item_count} items</p>
                              {brand.description && <p className="text-neutral-400 text-sm mt-1">{brand.description}</p>}
                            </div>
                            <span className={`px-2 py-1 rounded text-xs font-medium ${brand.active ? 'bg-green-900/30 text-green-400' : 'bg-neutral-800 text-neutral-500'}`}>
                              {brand.active ? t('delivery.active') : t('delivery.inactive')}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* ===== Recapture Tab ===== */}
            {tab === 'recapture' && (
              <div className="space-y-6">
                <div className="bg-neutral-900 border border-neutral-800 rounded-lg">
                  <div className="p-4 border-b border-neutral-800">
                    <h3 className="font-bold text-white">{t('delivery.recapture.title')}</h3>
                    <p className="text-xs text-neutral-500 mt-1">{t('delivery.recapture.subtitle')}</p>
                  </div>
                  <div className="p-4">
                    {recaptureCandidates.length === 0 ? (
                      <div className="text-center py-8">
                        <Users size={40} className="mx-auto text-neutral-600 mb-3" />
                        <p className="text-neutral-500">{t('delivery.recapture.noCandidates')}</p>
                        <p className="text-neutral-600 text-sm mt-1">{t('delivery.recapture.noCandidatesHint')}</p>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {recaptureCandidates.map((c: any, i: number) => (
                          <div key={i} className="flex items-center justify-between bg-neutral-800/50 rounded-lg p-3">
                            <div>
                              <p className="text-white font-medium">{c.customer_name}</p>
                              <p className="text-neutral-500 text-sm">
                                Last order: {formatPrice(c.last_order_total)} via {c.platform}
                                {c.last_order_date && <span className="ml-2">{new Date(c.last_order_date).toLocaleDateString()}</span>}
                              </p>
                            </div>
                            <div className="flex items-center gap-2">
                              {c.sms_sent_at ? (
                                <span className="text-xs text-neutral-500">
                                  SMS sent {new Date(c.sms_sent_at).toLocaleDateString()}
                                  {c.converted ? ' (converted!)' : ''}
                                </span>
                              ) : (
                                <button
                                  onClick={() => handleSendRecapture(c)}
                                  className="flex items-center gap-1 px-3 py-1.5 bg-brand-600 text-white text-sm rounded-lg font-medium hover:bg-brand-700"
                                >
                                  <Send size={14} /> {t('delivery.recapture.sendSms')}
                                </button>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* ===== Platforms Tab ===== */}
            {tab === 'platforms' && (
              <div className="space-y-4">
                {platforms.map((platform) => (
                  <div key={platform.id} className={`bg-neutral-900 rounded-lg border border-neutral-800 p-6 ${!platform.active ? 'opacity-50' : ''}`}>
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="text-xl font-bold text-white">{platform.display_name}</h3>
                        <p className="text-neutral-400 text-sm mt-1">
                          {t('delivery.commission')} {platform.commission_percent}%
                        </p>
                      </div>
                      <button
                        onClick={() => handleTogglePlatform(platform)}
                        className={`px-4 py-2 rounded-lg font-medium ${platform.active ? 'bg-green-900/30 text-green-400' : 'bg-neutral-800 text-neutral-500'}`}
                      >
                        {platform.active ? t('delivery.active') : t('delivery.inactive')}
                      </button>
                    </div>
                  </div>
                ))}
                {platforms.length === 0 && (
                  <div className="bg-neutral-900 rounded-lg border border-neutral-800 p-12 text-center">
                    <Truck size={48} className="mx-auto text-neutral-600 mb-4" />
                    <h3 className="text-white text-lg font-bold mb-2">{t('delivery.noPlatforms')}</h3>
                    <p className="text-neutral-400 text-sm mb-6">{t('delivery.noPlatformsAddHint')}</p>
                    <button
                      onClick={() => setShowDeliverySetup(true)}
                      className="px-6 py-2.5 bg-brand-600 hover:bg-brand-500 text-white rounded-xl font-bold transition-colors"
                    >
                      {t('delivery.setupDelivery')}
                    </button>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>

    <DeliverySetupModal
      isOpen={showDeliverySetup}
      onClose={() => setShowDeliverySetup(false)}
      onDeliverySetup={() => fetchData()}
    />
    <BackToSetupButton />
    </FeatureGate>
  );
}
