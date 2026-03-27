import React, { useEffect, useState } from 'react';
import { RefreshCw, Play, Trash2 } from 'lucide-react';

interface DemoTenantStatus {
  configured: boolean;
  tenant_id?: string;
  name?: string;
  active?: boolean;
  demo_token?: string;
  url?: string;
}

function getSecret(): string {
  return sessionStorage.getItem('admin_secret') || '';
}

async function fetchDemoStatus(): Promise<DemoTenantStatus> {
  const res = await fetch('/admin/demo-tenant/status', {
    headers: { 'x-admin-secret': getSecret() },
  });
  if (!res.ok) throw new Error(`Error: ${res.status}`);
  return res.json();
}

async function setupDemoTenant(): Promise<any> {
  const res = await fetch('/admin/demo-tenant/setup', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-admin-secret': getSecret(),
    },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Error: ${res.status}`);
  }
  return res.json();
}

async function resetDemoTenant(): Promise<any> {
  const res = await fetch('/admin/demo-tenant/reset', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-admin-secret': getSecret(),
    },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Error: ${res.status}`);
  }
  return res.json();
}

export default function SADemoConfigScreen() {
  const [status, setStatus] = useState<DemoTenantStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');

  const loadStatus = async () => {
    setLoading(true);
    setError('');
    try {
      const data = await fetchDemoStatus();
      setStatus(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadStatus();
  }, []);

  const flash = (text: string) => {
    setMsg(text);
    setTimeout(() => setMsg(''), 4000);
  };

  const handleSetup = async () => {
    setActionLoading(true);
    try {
      await setupDemoTenant();
      flash('Demo tenant set up successfully');
      await loadStatus();
    } catch (err: any) {
      flash(`Setup failed: ${err.message}`);
    } finally {
      setActionLoading(false);
    }
  };

  const handleReset = async () => {
    if (!confirm('Reset the demo tenant? This will wipe all demo data and recreate defaults.')) return;
    setActionLoading(true);
    try {
      await resetDemoTenant();
      flash('Demo tenant reset successfully');
      await loadStatus();
    } catch (err: any) {
      flash(`Reset failed: ${err.message}`);
    } finally {
      setActionLoading(false);
    }
  };

  if (loading && !status) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-neutral-400 animate-pulse">Loading demo config...</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-black text-white tracking-tight">Demo Config</h2>
        {msg && (
          <span className="text-sm text-green-400 bg-green-400/10 px-3 py-1 rounded-lg">{msg}</span>
        )}
      </div>

      {error && <p className="text-red-400 text-sm">{error}</p>}

      {/* Status Card */}
      <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6">
        <h3 className="text-white font-semibold mb-4">Demo Tenant Status</h3>

        {!status?.configured ? (
          <div className="space-y-4">
            <p className="text-neutral-400 text-sm">
              No demo tenant is configured. Set one up to enable the demo login flow.
            </p>
            <button
              onClick={handleSetup}
              disabled={actionLoading}
              className="flex items-center gap-2 px-4 py-2.5 bg-brand-600 hover:bg-brand-500 disabled:opacity-50 text-white text-sm font-semibold rounded-lg transition-colors"
            >
              <Play size={16} />
              {actionLoading ? 'Setting up...' : 'Setup Demo Tenant'}
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="bg-neutral-800/50 rounded-lg p-3">
                <p className="text-neutral-400 text-xs">Tenant ID</p>
                <p className="text-white text-sm font-mono mt-0.5">{status.tenant_id}</p>
              </div>
              <div className="bg-neutral-800/50 rounded-lg p-3">
                <p className="text-neutral-400 text-xs">Name</p>
                <p className="text-white text-sm mt-0.5">{status.name || '-'}</p>
              </div>
              <div className="bg-neutral-800/50 rounded-lg p-3">
                <p className="text-neutral-400 text-xs">Active</p>
                <p className={`text-sm mt-0.5 font-medium ${status.active ? 'text-green-400' : 'text-red-400'}`}>
                  {status.active ? 'Yes' : 'No'}
                </p>
              </div>
              {status.demo_token && (
                <div className="bg-neutral-800/50 rounded-lg p-3">
                  <p className="text-neutral-400 text-xs">Demo Token</p>
                  <p className="text-white text-sm font-mono mt-0.5 truncate">{status.demo_token}</p>
                </div>
              )}
              {status.url && (
                <div className="bg-neutral-800/50 rounded-lg p-3 sm:col-span-2">
                  <p className="text-neutral-400 text-xs">Demo URL</p>
                  <a
                    href={status.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-brand-400 hover:text-brand-300 text-sm font-mono mt-0.5 break-all"
                  >
                    {status.url}
                  </a>
                </div>
              )}
            </div>

            <div className="flex gap-3 pt-2">
              <button
                onClick={handleReset}
                disabled={actionLoading}
                className="flex items-center gap-2 px-4 py-2 bg-neutral-800 hover:bg-neutral-700 disabled:opacity-50 text-white text-sm rounded-lg transition-colors"
              >
                <RefreshCw size={14} className={actionLoading ? 'animate-spin' : ''} />
                {actionLoading ? 'Resetting...' : 'Reset Demo Tenant'}
              </button>
              <button
                onClick={loadStatus}
                disabled={loading}
                className="flex items-center gap-2 px-4 py-2 bg-neutral-800 hover:bg-neutral-700 disabled:opacity-50 text-white text-sm rounded-lg transition-colors"
              >
                <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
                Refresh Status
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
