import React, { Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { SalesAuthProvider, useSalesAuth } from '../../context/SalesAuthContext';

const SalesLoginScreen = React.lazy(() => import('./SalesLoginScreen'));
const SalesLayout = React.lazy(() => import('./SalesLayout'));
const SalesDashboard = React.lazy(() => import('./SalesDashboard'));
const SalesLeadsScreen = React.lazy(() => import('./SalesLeadsScreen'));
const SalesLeadDetail = React.lazy(() => import('./SalesLeadDetail'));
const SalesClientsScreen = React.lazy(() => import('./SalesClientsScreen'));
const SalesClientDetail = React.lazy(() => import('./SalesClientDetail'));
const SalesOnboardWizard = React.lazy(() => import('./SalesOnboardWizard'));
const SalesCommissions = React.lazy(() => import('./SalesCommissions'));
const SalesLeaderboard = React.lazy(() => import('./SalesLeaderboard'));
const SalesTeamManager = React.lazy(() => import('./SalesTeamManager'));
const SalesDemoAccess = React.lazy(() => import('./SalesDemoAccess'));

function SalesRoutes() {
  const { rep, loading } = useSalesAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-neutral-950">
        <div className="text-xl text-brand-600 animate-pulse">Loading...</div>
      </div>
    );
  }

  if (!rep) return <SalesLoginScreen />;

  return (
    <SalesLayout>
      <Routes>
        <Route path="/" element={<SalesDashboard />} />
        <Route path="/leads" element={<SalesLeadsScreen />} />
        <Route path="/leads/:id" element={<SalesLeadDetail />} />
        <Route path="/clients" element={<SalesClientsScreen />} />
        <Route path="/clients/:tenantId" element={<SalesClientDetail />} />
        <Route path="/onboard" element={<SalesOnboardWizard />} />
        <Route path="/commissions" element={<SalesCommissions />} />
        <Route path="/leaderboard" element={<SalesLeaderboard />} />
        <Route path="/team" element={<SalesTeamManager />} />
        <Route path="/demo" element={<SalesDemoAccess />} />
        <Route path="*" element={<Navigate to="/sales" replace />} />
      </Routes>
    </SalesLayout>
  );
}

export default function SalesPortal() {
  return (
    <SalesAuthProvider>
      <Suspense
        fallback={
          <div className="min-h-screen flex items-center justify-center bg-neutral-950">
            <div className="text-xl text-brand-600 animate-pulse">Loading...</div>
          </div>
        }
      >
        <SalesRoutes />
      </Suspense>
    </SalesAuthProvider>
  );
}
