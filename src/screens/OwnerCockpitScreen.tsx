import React from 'react';
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
  Printer,
  Shield,
  Palette,
  FileText,
  User,
  MonitorPlay,
  ArrowDownCircle,
  ArrowUpCircle,
  Settings,
} from 'lucide-react';
import BrandLogo from '../components/BrandLogo';

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
  { to: '/admin/loyalty', icon: <Heart size={28} />, label: 'Loyalty', hint: 'Repeat customers', intensity: 'secondary' },
  { to: '/admin/reports', icon: <UtensilsCrossed size={28} />, label: 'Menu Performance', hint: 'Top sellers', intensity: 'secondary' },
];

const OUT_CARDS: CockpitCard[] = [
  { to: '/admin/expenses', icon: <DollarSign size={32} />, label: 'Expenses', hint: 'Money going out', intensity: 'primary' },
  { to: '/admin/employees', icon: <Users size={32} />, label: 'Payroll', hint: 'Staff & pay', intensity: 'primary' },
  { to: '/admin/inventory', icon: <Package size={32} />, label: 'Inventory', hint: 'Stock & COGS', intensity: 'primary' },
  { to: '/admin/shifts', icon: <Clock size={28} />, label: 'Time Clock', hint: 'Shifts & hours', intensity: 'secondary' },
  { to: '/admin/purchase-orders', icon: <ClipboardList size={28} />, label: 'Purchase Orders', hint: 'Supplier orders', intensity: 'secondary' },
];

const SYSTEM_CARDS: CockpitCard[] = [
  { to: '/admin/reports', icon: <BarChart3 size={28} />, label: 'Reports', hint: 'Numbers & trends', intensity: 'primary' },
  { to: '/admin/integrations', icon: <Plug size={28} />, label: 'Integrations', hint: 'Payments & apps', intensity: 'primary' },
  { to: '/admin/printers', icon: <Printer size={28} />, label: 'Printers', hint: 'Receipt & kitchen', intensity: 'secondary' },
  { to: '/admin/permissions', icon: <Shield size={28} />, label: 'Permissions', hint: 'Role access', intensity: 'secondary' },
  { to: '/admin/branding', icon: <Palette size={28} />, label: 'Branding', hint: 'Logo & colors', intensity: 'secondary' },
  { to: '/admin/invoicing', icon: <FileText size={28} />, label: 'Invoicing', hint: 'CFDI & invoices', intensity: 'secondary' },
  { to: '/admin/account', icon: <User size={28} />, label: 'Account', hint: 'Plan & billing', intensity: 'secondary' },
  { to: '/admin/display-menu', icon: <MonitorPlay size={28} />, label: 'Display Menu', hint: 'TV menu board', intensity: 'secondary' },
];

type Tone = 'in' | 'out' | 'system';

const TONE_STYLES: Record<Tone, { primary: string; secondary: string; icon: string }> = {
  in: {
    primary:
      'bg-emerald-950/60 border-emerald-500/70 hover:border-emerald-400 hover:bg-emerald-900/60 shadow-[0_0_24px_-8px_rgba(16,185,129,0.55)] hover:shadow-[0_0_36px_-6px_rgba(16,185,129,0.7)]',
    secondary:
      'bg-emerald-950/30 border-emerald-800/60 hover:border-emerald-600 hover:bg-emerald-900/40',
    icon: 'text-emerald-400 group-hover:text-emerald-300',
  },
  out: {
    primary:
      'bg-rose-950/60 border-rose-500/70 hover:border-rose-400 hover:bg-rose-900/60 shadow-[0_0_24px_-8px_rgba(244,63,94,0.55)] hover:shadow-[0_0_36px_-6px_rgba(244,63,94,0.7)]',
    secondary:
      'bg-rose-950/30 border-rose-800/60 hover:border-rose-600 hover:bg-rose-900/40',
    icon: 'text-rose-400 group-hover:text-rose-300',
  },
  system: {
    primary:
      'bg-violet-950/60 border-violet-500/70 hover:border-violet-400 hover:bg-violet-900/60 shadow-[0_0_24px_-8px_rgba(139,92,246,0.55)] hover:shadow-[0_0_36px_-6px_rgba(139,92,246,0.7)]',
    secondary:
      'bg-violet-950/30 border-violet-800/60 hover:border-violet-600 hover:bg-violet-900/40',
    icon: 'text-violet-400 group-hover:text-violet-300',
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
  return (
    <div className="min-h-screen bg-neutral-950">
      <div className="bg-neutral-900 text-white p-6 border-b border-neutral-800">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link to="/admin" className="p-2 hover:bg-neutral-800 rounded-lg transition-colors">
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
          badgeIcon={<ArrowDownCircle size={26} className="text-emerald-300" />}
          badgeColor="bg-emerald-900/60 border border-emerald-500/60"
          cards={IN_CARDS}
        />

        <Section
          tone="out"
          title="OUT"
          description="Costs, labor, waste, and pressure leaving the business."
          badgeIcon={<ArrowUpCircle size={26} className="text-rose-300" />}
          badgeColor="bg-rose-900/60 border border-rose-500/60"
          cards={OUT_CARDS}
        />

        <Section
          tone="system"
          title="SYSTEM"
          description="Reports, connections, controls, and setup."
          badgeIcon={<Settings size={26} className="text-violet-300" />}
          badgeColor="bg-violet-900/60 border border-violet-500/60"
          cards={SYSTEM_CARDS}
        />
      </div>
    </div>
  );
}
