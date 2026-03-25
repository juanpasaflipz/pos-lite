import React from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  UtensilsCrossed,
  SlidersHorizontal,
  Package,
  Users,
  BarChart3,
  Printer,
  Truck,
  Shield,
  ClipboardList,
  Heart,
  DollarSign,
  Wallet,
  Palette,
  FileText,
  Plug,
  User,
} from 'lucide-react';
import BrandLogo from '../components/BrandLogo';
import { useAuth } from '../context/AuthContext';

interface AdminLink {
  to: string;
  icon: React.ReactNode;
  label: string;
  description: string;
  adminOnly?: boolean;
}

const ADMIN_LINKS: AdminLink[] = [
  { to: '/admin/menu', icon: <UtensilsCrossed size={24} />, label: 'Menu', description: 'Manage items & categories' },
  { to: '/admin/modifiers', icon: <SlidersHorizontal size={24} />, label: 'Modifiers', description: 'Extras, sizes & add-ons' },
  { to: '/admin/inventory', icon: <Package size={24} />, label: 'Inventory', description: 'Stock levels & alerts' },
  { to: '/admin/employees', icon: <Users size={24} />, label: 'Employees', description: 'Staff & PINs', adminOnly: true },
  { to: '/admin/reports', icon: <BarChart3 size={24} />, label: 'Reports', description: 'Sales & analytics' },
  { to: '/admin/printers', icon: <Printer size={24} />, label: 'Printers', description: 'Receipt & kitchen printers' },
  { to: '/admin/delivery', icon: <Truck size={24} />, label: 'Delivery', description: 'Platform integrations' },
  { to: '/admin/permissions', icon: <Shield size={24} />, label: 'Permissions', description: 'Role access control', adminOnly: true },
  { to: '/admin/purchase-orders', icon: <ClipboardList size={24} />, label: 'Purchase Orders', description: 'Supplier orders' },
  { to: '/admin/loyalty', icon: <Heart size={24} />, label: 'Loyalty', description: 'Rewards & stamp cards' },
  { to: '/admin/expenses', icon: <DollarSign size={24} />, label: 'Expenses', description: 'Track business expenses' },
  { to: '/admin/payroll', icon: <Wallet size={24} />, label: 'Payroll', description: 'Employee wages & payments' },
  { to: '/admin/branding', icon: <Palette size={24} />, label: 'Branding', description: 'Colors, logo & name' },
  { to: '/admin/invoicing', icon: <FileText size={24} />, label: 'Invoicing', description: 'CFDI & invoices' },
  { to: '/admin/integrations', icon: <Plug size={24} />, label: 'Integrations', description: 'Payments & services' },
  { to: '/admin/account', icon: <User size={24} />, label: 'Account', description: 'Plan & billing' },
];

export default function AdminDashboard() {
  const { currentEmployee } = useAuth();
  const isAdmin = currentEmployee?.role === 'admin';

  const links = isAdmin ? ADMIN_LINKS : ADMIN_LINKS.filter(l => !l.adminOnly);

  return (
    <div className="min-h-screen bg-neutral-950">
      <div className="bg-neutral-900 text-white p-6 border-b border-neutral-800">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link to="/pos" className="p-2 hover:bg-neutral-800 rounded-lg transition-colors">
              <ArrowLeft size={24} />
            </Link>
            <h1 className="text-3xl font-black tracking-tighter">Admin</h1>
          </div>
          <BrandLogo className="h-10" />
        </div>
      </div>

      <div className="max-w-5xl mx-auto p-6">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {links.map((link) => (
            <Link
              key={link.to}
              to={link.to}
              className="bg-neutral-900 border border-neutral-800 rounded-xl p-5 hover:bg-neutral-800 hover:border-neutral-700 transition-all group"
            >
              <div className="text-brand-500 mb-3 group-hover:text-brand-400 transition-colors">
                {link.icon}
              </div>
              <div className="text-white font-semibold text-sm">{link.label}</div>
              <div className="text-neutral-500 text-xs mt-1">{link.description}</div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
