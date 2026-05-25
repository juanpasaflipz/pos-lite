import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, X, RefreshCw, ExternalLink } from 'lucide-react';
import {
  getTenants,
  getTenantDeepDive,
  patchTenant,
  createTenant,
  resetTenantPassword,
  type TenantRecord,
  type DeepDiveData,
  type CreateTenantPayload,
} from '../../../api/superAdmin';

const fmtCurrency = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n ?? 0);
const fmtNumber = (n: number) => new Intl.NumberFormat('en-US').format(n ?? 0);
const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—';

type Filter = 'all' | 'free' | 'pro';

const TenantsTab: React.FC = () => {
  const { t } = useTranslation('superAdmin');
  const [tenants, setTenants] = useState<TenantRecord[] | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState<TenantRecord | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setError(null);
    getTenants()
      .then(setTenants)
      .catch((e) => setError(e.message));
  };

  useEffect(load, []);

  const filtered = useMemo(() => {
    if (!tenants) return [];
    const q = search.trim().toLowerCase();
    return tenants.filter((t) => {
      if (filter !== 'all' && t.plan !== filter) return false;
      if (!q) return true;
      return (
        t.name.toLowerCase().includes(q) ||
        t.id.toLowerCase().includes(q) ||
        t.owner_email?.toLowerCase().includes(q)
      );
    });
  }, [tenants, search, filter]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row gap-3 sm:items-center justify-between">
        <div className="flex gap-2 flex-1 max-w-2xl">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('tenants.searchPlaceholder')}
            className="flex-1 px-3 py-2 bg-neutral-900 border border-neutral-800 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:border-brand-600"
          />
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as Filter)}
            className="px-3 py-2 bg-neutral-900 border border-neutral-800 rounded-lg text-white focus:outline-none focus:border-brand-600"
          >
            <option value="all">{t('tenants.allPlans')}</option>
            <option value="free">{t('tenants.free')}</option>
            <option value="pro">{t('tenants.pro')}</option>
          </select>
        </div>
        <div className="flex gap-2">
          <button
            onClick={load}
            className="px-3 py-2 bg-neutral-900 border border-neutral-800 rounded-lg text-neutral-300 hover:bg-neutral-800 transition flex items-center gap-2"
            title="Refresh"
          >
            <RefreshCw size={16} />
          </button>
          <button
            onClick={() => setShowCreate(true)}
            className="px-4 py-2 bg-brand-600 hover:bg-brand-500 text-white rounded-lg font-semibold flex items-center gap-2 transition"
          >
            <Plus size={18} /> {t('tenants.createTenant')}
          </button>
        </div>
      </div>

      {error && <div className="text-cockpit-red">{error}</div>}

      {!tenants ? (
        <div className="text-neutral-400">{t('tenants.loading')}</div>
      ) : filtered.length === 0 ? (
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-8 text-center text-neutral-500">
          {t('tenants.noTenants')}
        </div>
      ) : (
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-neutral-950 border-b border-neutral-800">
              <tr className="text-left text-xs uppercase tracking-wider text-neutral-500">
                <th className="px-4 py-3">{t('tenants.columns.name')}</th>
                <th className="px-4 py-3">{t('tenants.columns.plan')}</th>
                <th className="px-4 py-3">{t('tenants.columns.status')}</th>
                <th className="px-4 py-3 text-right">{t('tenants.columns.orders')}</th>
                <th className="px-4 py-3 text-right">{t('tenants.columns.employees')}</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => (
                <tr
                  key={row.id}
                  onClick={() => setSelected(row)}
                  className="border-b border-neutral-800 hover:bg-neutral-800/50 cursor-pointer transition"
                >
                  <td className="px-4 py-3">
                    <div className="font-medium text-white">{row.name}</div>
                    <div className="text-xs text-neutral-500">{row.subdomain || row.id} · {row.owner_email}</div>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`px-2 py-0.5 rounded text-xs font-semibold ${
                        row.plan === 'pro' ? 'bg-brand-900/50 text-brand-300' : 'bg-neutral-800 text-neutral-400'
                      }`}
                    >
                      {row.plan}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`px-2 py-0.5 rounded text-xs font-semibold ${
                        row.active ? 'bg-cockpit-green/40 text-cockpit-green' : 'bg-cockpit-red/40 text-cockpit-red'
                      }`}
                    >
                      {row.active ? t('tenants.active') : t('tenants.inactive')}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right text-neutral-300">{fmtNumber(row.order_count)}</td>
                  <td className="px-4 py-3 text-right text-neutral-300">{fmtNumber(row.employee_count)}</td>
                  <td className="px-4 py-3 text-right">
                    <a
                      href={`https://${row.subdomain || row.id}.desktop.kitchen`}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="text-neutral-500 hover:text-brand-400 inline-flex"
                      title="Open subdomain"
                    >
                      <ExternalLink size={14} />
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <TenantDrawer
          tenant={selected}
          onClose={() => setSelected(null)}
          onChanged={() => {
            load();
            setSelected(null);
          }}
        />
      )}

      {showCreate && (
        <CreateTenantModal
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            load();
          }}
        />
      )}
    </div>
  );
};

