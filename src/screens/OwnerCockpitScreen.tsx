import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowLeft,
  ShoppingCart,
  TrendingUp,
  Heart,
  UtensilsCrossed,
  DollarSign,
  Users,
  Clock,
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
} from 'lucide-react';
import BrandLogo from '../components/BrandLogo';
import { useAuth } from '../context/AuthContext';
import { purgeUnpaidOrders } from '../api';

type Intensity = 'primary' | 'secondary';

interface CockpitCard {
  to: string;
  icon: React.ReactNode;
  label: string;
  hint: string;
  intensity: Intensity;
}

const IN_CARDS: CockpitCard[] = [
  { to: '/pos', icon: <ShoppingCart size={32} />, label: 'POS', hint: 'Ring up sales', intensity: 'primary' },
  { to: '/admin/reports', icon: <TrendingUp size={32} />, label: 'Sales', hint: 'Daily revenue', intensity: 'primary' },
  { to: '/admin/menu', icon: <UtensilsCrossed size={28} />, label: 'Menu', hint: 'Items & prices', intensity: 'secondary' },
  { to: '/admin/loyalty', icon: <Heart size={28} />, label: 'Loyalty', hint: 'Repeat customers', intensity: 'secondary' },
  { to: '/admin/delivery', icon: <Truck size={28} />, label: 'Delivery', hint: 'Rappi, Uber, DiDi', intensity: 'secondary' },
  { to: '/admin/reports', icon: <BarChart3 size={28} />, label: 'Menu Performance', hint: 'Top sellers', intensity: 'secondary' },
];

const OUT_CARDS: CockpitCard[] = [
  { to: '/admin/expenses', icon: <DollarSign size={32} />, label: 'Expenses', hint: 'Money going out', intensity: 'primary' },
  { to: '/admin/staff?tab=payroll', icon: <Users size={32} />, label: 'Payroll', hint: 'Staff & pay', intensity: 'primary' },
  { to: '/admin/inventory', icon: <Package size={32} />, label: 'Inventory', hint: 'Stock & COGS', intensity: 'primary' },
  { to: '/admin/recipes', icon: <ChefHat size={28} />, label: 'Recipes', hint: 'Cost per item', intensity: 'secondary' },
  { to: '/admin/staff?tab=timeclock', icon: <Clock size={28} />, label: 'Time Clock', hint: 'Shifts & hours', intensity: 'secondary' },
  { to: '/admin/purchase-orders', icon: <ClipboardList size={28} />, label: 'Purchase Orders', hint: 'Supplier orders', intensity: 'secondary' },
];

const SYSTEM_CARDS: CockpitCard[] = [
  { to: '/admin/reports', icon: <BarChart3 size={28} />, label: 'Reports', hint: 'Numbers & trends', intensity: 'primary' },
  { to: '/admin/integrations', icon: <Plug size={28} />, label: 'Integrations', hint: 'Payments & apps', intensity: 'primary' },
  { to: '/admin/modifiers', icon: <SlidersHorizontal size={28} />, label: 'Modifiers', hint: 'Sizes, extras & add-ons', intensity: 'secondary' },
  { to: '/kitchen', icon: <Monitor size={28} />, label: 'Kitchen Display', hint: 'Order screen for cooks', intensity: 'secondary' },
  { to: '/admin/permissions', icon: <Shield size={28} />, label: 'Permissions', hint: 'Role access', intensity: 'secondary' },
  { to: '/admin/branding', icon: <Palette size={28} />, label: 'Identity', hint: 'Logo & info', intensity: 'secondary' },
  { to: '/admin/invoicing', icon: <FileText size={28} />, label: 'Invoicing', hint: 'CFDI & invoices', intensity: 'secondary' },
  { to: '/admin/account', icon: <User size={28} />, label: 'Account', hint: 'Plan & billing', intensity: 'secondary' },
];

type Tone = 'in' | 'out' | 'system';

