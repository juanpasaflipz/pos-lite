import React, { useMemo, useState, useEffect, useCallback } from 'react';
import {
  HashRouter as Router,
  Routes,
  Route,
  Navigate,
  useLocation,
} from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AuthProvider, useAuth } from './context/AuthContext';
import { SyncProvider } from './context/SyncContext';
import { BrandingProvider } from './context/BrandingContext';
import { PlanProvider, usePlan } from './context/PlanContext';
import { ThemeProvider } from './context/ThemeContext';
import { ToastProvider } from './context/ToastContext';
import { resolveTenant, type TenantInfo } from './lib/tenantResolver';
import { useDeviceType } from './hooks/useDeviceType';
import { MobileCartProvider } from './context/MobileCartContext';
import ErrorBoundary from './components/ErrorBoundary';
import IdleLogoutGuard from './components/IdleLogoutGuard';
import { getDeviceToken } from './api';

// ==================== Lazy-loaded Screens (Lean POS) ====================

const LoginScreen = React.lazy(() => import('./screens/LoginScreen').then(m => ({ default: m.default || (() => <div>Login</div>) })));
const POSScreen = React.lazy(() => import('./screens/POSScreen').then(m => ({ default: m.default || (() => <div>POS</div>) })));
const KitchenDisplay = React.lazy(() => import('./screens/KitchenDisplay').then(m => ({ default: m.default || (() => <div>Kitchen</div>) })));
const InventoryScreen = React.lazy(() => import('./screens/InventoryScreen').then(m => ({ default: m.default || (() => <div>Inventory</div>) })));
const StaffHubScreen = React.lazy(() => import('./screens/StaffHubScreen').then(m => ({ default: m.default || (() => <div>Staff</div>) })));
const ReportsScreen = React.lazy(() => import('./screens/ReportsScreen').then(m => ({ default: m.default || (() => <div>Reports</div>) })));
const MenuManagement = React.lazy(() => import('./screens/MenuManagement').then(m => ({ default: m.default || (() => <div>Menu</div>) })));
const ModifierManagement = React.lazy(() => import('./screens/ModifierManagement').then(m => ({ default: m.default || (() => <div>Modifiers</div>) })));
const PrinterManagement = React.lazy(() => import('./screens/PrinterManagement').then(m => ({ default: m.default || (() => <div>Printers</div>) })));
const DeliveryScreen = React.lazy(() => import('./screens/DeliveryScreen').then(m => ({ default: m.default || (() => <div>Delivery</div>) })));
const PermissionsScreen = React.lazy(() => import('./screens/PermissionsScreen').then(m => ({ default: m.default || (() => <div>Permissions</div>) })));
const PurchaseOrderScreen = React.lazy(() => import('./screens/PurchaseOrderScreen').then(m => ({ default: m.default || (() => <div>Purchase Orders</div>) })));
const LoyaltyScreen = React.lazy(() => import('./screens/LoyaltyScreen').then(m => ({ default: m.default || (() => <div>Loyalty</div>) })));
const OnboardingScreen = React.lazy(() => import('./screens/OnboardingScreen').then(m => ({ default: m.default || (() => <div>Onboarding</div>) })));
const CustomerOrderScreen = React.lazy(() => import('./screens/CustomerOrderScreen').then(m => ({ default: m.default || (() => <div>Order</div>) })));
const MenuBoardScreen = React.lazy(() => import('./screens/MenuBoardScreen').then(m => ({ default: m.default || (() => <div>Menu Board</div>) })));
const BrandingSettingsScreen = React.lazy(() => import('./screens/BrandingSettingsScreen').then(m => ({ default: m.default || (() => <div>Branding</div>) })));
const DisplayMenuScreen = React.lazy(() => import('./screens/DisplayMenuScreen').then(m => ({ default: m.default || (() => <div>Display Menu</div>) })));
const InvoicingScreen = React.lazy(() => import('./screens/InvoicingScreen').then(m => ({ default: m.default || (() => <div>Invoicing</div>) })));
const PublicInvoiceScreen = React.lazy(() => import('./screens/PublicInvoiceScreen').then(m => ({ default: m.default || (() => <div>Invoice</div>) })));
const PublicReceiptScreen = React.lazy(() => import('./screens/PublicReceiptScreen').then(m => ({ default: m.default || (() => <div>Receipt</div>) })));
const LoyaltyJoinScreen = React.lazy(() => import('./screens/LoyaltyJoinScreen').then(m => ({ default: m.default || (() => <div>Loyalty Join</div>) })));
const ResetPasswordScreen = React.lazy(() => import('./screens/ResetPasswordScreen').then(m => ({ default: m.default || (() => <div>Reset Password</div>) })));
const AccountScreen = React.lazy(() => import('./screens/AccountScreen').then(m => ({ default: m.default || (() => <div>Account</div>) })));
const IntegrationsScreen = React.lazy(() => import('./screens/IntegrationsScreen').then(m => ({ default: m.default || (() => <div>Integrations</div>) })));
const ExpensesScreen = React.lazy(() => import('./screens/ExpensesScreen').then(m => ({ default: m.default || (() => <div>Expenses</div>) })));
const RecipeManagementScreen = React.lazy(() => import('./screens/RecipeManagementScreen').then(m => ({ default: m.default || (() => <div>Recipes</div>) })));
const OwnerCockpitScreen = React.lazy(() => import('./screens/OwnerCockpitScreen').then(m => ({ default: m.default || (() => <div>Cockpit</div>) })));
const OrdersScreen = React.lazy(() => import('./screens/OrdersScreen').then(m => ({ default: m.default || (() => <div>Orders</div>) })));
const SuperAdmin = React.lazy(() => import('./screens/SuperAdmin').then(m => ({ default: m.default })));
const OrgDashboard = React.lazy(() => import('./screens/OrgDashboard').then(m => ({ default: m.default })));
const QRMenuScreen = React.lazy(() => import('./screens/QRMenuScreen').then(m => ({ default: m.default || (() => <div>QR Menu</div>) })));
const KioskAccessScreen = React.lazy(() => import('./screens/KioskAccessScreen').then(m => ({ default: m.default || (() => <div>Kiosk</div>) })));
const KitchenPairScreen = React.lazy(() => import('./screens/KitchenPairScreen').then(m => ({ default: m.default || (() => <div>Pair</div>) })));
const DevicesScreen = React.lazy(() => import('./screens/DevicesScreen').then(m => ({ default: m.default || (() => <div>Devices</div>) })));

