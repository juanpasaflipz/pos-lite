import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, X, RefreshCw, ExternalLink, AlertTriangle, Clock } from 'lucide-react';
import {
  getFleet,
  getTenantDeepDive,
  patchTenant,
  extendTrial,
  createTenant,
  resetTenantPassword,
  type FleetRow,
  type DeepDiveData,
  type CreateTenantPayload,
} from '../../../api/superAdmin';

const fmtCurrency = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n ?? 0);
const fmtNumber = (n: number) => new Intl.NumberFormat('en-US').format(n ?? 0);
const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—';

/** "3h ago"-style relative time in the viewer's locale. */
const relTime = (iso: string | null): string => {
  if (!iso) return '—';
  const diffMs = new Date(iso).getTime() - Date.now();
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'always', style: 'narrow' });
  const mins = Math.round(diffMs / 60_000);
  if (Math.abs(mins) < 60) return rtf.format(mins, 'minute');
  const hours = Math.round(diffMs / 3_600_000);
  if (Math.abs(hours) < 48) return rtf.format(hours, 'hour');
  const days = Math.round(diffMs / 86_400_000);
  return rtf.format(days, 'day');
};

type Filter = 'all' | 'free' | 'trial' | 'pro' | 'suspended' | 'attention';

/** A row needs operator attention: incidents, suspension, billing trouble, or a trial about to die. */
const needsAttention = (t: FleetRow): boolean =>
  !t.active ||
  t.incidents.open > 0 ||
  (t.subscription_status != null && !['active', 'trialing'].includes(t.subscription_status)) ||
  (t.trial_active && (t.trial_days_left ?? 99) <= 3);

const setupScore = (o: FleetRow['onboarding']): number =>
  [o.has_menu, o.has_payment, o.has_printer, o.has_extra_staff, o.has_first_order].filter(Boolean).length;