/* ==================== Tenant Detail Drawer ==================== */

const TenantDrawer: React.FC<{
  tenant: TenantRecord;
  onClose: () => void;
  onChanged: () => void;
}> = ({ tenant, onClose, onChanged }) => {
  const { t } = useTranslation('superAdmin');
  const [data, setData] = useState<DeepDiveData | null>(null);
  const [busy, setBusy] = useState(false);
  const [showPasswordReset, setShowPasswordReset] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    getTenantDeepDive(tenant.id)
      .then(setData)
      .catch((e) => setMsg(e.message));
  }, [tenant.id]);

  const toggleActive = async () => {
    setBusy(true);
    try {
      await patchTenant(tenant.id, { active: !tenant.active });
      onChanged();
    } catch (e: any) {
      setMsg(e.message || t('tenants.failedToggleStatus'));
    } finally {
      setBusy(false);
    }
  };

  const changePlan = async (plan: string) => {
    setBusy(true);
    try {
      await patchTenant(tenant.id, { plan });
      onChanged();
    } catch (e: any) {
      setMsg(e.message || t('tenants.failedUpdatePlan'));
    } finally {
      setBusy(false);
    }
  };

  const handleResetPassword = async () => {
    if (newPassword.length < 8) return;
    setBusy(true);
    try {
      await resetTenantPassword(tenant.id, newPassword);
      setMsg(t('tenantManagement.passwordReset'));
      setShowPasswordReset(false);
      setNewPassword('');
    } catch (e: any) {
      setMsg(e.message || t('tenants.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/60" onClick={onClose} />
      <div className="w-full max-w-xl bg-neutral-900 border-l border-neutral-800 overflow-y-auto">
        <div className="sticky top-0 bg-neutral-900 border-b border-neutral-800 px-6 py-4 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-white">{tenant.name}</h2>
            <p className="text-xs text-neutral-500">{tenant.id} · {t('tenants.joined')} {fmtDate(tenant.created_at)}</p>
          </div>
          <button onClick={onClose} className="text-neutral-400 hover:text-white">
            <X size={20} />
          </button>
        </div>

        <div className="p-6 space-y-6">
          {msg && <div className="px-3 py-2 bg-brand-900/30 border border-brand-800 rounded text-brand-300 text-sm">{msg}</div>}

          {/* Controls */}
          <div className="flex flex-wrap gap-2">
            <select
              value={tenant.plan}
              onChange={(e) => changePlan(e.target.value)}
              disabled={busy}
              className="px-3 py-2 bg-neutral-950 border border-neutral-800 rounded text-white text-sm"
            >
              <option value="free">{t('tenants.free')}</option>
              <option value="pro">{t('tenants.pro')}</option>
            </select>
            <button
              onClick={toggleActive}
              disabled={busy}
              className={`px-3 py-2 rounded text-sm font-semibold ${
                tenant.active ? 'bg-cockpit-red/40 text-cockpit-red hover:bg-cockpit-red/60' : 'bg-cockpit-green/40 text-cockpit-green hover:bg-cockpit-green/60'
              } disabled:opacity-50`}
            >
              {tenant.active ? t('tenants.deactivate') : t('tenants.activate')}
            </button>
            <button
              onClick={() => setShowPasswordReset(true)}
              disabled={busy}
              className="px-3 py-2 bg-neutral-800 hover:bg-neutral-700 text-neutral-200 rounded text-sm font-semibold disabled:opacity-50"
            >
              {t('tenants.resetPassword')}
            </button>
          </div>

          {showPasswordReset && (
            <div className="bg-neutral-950 border border-neutral-800 rounded-lg p-4 space-y-3">
              <label className="block text-xs text-neutral-400">{t('tenantManagement.newPassword')}</label>
              <input
                type="text"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder={t('tenantManagement.minChars')}
                className="w-full px-3 py-2 bg-neutral-900 border border-neutral-700 rounded text-white text-sm"
              />
              <div className="flex gap-2">
                <button
                  onClick={handleResetPassword}
                  disabled={busy || newPassword.length < 8}
                  className="px-3 py-2 bg-brand-600 hover:bg-brand-500 text-white text-sm rounded font-semibold disabled:opacity-50"
                >
                  {t('tenantManagement.resetButton')}
                </button>
                <button
                  onClick={() => { setShowPasswordReset(false); setNewPassword(''); }}
                  className="px-3 py-2 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 text-sm rounded"
                >
                  {t('tenantManagement.editOffer.cancel' as any, 'Cancel')}
                </button>
              </div>
            </div>
          )}

          {/* Stats */}
          {!data ? (
            <div className="text-neutral-400 text-sm">{t('tenants.loadingDetails')}</div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {[
                { label: t('tenants.stats.ordersAll'), value: fmtNumber(data.stats.total_orders) },
                { label: t('tenants.stats.revenueAll'), value: fmtCurrency(data.stats.total_revenue) },
                { label: t('tenants.stats.orders30d'), value: fmtNumber(data.stats.orders_30d) },
                { label: t('tenants.stats.revenue30d'), value: fmtCurrency(data.stats.revenue_30d) },
                { label: t('tenants.stats.employees'), value: fmtNumber(data.stats.employee_count) },
                { label: t('tenants.stats.menuItems'), value: fmtNumber(data.stats.menu_item_count) },
                { label: t('tenants.stats.categories'), value: fmtNumber(data.stats.category_count) },
                { label: t('tenants.stats.customers'), value: fmtNumber(data.stats.customer_count) },
              ].map((s) => (
                <div key={s.label} className="bg-neutral-950 border border-neutral-800 rounded-lg p-3">
                  <div className="text-xs text-neutral-500">{s.label}</div>
                  <div className="text-lg font-semibold text-white mt-1">{s.value}</div>
                </div>
              ))}
              <div className="col-span-2 text-xs text-neutral-500 mt-2">
                {t('tenants.lastOrder')} {fmtDate(data.stats.last_order_at)}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

/* ==================== Create Tenant Modal ==================== */

const CreateTenantModal: React.FC<{
  onClose: () => void;
  onCreated: () => void;
}> = ({ onClose, onCreated }) => {
  const { t } = useTranslation('superAdmin');
  const [form, setForm] = useState<CreateTenantPayload>({
    id: '',
    name: '',
    owner_email: '',
    owner_password: '',
    plan: 'free',
  });
  const [result, setResult] = useState<{ pin: string; email: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const update = (patch: Partial<CreateTenantPayload>) => setForm((f) => ({ ...f, ...patch }));

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const res = await createTenant({ ...form, subdomain: form.id });
      setResult({ pin: res.pin, email: res.owner_email });
    } catch (e: any) {
      setErr(e.message || t('tenants.failed'));
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <Modal onClose={onClose}>
        <h2 className="text-lg font-bold text-white">{t('tenantManagement.tenantCreated')}</h2>
        <p className="text-sm text-neutral-400 mt-2">
          {t('tenantManagement.adminPinFor')} <span className="text-white font-semibold">{result.email}</span>
        </p>
        <div className="my-6 bg-neutral-950 border border-brand-700 rounded-lg p-6 text-center">
          <div className="text-xs text-neutral-500 uppercase tracking-wider">PIN</div>
          <div className="text-4xl font-mono font-bold text-brand-400 mt-2 tracking-widest">{result.pin}</div>
        </div>
        <button
          onClick={() => { onCreated(); }}
          className="w-full py-2 bg-brand-600 hover:bg-brand-500 text-white font-semibold rounded"
        >
          {t('tenantManagement.done')}
        </button>
      </Modal>
    );
  }

  return (
    <Modal onClose={onClose}>
      <form onSubmit={handleCreate} className="space-y-4">
        <h2 className="text-lg font-bold text-white">{t('tenantManagement.createTitle')}</h2>

        <Field label={t('tenantManagement.restaurantName')}>
          <input required value={form.name} onChange={(e) => update({ name: e.target.value })} className={inputCls} />
        </Field>

        <Field label={t('tenantManagement.slugId')}>
          <input
            required
            pattern="[a-z0-9-]+"
            value={form.id}
            onChange={(e) => update({ id: e.target.value.toLowerCase() })}
            className={inputCls}
          />
          <p className="text-xs text-neutral-500 mt-1">{t('tenantManagement.slugPattern')}</p>
        </Field>

        <Field label={t('tenantManagement.ownerEmail')}>
          <input required type="email" value={form.owner_email} onChange={(e) => update({ owner_email: e.target.value })} className={inputCls} />
        </Field>

        <Field label={t('tenantManagement.password')}>
          <input required type="text" minLength={8} value={form.owner_password} onChange={(e) => update({ owner_password: e.target.value })} className={inputCls} />
        </Field>

        <Field label={t('tenantManagement.plan')}>
          <select value={form.plan} onChange={(e) => update({ plan: e.target.value })} className={inputCls}>
            <option value="free">{t('tenantManagement.free')}</option>
            <option value="pro">{t('tenantManagement.pro')}</option>
          </select>
        </Field>

        {err && <div className="text-sm text-cockpit-red">{err}</div>}

        <div className="flex gap-2 pt-2">
          <button
            type="submit"
            disabled={busy}
            className="flex-1 py-2 bg-brand-600 hover:bg-brand-500 text-white font-semibold rounded disabled:opacity-50"
          >
            {t('tenantManagement.createButton')}
          </button>
          <button type="button" onClick={onClose} className="px-4 py-2 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded">
            {t('stressTest.cancel')}
          </button>
        </div>
      </form>
    </Modal>
  );
};

const Modal: React.FC<{ onClose: () => void; children: React.ReactNode }> = ({ onClose, children }) => (
  <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" onClick={onClose}>
    <div className="w-full max-w-md bg-neutral-900 border border-neutral-800 rounded-xl p-6" onClick={(e) => e.stopPropagation()}>
      {children}
    </div>
  </div>
);

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div>
    <label className="block text-xs text-neutral-400 mb-1">{label}</label>
    {children}
  </div>
);

const inputCls = 'w-full px-3 py-2 bg-neutral-950 border border-neutral-700 rounded text-white text-sm focus:outline-none focus:border-brand-600';

export default TenantsTab;