// AI Agent
const AgentChat = React.lazy(() => import('./components/agent/AgentChat').then(m => ({ default: m.default })));

// Mobile
const MobileShell = React.lazy(() => import('./components/mobile/MobileShell').then(m => ({ default: m.default })));
const MobileOrdersScreen = React.lazy(() => import('./screens/mobile/MobileOrdersScreen').then(m => ({ default: m.default })));
const MobileKitchenScreen = React.lazy(() => import('./screens/mobile/MobileKitchenScreen').then(m => ({ default: m.default })));
const MobileScannerScreen = React.lazy(() => import('./screens/mobile/MobileScannerScreen').then(m => ({ default: m.default })));
const MobileProfileScreen = React.lazy(() => import('./screens/mobile/MobileProfileScreen').then(m => ({ default: m.default })));
const MobilePOSScreen = React.lazy(() => import('./screens/mobile/MobilePOSScreen').then(m => ({ default: m.default })));
const MobileCartScreen = React.lazy(() => import('./screens/mobile/MobileCartScreen').then(m => ({ default: m.default })));

/* ==================== Tenant Context ==================== */

const TenantContext = React.createContext<TenantInfo>({
  mode: 'local',
  tenantSlug: null,
  isPlatformHost: false,
});

export const useTenant = () => React.useContext(TenantContext);

/* ==================== Protected Route ==================== */

// Per-role landing route. Kitchen/bar staff go to KDS; everyone else POS.
// Used both for post-login navigation and role-mismatch redirects, so a
// kitchen employee hitting /pos doesn't get bounced back to /pos (loop).
const landingForRole = (role: string): string =>
  role === 'kitchen' || role === 'bar' ? '/kitchen' : '/pos';

