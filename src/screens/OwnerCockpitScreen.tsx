import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  ShoppingCart,
  TrendingUp,
  Heart,
  UtensilsCrossed,
  DollarSign,
  Users,
  Package,
  ClipboardList,
  BarChart3,
  Plug,
  Monitor,
  Shield,
  Palette,
  FileText,
  User,
  ArrowDownCircle,
  ArrowUpCircle,
  Settings,
  ChefHat,
  SlidersHorizontal,
  Truck,
  Trash2,
  Receipt,
  QrCode,
  MonitorSmartphone,
  Printer,
} from 'lucide-react';
import BrandLogo from '../components/BrandLogo';
import { useAuth } from '../context/AuthContext';
import { purgeUnpaidOrders } from '../api';

type Intensity = 'primary' | 'secondary';

interface CockpitCard {
  to: string;
  icon: React.ReactNode;
  /** i18n key under cockpit.cards.<key>.{label,hint} */
  key: string;
  intensity: Intensity;
}

const IN_CARDS: CockpitCard[] = [
  { to: '/pos', icon: <ShoppingCart size={32} />, key: 'pos', intensity: 'primary' },
  { to: '/admin/orders', icon: <Receipt size={32} />, key: 'orders', intensity: 'primary' },
  { to: '/admin/reports?tab=overview', icon: <TrendingUp size={32} />, key: 'sales', intensity: 'primary' },
  { to: '/admin/menu', icon: <UtensilsCrossed size={28} />, key: 'menu', intensity: 'secondary' },
  { to: '/admin/loyalty', icon: <Heart size={28} />, key: 'loyalty', intensity: 'secondary' },
  { to: '/admin/qr-menu', icon: <QrCode size={28} />, key: 'qrMenu', intensity: 'secondary' },
  { to: '/admin/kiosk', icon: <MonitorSmartphone size={28} />, key: 'kiosk', intensity: 'secondary' },
  { to: '/admin/delivery', icon: <Truck size={28} />, key: 'delivery', intensity: 'secondary' },
  { to: '/admin/reports?tab=engineering', icon: <BarChart3 size={28} />, key: 'menuPerformance', intensity: 'secondary' },
];

const OUT_CARDS: CockpitCard[] = [
  { to: '/admin/expenses', icon: <DollarSign size={32} />, key: 'expenses', intensity: 'primary' },
  { to: '/admin/staff', icon: <Users size={32} />, key: 'staff', intensity: 'primary' },
  { to: '/admin/inventory', icon: <Package size={32} />, key: 'inventory', intensity: 'primary' },
  { to: '/admin/recipes', icon: <ChefHat size={28} />, key: 'recipes', intensity: 'secondary' },
  { to: '/admin/purchase-orders', icon: <ClipboardList size={28} />, key: 'purchaseOrders', intensity: 'secondary' },
];

const SYSTEM_CARDS: CockpitCard[] = [
  { to: '/admin/reports?tab=cashcard', icon: <BarChart3 size={28} />, key: 'reports', intensity: 'primary' },
  { to: '/admin/integrations', icon: <Plug size={28} />, key: 'integrations', intensity: 'primary' },
  { to: '/admin/modifiers', icon: <SlidersHorizontal size={28} />, key: 'modifiers', intensity: 'secondary' },
  { to: '/kitchen', icon: <Monitor size={28} />, key: 'kitchenDisplay', intensity: 'secondary' },
  { to: '/admin/devices', icon: <Monitor size={28} />, key: 'devices', intensity: 'secondary' },
  { to: '/admin/printers', icon: <Printer size={28} />, key: 'printers', intensity: 'secondary' },
  { to: '/admin/permissions', icon: <Shield size={28} />, key: 'permissions', intensity: 'secondary' },
  { to: '/admin/branding', icon: <Palette size={28} />, key: 'identity', intensity: 'secondary' },
  { to: '/admin/invoicing', icon: <FileText size={28} />, key: 'invoicing', intensity: 'secondary' },
  { to: '/admin/account', icon: <User size={28} />, key: 'account', intensity: 'secondary' },
];

type Tone = 'in' | 'out' | 'system';

const TONE_STYLES: Record<Tone, { primary: string; secondary: string; icon: string }> = {
  in: {
    primary:
      'bg-cockpit-green/15 border-cockpit-green/70 hover:border-cockpit-green/90 hover:bg-cockpit-green/25 shadow-[0_0_24px_-8px_rgba(52,168,83,0.55)] hover:shadow-[0_0_36px_-6px_rgba(52,168,83,0.7)]',
    secondary:
      'bg-cockpit-green/5 border-cockpit-green/30 hover:border-cockpit-green/60 hover:bg-cockpit-green/10',
    icon: 'text-cockpit-in-text',
  },
  out: {
    primary:
      'bg-cockpit-red/15 border-cockpit-red/70 hover:border-cockpit-red/90 hover:bg-cockpit-red/25 shadow-[0_0_24px_-8px_rgba(234,67,53,0.55)] hover:shadow-[0_0_36px_-6px_rgba(234,67,53,0.7)]',
    secondary:
      'bg-cockpit-red/5 border-cockpit-red/30 hover:border-cockpit-red/60 hover:bg-cockpit-red/10',
    icon: 'text-cockpit-out-text',
  },
  system: {
    primary:
      'bg-cockpit-blue/15 border-cockpit-blue/70 hover:border-cockpit-blue/90 hover:bg-cockpit-blue/25 shadow-[0_0_24px_-8px_rgba(66,133,244,0.55)] hover:shadow-[0_0_36px_-6px_rgba(66,133,244,0.7)]',
    secondary:
      'bg-cockpit-blue/5 border-cockpit-blue/30 hover:border-cockpit-blue/60 hover:bg-cockpit-blue/10',
    icon: 'text-cockpit-system-text',
  },
};