const TONE_STYLES: Record<Tone, { primary: string; secondary: string; icon: string }> = {
  in: {
    primary:
      'bg-cockpit-green/15 border-cockpit-green/70 hover:border-cockpit-green/90 hover:bg-cockpit-green/25 shadow-[0_0_24px_-8px_rgba(52,168,83,0.55)] hover:shadow-[0_0_36px_-6px_rgba(52,168,83,0.7)]',
    secondary:
      'bg-cockpit-green/5 border-cockpit-green/30 hover:border-cockpit-green/60 hover:bg-cockpit-green/10',
    icon: 'text-cockpit-green',
  },
  out: {
    primary:
      'bg-cockpit-red/15 border-cockpit-red/70 hover:border-cockpit-red/90 hover:bg-cockpit-red/25 shadow-[0_0_24px_-8px_rgba(234,67,53,0.55)] hover:shadow-[0_0_36px_-6px_rgba(234,67,53,0.7)]',
    secondary:
      'bg-cockpit-red/5 border-cockpit-red/30 hover:border-cockpit-red/60 hover:bg-cockpit-red/10',
    icon: 'text-cockpit-red',
  },
  system: {
    primary:
      'bg-cockpit-blue/15 border-cockpit-blue/70 hover:border-cockpit-blue/90 hover:bg-cockpit-blue/25 shadow-[0_0_24px_-8px_rgba(66,133,244,0.55)] hover:shadow-[0_0_36px_-6px_rgba(66,133,244,0.7)]',
    secondary:
      'bg-cockpit-blue/5 border-cockpit-blue/30 hover:border-cockpit-blue/60 hover:bg-cockpit-blue/10',
    icon: 'text-cockpit-blue',
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
                {card.label}
              </div>
              <div className="text-neutral-400 text-xs mt-1">{card.hint}</div>
            </Link>
          );
        })}
      </div>
    </section>
  );
};

export default function OwnerCockpitScreen() {
  const { currentEmployee } = useAuth();
  const isAdmin = currentEmployee?.role === 'admin';
  const [purging, setPurging] = useState(false);

  const handlePurgeUnpaid = async () => {
    if (!window.confirm('Delete ALL unpaid and pending-terminal orders? This cannot be undone.')) return;
    setPurging(true);
    try {
      const res = await purgeUnpaidOrders();
      window.alert(`Deleted ${res.deleted_count} order(s).`);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Failed to purge orders');
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
              <h1 className="text-3xl font-black tracking-tighter">Owner Cockpit</h1>
              <p className="text-neutral-400 text-sm mt-1">
                See what comes in, what goes out, and how the machine runs.
              </p>
            </div>
          </div>
          <BrandLogo className="h-10" />
        </div>
      </div>

      <div className="max-w-6xl mx-auto p-6 pt-10">
        <Section
          tone="in"
          title="IN"
          description="Money and demand entering the business."
          badgeIcon={<ArrowDownCircle size={26} className="text-cockpit-green" />}
          badgeColor="bg-cockpit-green/15 border border-cockpit-green/60"
          cards={IN_CARDS}
        />

        <Section
          tone="out"
          title="OUT"
          description="Costs, labor, waste, and pressure leaving the business."
          badgeIcon={<ArrowUpCircle size={26} className="text-cockpit-red" />}
          badgeColor="bg-cockpit-red/15 border border-cockpit-red/60"
          cards={OUT_CARDS}
        />

        <Section
          tone="system"
          title="SYSTEM"
          description="Reports, connections, controls, and setup."
          badgeIcon={<Settings size={26} className="text-cockpit-blue" />}
          badgeColor="bg-cockpit-blue/15 border border-cockpit-blue/60"
          cards={SYSTEM_CARDS}
        />

        {isAdmin && (
          <div className="mt-4 p-5 bg-neutral-900 border border-cockpit-red/40 rounded-xl">
            <div className="flex items-center gap-2 mb-2">
              <Trash2 size={16} className="text-cockpit-red" />
              <h3 className="text-cockpit-red font-semibold text-sm">Danger zone</h3>
            </div>
            <p className="text-neutral-400 text-xs mb-4">
              Bulk-delete all unpaid and pending-terminal orders. Useful for clearing test orders.
            </p>
            <button
              onClick={handlePurgeUnpaid}
              disabled={purging}
              className="px-4 py-2 bg-cockpit-red/40 border border-cockpit-red/60 text-cockpit-red text-sm font-semibold rounded-lg hover:bg-cockpit-red/60 transition-all disabled:opacity-50"
            >
              {purging ? 'Deleting\u2026' : 'Delete all unpaid orders'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