interface ProtectedRouteProps {
  element: React.ReactNode;
  requiredRole?: string[];
  // When true, a paired-device JWT in localStorage is accepted as auth —
  // skips the role check entirely (the device IS the role).
  allowDeviceToken?: boolean;
  // Where to send an unauthenticated user. Defaults to '/'.
  unauthRedirect?: string;
}

const ProtectedRoute: React.FC<ProtectedRouteProps> = ({
  element,
  requiredRole,
  allowDeviceToken = false,
  unauthRedirect = '/',
}) => {
  const { currentEmployee } = useAuth();
  if (allowDeviceToken && getDeviceToken()) return <>{element}</>;
  if (!currentEmployee) return <Navigate to={unauthRedirect} replace />;
  if (requiredRole && !requiredRole.includes(currentEmployee.role)) return <Navigate to={landingForRole(currentEmployee.role)} replace />;
  return <>{element}</>;
};

/* ==================== Loading Fallback ==================== */

const LoadingFallback: React.FC = () => {
  const { t } = useTranslation();
  return (
    <div className="min-h-screen flex items-center justify-center bg-neutral-950">
      <div className="text-2xl text-brand-600 font-bold animate-pulse">{t('states.loading')}</div>
    </div>
  );
};

/* ==================== Tenant Routes ==================== */

const PUBLIC_PATHS = ['/order', '/invoice/', '/menu-board'];

