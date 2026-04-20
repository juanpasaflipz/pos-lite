import React from 'react';
import { useAdminAuth } from './useAdminAuth';
import SuperAdminLogin from './SuperAdminLogin';
import SuperAdminDashboard from './SuperAdminDashboard';

const SuperAdmin: React.FC = () => {
  const { state, signIn, signOut } = useAdminAuth();

  if (state === 'checking') {
    return (
      <div className="min-h-screen bg-neutral-950 flex items-center justify-center">
        <div className="text-brand-600 font-semibold animate-pulse">Verifying...</div>
      </div>
    );
  }

  if (state === 'unauthenticated') {
    return <SuperAdminLogin onSignIn={signIn} />;
  }

  return <SuperAdminDashboard onSignOut={signOut} />;
};

export default SuperAdmin;
