import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useKioskBinding } from '../context/KioskBindingContext';
import {
  listTenantsWithAdminSecret,
  bindKioskWithAdminSecret,
  type AdminTenant,
} from '../lib/kioskApi';

const AdminBindScreen: React.FC = () => {
  const navigate = useNavigate();
  const { bind } = useKioskBinding();
  const [secret, setSecret] = useState('');
  const [tenants, setTenants] = useState<AdminTenant[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onLoadTenants = async () => {
    if (!secret.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const list = await listTenantsWithAdminSecret(secret.trim());
      if (list.length === 0) {
        setError('No active tenants found');
        return;
      }
      setTenants(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load tenants');
    } finally {
      setBusy(false);
    }
  };

  const onBindTenant = async (tenant: AdminTenant) => {
    setBusy(true);
    setError(null);
    try {
      const result = await bindKioskWithAdminSecret(secret.trim(), tenant.id);
      bind(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Bind failed');
      setBusy(false);
    }
  };

  return (
    <div className="h-full w-full bg-neutral-950 text-white flex flex-col p-8 overflow-y-auto">
      <header className="mb-8 flex items-center justify-between">
        <h1 className="text-3xl md:text-4xl font-bold">Super Admin Setup</h1>
        <button
          onClick={() => navigate('/bind')}
          className="px-5 py-3 rounded-xl bg-neutral-800 active:bg-neutral-700 text-base font-semibold touch-manipulation"
        >
          ← Back to PIN
        </button>
      </header>

      {!tenants && (
        <div className="max-w-2xl">
          <p className="text-neutral-400 mb-6">
            Enter the platform <code className="px-1.5 py-0.5 bg-neutral-800 rounded">ADMIN_SECRET</code> to
            list all tenants. Use this for first-time setup or when no employee PIN is available.
          </p>
          <input
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder="ADMIN_SECRET"
            autoComplete="off"
            spellCheck={false}
            className="w-full px-5 py-4 text-xl bg-neutral-900 border-2 border-neutral-800 focus:border-brand-600 rounded-xl outline-none mb-4"
          />
          {error && <p className="text-red-400 mb-4">{error}</p>}
          <button
            onClick={onLoadTenants}
            disabled={busy || !secret.trim()}
            className="w-full px-6 py-4 rounded-xl bg-brand-600 active:bg-brand-700 disabled:bg-neutral-800 disabled:text-neutral-600 text-xl font-bold touch-manipulation"
          >
            {busy ? 'Loading…' : 'Load Tenants'}
          </button>
        </div>
      )}

      {tenants && (
        <div className="flex-1">
          <p className="text-neutral-400 mb-4">Pick a tenant to bind this iPad to:</p>
          {error && <p className="text-red-400 mb-4">{error}</p>}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {tenants.map((t) => (
              <button
                key={t.id}
                onClick={() => onBindTenant(t)}
                disabled={busy}
                className="text-left p-5 rounded-xl bg-neutral-900 border-2 border-neutral-800 active:bg-neutral-800 active:border-brand-600 disabled:opacity-50 touch-manipulation"
              >
                <div className="text-xl font-bold">{t.name}</div>
                {t.subdomain && (
                  <div className="text-sm text-neutral-500 mt-1">
                    {t.subdomain}.desktop.kitchen
                  </div>
                )}
                <div className="text-xs text-neutral-600 mt-2 font-mono">{t.id}</div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default AdminBindScreen;