const TenantRoutes: React.FC = () => {
  const { currentEmployee } = useAuth();
  const { deviceType } = useDeviceType();

  const hashPath = window.location.hash.replace('#', '') || '/';
  const isPublicRoute = PUBLIC_PATHS.some(p => hashPath.startsWith(p));

  // Phone + authenticated → mobile POS
  if (deviceType === 'phone' && currentEmployee && !isPublicRoute) {
    return (
      <MobileCartProvider>
        <MobileShell>
          <Routes>
            <Route path="/m/pos" element={<MobilePOSScreen />} />
            <Route path="/m/cart" element={<MobileCartScreen />} />
            <Route path="/m/orders" element={<MobileOrdersScreen />} />
            <Route path="/m/kitchen" element={<MobileKitchenScreen />} />
            <Route path="/m/scan" element={<ProtectedRoute element={<MobileScannerScreen />} requiredRole={['manager', 'admin']} />} />
            <Route path="/m/profile" element={<MobileProfileScreen />} />
            <Route path="*" element={<Navigate to="/m/pos" replace />} />
          </Routes>
        </MobileShell>
      </MobileCartProvider>
    );
  }

  return (
    <Routes>
      {/* Auth */}
      <Route path="/" element={<LoginScreen />} />
      <Route path="/onboarding" element={<OnboardingScreen />} />
      <Route path="/reset-password" element={<ResetPasswordScreen />} />

      {/* POS */}
      <Route path="/pos" element={<ProtectedRoute element={<POSScreen />} requiredRole={['cashier', 'manager', 'admin']} />} />
      {/* KDS is intentionally open: typing on a TV remote is awful, so
          /#/kitchen must Just Work the moment the URL loads. Pairing
          (/#/kitchen-pair) is opt-in for managers who want to track and
          revoke specific devices from /admin/devices. */}
      <Route path="/kitchen" element={<KitchenDisplay />} />
      <Route path="/kitchen-pair" element={<KitchenPairScreen />} />

      {/* Admin */}
      <Route path="/admin" element={<Navigate to="/admin/cockpit" replace />} />
      <Route path="/admin/cockpit" element={<ProtectedRoute element={<OwnerCockpitScreen />} requiredRole={['manager', 'admin']} />} />
      <Route path="/admin/menu" element={<ProtectedRoute element={<MenuManagement />} requiredRole={['manager', 'admin']} />} />
      <Route path="/admin/recipes" element={<ProtectedRoute element={<RecipeManagementScreen />} requiredRole={['manager', 'admin']} />} />
      <Route path="/admin/modifiers" element={<ProtectedRoute element={<ModifierManagement />} requiredRole={['manager', 'admin']} />} />
      <Route path="/admin/inventory" element={<ProtectedRoute element={<InventoryScreen />} requiredRole={['manager', 'admin']} />} />
      <Route path="/admin/staff" element={<ProtectedRoute element={<StaffHubScreen />} requiredRole={['manager', 'admin']} />} />
      {/* Legacy deep-links — redirect to the new Staff hub */}
      <Route path="/admin/employees" element={<Navigate to="/admin/staff?tab=roster" replace />} />
      <Route path="/admin/shifts" element={<Navigate to="/admin/staff?tab=timeclock" replace />} />
      <Route path="/admin/payroll" element={<Navigate to="/admin/staff?tab=payroll" replace />} />
      <Route path="/admin/reports" element={<ProtectedRoute element={<ReportsScreen />} requiredRole={['manager', 'admin']} />} />
      <Route path="/admin/orders" element={<ProtectedRoute element={<OrdersScreen />} requiredRole={['cashier', 'manager', 'admin']} />} />
      <Route path="/admin/printers" element={<ProtectedRoute element={<PrinterManagement />} requiredRole={['manager', 'admin']} />} />
      <Route path="/admin/delivery" element={<ProtectedRoute element={<DeliveryScreen />} requiredRole={['manager', 'admin']} />} />
      <Route path="/admin/permissions" element={<ProtectedRoute element={<PermissionsScreen />} requiredRole={['admin']} />} />
      <Route path="/admin/purchase-orders" element={<ProtectedRoute element={<PurchaseOrderScreen />} requiredRole={['manager', 'admin']} />} />
      <Route path="/admin/loyalty" element={<ProtectedRoute element={<LoyaltyScreen />} requiredRole={['manager', 'admin']} />} />
      <Route path="/admin/expenses" element={<ProtectedRoute element={<ExpensesScreen />} requiredRole={['manager', 'admin']} />} />
      <Route path="/admin/branding" element={<ProtectedRoute element={<BrandingSettingsScreen />} requiredRole={['manager', 'admin']} />} />
      <Route path="/admin/display-menu" element={<ProtectedRoute element={<DisplayMenuScreen />} requiredRole={['manager', 'admin']} />} />
      <Route path="/admin/qr-menu" element={<ProtectedRoute element={<QRMenuScreen />} requiredRole={['manager', 'admin']} />} />
      <Route path="/admin/kiosk" element={<ProtectedRoute element={<KioskAccessScreen />} requiredRole={['manager', 'admin']} />} />
      <Route path="/admin/invoicing" element={<ProtectedRoute element={<InvoicingScreen />} requiredRole={['manager', 'admin']} />} />
      <Route path="/admin/integrations" element={<ProtectedRoute element={<IntegrationsScreen />} requiredRole={['manager', 'admin']} />} />
      <Route path="/admin/devices" element={<ProtectedRoute element={<DevicesScreen />} requiredRole={['manager', 'admin']} />} />
      <Route path="/admin/account" element={<ProtectedRoute element={<AccountScreen />} />} />

      {/* Super Admin (platform owner only — gated by ADMIN_SECRET) */}
      <Route path="/super-admin" element={<SuperAdmin />} />

      {/* Corporate dashboard (multi-store orgs — own JWT login, see routes/org.js) */}
      <Route path="/org" element={<OrgDashboard />} />

      {/* Public */}
      <Route path="/order" element={<CustomerOrderScreen />} />
      <Route path="/menu-board" element={<MenuBoardScreen />} />
      <Route path="/invoice/:token" element={<PublicInvoiceScreen />} />
      <Route path="/r/:token" element={<PublicReceiptScreen />} />
      <Route path="/loyalty/join/:token" element={<LoyaltyJoinScreen />} />

      {/* Fallback */}
      <Route path="*" element={<Navigate to={currentEmployee ? landingForRole(currentEmployee.role) : '/'} replace />} />
    </Routes>
  );
};

/* ==================== Agent FAB ==================== */