const TenantsTab: React.FC = () => {
  const { t } = useTranslation('superAdmin');
  const [fleet, setFleet] = useState<FleetRow[] | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState<FleetRow | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setError(null);
    getFleet()
      .then(setFleet)
      .catch((e) => setError(e.message));
  };

  useEffect(load, []);

  const attentionCount = useMemo(() => (fleet ? fleet.filter(needsAttention).length : 0), [fleet]);

  const filtered = useMemo(() => {
    if (!fleet) return [];
    const q = search.trim().toLowerCase();
    return fleet.filter((row) => {
      if (filter === 'free' && (row.effective_plan !== 'free' || !row.active)) return false;
      if (filter === 'trial' && !row.trial_active) return false;
      if (filter === 'pro' && row.plan !== 'pro') return false;
      if (filter === 'suspended' && row.active) return false;
      if (filter === 'attention' && !needsAttention(row)) return false;
      if (!q) return true;
      return (
        row.name.toLowerCase().includes(q) ||
        row.id.toLowerCase().includes(q) ||
        (row.owner_email || '').toLowerCase().includes(q)
      );
    });
  }, [fleet, search, filter]);

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
            <option value="attention">{t('tenants.filterAttention', { count: attentionCount })}</option>
            <option value="trial">{t('tenants.filterTrial')}</option>
            <option value="pro">{t('tenants.pro')}</option>
            <option value="free">{t('tenants.free')}</option>
            <option value="suspended">{t('tenants.filterSuspended')}</option>
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

      {error && <div className="text-cockpit-out-text">{error}</div>}

      {!fleet ? (
        <div className="text-neutral-400">{t('tenants.loading')}</div>
      ) : filtered.length === 0 ? (
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-8 text-center text-neutral-500">
          {t('tenants.noTenants')}
        </div>
      ) : (
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-neutral-950 border-b border-neutral-800">
              <tr className="text-left text-xs uppercase tracking-wider text-neutral-500">
                <th className="px-4 py-3">{t('tenants.columns.name')}</th>
                <th className="px-4 py-3">{t('tenants.columns.plan')}</th>
                <th className="px-4 py-3">{t('tenants.columns.status')}</th>
                <th className="px-4 py-3">{t('tenants.columns.pulse')}</th>
                <th className="px-4 py-3">{t('tenants.columns.setup')}</th>
                <th className="px-4 py-3">{t('tenants.columns.incidents')}</th>
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
                  <td className="px-4 py-3"><PlanBadge row={row} /></td>
                  <td className="px-4 py-3"><StatusBadge row={row} /></td>
                  <td className="px-4 py-3"><PulseCell row={row} /></td>
                  <td className="px-4 py-3"><SetupCell row={row} /></td>
                  <td className="px-4 py-3"><IncidentsCell row={row} /></td>
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

/* ==================== Cells ==================== */

const PlanBadge: React.FC<{ row: FleetRow }> = ({ row }) => {
  const { t } = useTranslation('superAdmin');
  if (row.plan === 'pro') {
    return <span className="px-2 py-0.5 rounded text-xs font-semibold bg-brand-900/50 text-brand-300">{t('tenants.pro')}</span>;
  }
  if (row.trial_active) {
    return (
      <span className="px-2 py-0.5 rounded text-xs font-semibold bg-brand-900/30 border border-brand-800 text-brand-300 inline-flex items-center gap-1">
        <Clock size={11} /> {t('tenants.trialBadge', { count: row.trial_days_left ?? 0 })}
      </span>
    );
  }
  return (
    <div>
      <span className="px-2 py-0.5 rounded text-xs font-semibold bg-neutral-800 text-neutral-400">{t('tenants.free')}</span>
      {row.trial_ends_at && (
        <div className="text-[10px] text-neutral-600 mt-0.5">{t('tenants.trialEnded')}</div>
      )}
    </div>
  );
};

const StatusBadge: React.FC<{ row: FleetRow }> = ({ row }) => {
  const { t } = useTranslation('superAdmin');
  const billingOff = row.subscription_status != null && !['active', 'trialing'].includes(row.subscription_status);
  return (
    <div>
      <span
        className={`px-2 py-0.5 rounded text-xs font-semibold ${
          row.active ? 'bg-cockpit-green/40 text-cockpit-in-text' : 'bg-cockpit-red/40 text-cockpit-out-text'
        }`}
      >
        {row.active ? t('tenants.active') : t('tenants.suspended')}
      </span>
      {billingOff && (
        <div className="text-[10px] text-amber-400 mt-0.5">{row.subscription_status}</div>
      )}
    </div>
  );
};

const PulseCell: React.FC<{ row: FleetRow }> = ({ row }) => {
  const { t } = useTranslation('superAdmin');
  const { last_order_at, orders_24h, orders_7d } = row.pulse;
  const dot = orders_24h > 0 ? 'bg-cockpit-green' : orders_7d > 0 ? 'bg-amber-400' : 'bg-neutral-600';
  return (
    <div className="flex items-center gap-2">
      <span className={`w-2 h-2 rounded-full shrink-0 ${dot}`} />
      <div>
        <div className="text-neutral-300 text-xs">
          {last_order_at ? relTime(last_order_at) : t('tenants.pulseNever')}
        </div>
        <div className="text-[10px] text-neutral-500">{t('tenants.pulse7d', { count: orders_7d })}</div>
      </div>
    </div>
  );
};

const SetupCell: React.FC<{ row: FleetRow }> = ({ row }) => {
  const score = setupScore(row.onboarding);
  return (
    <div className="flex items-center gap-2">
      <div className="flex gap-0.5">
        {[row.onboarding.has_menu, row.onboarding.has_payment, row.onboarding.has_printer,
          row.onboarding.has_extra_staff, row.onboarding.has_first_order].map((done, i) => (
          <span key={i} className={`w-1.5 h-3.5 rounded-sm ${done ? 'bg-brand-500' : 'bg-neutral-700'}`} />
        ))}
      </div>
      <span className={`text-xs ${score === 5 ? 'text-cockpit-in-text' : 'text-neutral-400'}`}>{score}/5</span>
    </div>
  );
};

const IncidentsCell: React.FC<{ row: FleetRow }> = ({ row }) => {
  const { open, critical } = row.incidents;
  if (open === 0) return <span className="text-neutral-600 text-xs">—</span>;
  return (
    <span
      className={`px-2 py-0.5 rounded text-xs font-semibold inline-flex items-center gap-1 ${
        critical > 0 ? 'bg-cockpit-red/40 text-cockpit-out-text' : 'bg-amber-500/20 text-amber-300'
      }`}
    >
      <AlertTriangle size={11} /> {open}
    </span>
  );
};

/* ==================== Tenant Detail Drawer ==================== */

const TenantDrawer: React.FC<{
  tenant: FleetRow;
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

  const handleExtendTrial = async (days: number) => {
    setBusy(true);
    try {
      await extendTrial(tenant.id, days);
      onChanged();
    } catch (e: any) {
      setMsg(e.message || t('tenants.failed'));
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
                tenant.active ? 'bg-cockpit-red/40 text-cockpit-out-text hover:bg-cockpit-red/60' : 'bg-cockpit-green/40 text-cockpit-in-text hover:bg-cockpit-green/60'
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

          {/* Trial control — only meaningful while the tenant isn't paid Pro */}
          {tenant.plan !== 'pro' && (
            <div className="bg-neutral-950 border border-neutral-800 rounded-lg p-4 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs uppercase tracking-wider text-neutral-500">{t('tenants.trial.title')}</span>
                <span className="text-sm text-neutral-300">
                  {tenant.trial_active
                    ? t('tenants.trial.endsIn', { count: tenant.trial_days_left ?? 0, date: fmtDate(tenant.trial_ends_at) })
                    : tenant.trial_ends_at
                      ? t('tenants.trial.endedOn', { date: fmtDate(tenant.trial_ends_at) })
                      : t('tenants.trial.none')}
                </span>
              </div>
              <div className="flex gap-2">
                {[7, 14, 30].map((d) => (
                  <button
                    key={d}
                    onClick={() => handleExtendTrial(d)}
                    disabled={busy}
                    className="px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-200 rounded text-xs font-semibold disabled:opacity-50"
                  >
                    {t('tenants.trial.extend', { count: d })}
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-neutral-600">{t('tenants.trial.hint')}</p>
            </div>
          )}

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

        {err && <div className="text-sm text-cockpit-out-text">{err}</div>}

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