interface SectionProps {
  tone: Tone;
  title: string;
  description: string;
  badgeIcon: React.ReactNode;
  badgeColor: string;
  cards: CockpitCard[];
}

const Section: React.FC<SectionProps> = ({ tone, title, description, badgeIcon, badgeColor, cards }) => {
  const { t } = useTranslation('cockpit');
  const styles = TONE_STYLES[tone];

  return (
    <section className="mb-12">
      <div className="flex items-center gap-4 mb-5">
        <div className={`w-12 h-12 rounded-2xl flex items-center justify-center ${badgeColor}`}>
          {badgeIcon}
        </div>
        <div>
          <h2 className="text-4xl font-black tracking-tighter text-white leading-none">{title}</h2>
          <p className="text-neutral-400 text-sm mt-1">{description}</p>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
        {cards.map((card, i) => {
          const isPrimary = card.intensity === 'primary';
          return (
            <Link
              key={`${card.to}-${i}`}
              to={card.to}
              className={`group rounded-2xl border p-6 transition-all ${
                isPrimary ? styles.primary : styles.secondary
              } ${isPrimary ? 'min-h-[150px]' : 'min-h-[130px]'}`}
            >
              <div className={`mb-4 transition-colors ${styles.icon}`}>{card.icon}</div>
              <div className={`text-white font-bold ${isPrimary ? 'text-lg' : 'text-base'}`}>
                {t(`cards.${card.key}.label`)}
              </div>
              <div className="text-neutral-400 text-xs mt-1">{t(`cards.${card.key}.hint`)}</div>
            </Link>
          );
        })}
      </div>
    </section>
  );
};

export default function OwnerCockpitScreen() {
  const { t } = useTranslation('cockpit');
  const { currentEmployee } = useAuth();
  const isAdmin = currentEmployee?.role === 'admin';
  const [purging, setPurging] = useState(false);

  const handlePurgeUnpaid = async () => {
    if (!window.confirm(t('danger.confirm'))) return;
    setPurging(true);
    try {
      const res = await purgeUnpaidOrders();
      window.alert(t('danger.deleted', { count: res.deleted_count }));
    } catch (err) {
      window.alert(err instanceof Error ? err.message : t('danger.failed'));
    } finally {
      setPurging(false);
    }
  };

  return (
    <div className="min-h-screen bg-neutral-950">
      <div className="bg-neutral-900 text-white p-6 border-b border-neutral-800">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link to="/pos" className="p-2 hover:bg-neutral-800 rounded-lg transition-colors">
              <ArrowLeft size={24} />
            </Link>
            <div>
              <h1 className="text-3xl font-black tracking-tighter">{t('header.title')}</h1>
              <p className="text-neutral-400 text-sm mt-1">
                {t('header.subtitle')}
              </p>
            </div>
          </div>
          <BrandLogo className="h-10" />
        </div>
      </div>

      <div className="max-w-6xl mx-auto p-6 pt-10">
        <Section
          tone="in"
          title={t('sections.in.title')}
          description={t('sections.in.description')}
          badgeIcon={<ArrowDownCircle size={26} className="text-cockpit-in-text" />}
          badgeColor="bg-cockpit-green/15 border border-cockpit-green/60"
          cards={IN_CARDS}
        />

        <Section
          tone="out"
          title={t('sections.out.title')}
          description={t('sections.out.description')}
          badgeIcon={<ArrowUpCircle size={26} className="text-cockpit-out-text" />}
          badgeColor="bg-cockpit-red/15 border border-cockpit-red/60"
          cards={OUT_CARDS}
        />

        <Section
          tone="system"
          title={t('sections.system.title')}
          description={t('sections.system.description')}
          badgeIcon={<Settings size={26} className="text-cockpit-system-text" />}
          badgeColor="bg-cockpit-blue/15 border border-cockpit-blue/60"
          cards={SYSTEM_CARDS}
        />

        {isAdmin && (
          <div className="mt-4 p-5 bg-neutral-900 border border-cockpit-red/40 rounded-xl">
            <div className="flex items-center gap-2 mb-2">
              <Trash2 size={16} className="text-cockpit-out-text" />
              <h3 className="text-cockpit-out-text font-semibold text-sm">{t('danger.title')}</h3>
            </div>
            <p className="text-neutral-400 text-xs mb-4">
              {t('danger.description')}
            </p>
            <button
              onClick={handlePurgeUnpaid}
              disabled={purging}
              className="px-4 py-2 bg-cockpit-red/40 border border-cockpit-red/60 text-cockpit-out-text text-sm font-semibold rounded-lg hover:bg-cockpit-red/60 transition-all disabled:opacity-50"
            >
              {purging ? t('danger.deleting') : t('danger.button')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