// Routes where the admin AI Co-Pilot FAB must NEVER appear — customer-facing
// (kiosk order, menu board, public invoice/receipt, loyalty-join QR landing)
// and the shared kitchen display / login flows. Everything else that renders
// after a manager/admin login is fair game.
const AGENT_FAB_HIDDEN_PATHS = [
  '/', '/onboarding', '/reset-password',
  '/order', '/menu-board',
  '/invoice/', '/r/', '/loyalty/join/',
  '/kitchen', '/kitchen-pair',
  '/org', '/super-admin',
];

const AgentFAB: React.FC = () => {
  const { currentEmployee } = useAuth();
  const { isFeatureLocked } = usePlan();
  const location = useLocation();
  const [agentOpen, setAgentOpen] = useState(false);

  // Only show for managers and admins on desktop, and only for Pro users
  if (!currentEmployee || !['manager', 'admin'].includes(currentEmployee.role)) return null;
  if (isFeatureLocked('ai')) return null;
  const path = location.pathname || '/';
  if (AGENT_FAB_HIDDEN_PATHS.some(p => p === '/' ? path === '/' : path.startsWith(p))) return null;

  return (
    <>
      {/* Floating Action Button */}
      {!agentOpen && (
        <button
          onClick={() => setAgentOpen(true)}
          className="fixed bottom-6 right-6 z-40 w-14 h-14 rounded-full bg-brand-600 hover:bg-brand-500 text-white shadow-lg hover:shadow-xl transition-all flex items-center justify-center group"
          title="Open AI Co-Pilot"
        >
          <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z" />
          </svg>
          <span className="absolute right-full mr-3 px-2 py-1 rounded-md bg-neutral-800 text-white text-xs whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
            AI Co-Pilot
          </span>
        </button>
      )}

      {/* Agent Chat Panel */}
      <React.Suspense fallback={null}>
        <AgentChat isOpen={agentOpen} onClose={() => setAgentOpen(false)} />
      </React.Suspense>
    </>
  );
};

/* ==================== Demo Token Auto-Login ==================== */

const DemoTokenHandler: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const demoToken = params.get('demo_token');
    if (!demoToken) { setReady(true); return; }

    // Exchange demo_token for JWT via API
    (async () => {
      try {
        const res = await fetch('/api/demo/demo-login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ demo_token: demoToken }),
        });
        if (res.ok) {
          const data = await res.json();
          // Store for AuthProvider to pick up
          localStorage.setItem('demo_employee', JSON.stringify({
            id: data.employee.id,
            name: data.employee.name,
            role: data.employee.role,
            active: true,
            permissions: [],
            token: data.employee_token,
          }));
          if (data.owner_token) {
            localStorage.setItem('owner_token', data.owner_token);
          }
        }
      } catch { /* proceed to login screen */ }
      // Strip demo_token from URL and reload to let AuthProvider read localStorage
      window.location.replace(window.location.pathname + '#/pos');
    })();
  }, []);

  if (!ready) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-neutral-950">
        <div className="text-xl text-brand-600 font-bold animate-pulse">Setting up your account...</div>
      </div>
    );
  }

  return <>{children}</>;
};

/* ==================== App Content ==================== */

const AppContent: React.FC = () => {
  const tenantInfo = useMemo(() => resolveTenant(), []);

  return (
    <TenantContext.Provider value={tenantInfo}>
      <Router>
        <ErrorBoundary>
          <React.Suspense fallback={<LoadingFallback />}>
            <TenantRoutes />
          </React.Suspense>
        </ErrorBoundary>
        <IdleLogoutGuard />
        <AgentFAB />
      </Router>
    </TenantContext.Provider>
  );
};

export default function App() {
  return (
    <DemoTokenHandler>
      <ThemeProvider>
        <BrandingProvider>
          <PlanProvider>
            <ToastProvider>
              <AuthProvider>
                <SyncProvider>
                  <AppContent />
                </SyncProvider>
              </AuthProvider>
            </ToastProvider>
          </PlanProvider>
        </BrandingProvider>
      </ThemeProvider>
    </DemoTokenHandler>
  );
}
