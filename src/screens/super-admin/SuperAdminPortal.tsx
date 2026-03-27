import React, { Suspense, useState, useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { verifySecret } from '../../api/superAdmin';

const SuperAdminLogin = React.lazy(() => import('./SuperAdminLogin'));
const SuperAdminLayout = React.lazy(() => import('./SuperAdminLayout'));
const SAOverviewScreen = React.lazy(() => import('./SAOverviewScreen'));
const SATenantsScreen = React.lazy(() => import('./SATenantsScreen'));
const SATenantDetail = React.lazy(() => import('./SATenantDetail'));
const SARevenueScreen = React.lazy(() => import('./SARevenueScreen'));
const SAHealthScreen = React.lazy(() => import('./SAHealthScreen'));
const SADemoConfigScreen = React.lazy(() => import('./SADemoConfigScreen'));
const SASalesRepsScreen = React.lazy(() => import('./SASalesRepsScreen'));
const SAAgentMonitorScreen = React.lazy(() => import('./SAAgentMonitorScreen'));
const SAAlertsScreen = React.lazy(() => import('./SAAlertsScreen'));

export default function SuperAdminPortal() {
  const [authed, setAuthed] = useState<boolean | null>(null);

  useEffect(() => {
    const secret = sessionStorage.getItem('admin_secret');
    if (!secret) { setAuthed(false); return; }
    verifySecret().then(ok => setAuthed(ok)).catch(() => setAuthed(false));
  }, []);

  if (authed === null) return <div className="min-h-screen flex items-center justify-center bg-neutral-950"><div className="text-xl text-brand-600 animate-pulse">Loading...</div></div>;

  if (!authed) return <Suspense fallback={null}><SuperAdminLogin onAuth={() => setAuthed(true)} /></Suspense>;

  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center bg-neutral-950"><div className="text-xl text-brand-600 animate-pulse">Loading...</div></div>}>
      <SuperAdminLayout>
        <Routes>
          <Route path="/" element={<SAOverviewScreen />} />
          <Route path="/tenants" element={<SATenantsScreen />} />
          <Route path="/tenants/:id" element={<SATenantDetail />} />
          <Route path="/revenue" element={<SARevenueScreen />} />
          <Route path="/health" element={<SAHealthScreen />} />
          <Route path="/demo" element={<SADemoConfigScreen />} />
          <Route path="/sales-reps" element={<SASalesRepsScreen />} />
          <Route path="/monitoring" element={<SAAgentMonitorScreen />} />
          <Route path="/alerts" element={<SAAlertsScreen />} />
          <Route path="*" element={<Navigate to="/super-admin" replace />} />
        </Routes>
      </SuperAdminLayout>
    </Suspense>
  );
}
