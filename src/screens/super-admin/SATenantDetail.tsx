import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Trash2, RefreshCw, Key, Database, ToggleLeft, ToggleRight } from 'lucide-react';
import {
  getTenantDeepDive,
  patchTenant,
  seedTenant,
  resetTenantPassword,
  deleteTenant,
  getTenantEmployees,
  updateEmployeePin,
  type DeepDiveData,
  type TenantEmployee,
} from '../../api/superAdmin';

function formatCurrency(val: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(val);
}

export default function SATenantDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation('superAdmin');

  const [data, setData] = useState<DeepDiveData | null>(null);
  const [employees, setEmployees] = useState<TenantEmployee[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionMsg, setActionMsg] = useState('');

  // Delete confirmation
  const [showDelete, setShowDelete] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState('');

  // Reset password
  const [showResetPw, setShowResetPw] = useState(false);
  const [newPassword, setNewPassword] = useState('');

  // Employee PIN
  const [pinInputs, setPinInputs] = useState<Record<number, string>>({});

  const fetchData = async () => {
    if (!id) return;
    setLoading(true);
    try {
      const [dd, emps] = await Promise.all([
        getTenantDeepDive(id),
        getTenantEmployees(id),
      ]);
      setData(dd);
      setEmployees(emps);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [id]);

  const flash = (msg: string) => {
    setActionMsg(msg);
    setTimeout(() => setActionMsg(''), 3000);
  };

  const handleToggleActive = async () => {
    if (!data) return;
    try {
      await patchTenant(data.tenant.id, { active: !data.tenant.active });
      flash(t('tenants.saved'));
      await fetchData();
    } catch (err: any) {
      flash(t('tenants.failedToggleStatus'));
    }
  };

  const handleChangePlan = async () => {
    if (!data) return;
    const newPlan = data.tenant.plan === 'free' ? 'pro' : 'free';
    try {
      await patchTenant(data.tenant.id, { plan: newPlan });
      flash(t('tenants.saved'));
      await fetchData();
    } catch (err: any) {
      flash(t('tenants.failedUpdatePlan'));
    }
  };

  const handleSeed = async () => {
    if (!id) return;
    if (!confirm(t('tenants.seedConfirm', { id }))) return;
    try {
      await seedTenant(id);
      flash(t('tenants.saved'));
      await fetchData();
    } catch (err: any) {
      flash(t('tenants.failed'));
    }
  };

  const handleResetPassword = async () => {
    if (!id || newPassword.length < 8) return;
    try {
      await resetTenantPassword(id, newPassword);
      setShowResetPw(false);
      setNewPassword('');
      flash(t('tenantManagement.passwordReset'));
    } catch (err: any) {
      flash(t('tenants.failed'));
    }
  };

  const handleDelete = async () => {
    if (!id || deleteConfirm !== id) return;
    try {
      await deleteTenant(id, id);
      navigate('/super-admin/tenants');
    } catch (err: any) {
      flash(t('tenants.failed'));
    }
  };

  const handleSetPin = async (empId: number) => {
    if (!id) return;
    const pin = pinInputs[empId];
    if (!pin || pin.length < 4) return;
    try {
      await updateEmployeePin(id, empId, pin);
      setPinInputs(prev => ({ ...prev, [empId]: '' }));
      flash(t('tenants.saved'));
    } catch (err: any) {
      flash(t('tenants.failed'));
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-neutral-400 animate-pulse">{t('tenants.loadingDetails')}</p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="space-y-4">
        <button onClick={() => navigate('/super-admin/tenants')} className="flex items-center gap-2 text-neutral-400 hover:text-white transition-colors">
          <ArrowLeft size={18} /> Back
        </button>
        <p className="text-red-400">{error || 'Tenant not found'}</p>
      </div>
    );
  }

  const { tenant, stats } = data;

  const statItems = [
    { label: t('tenants.stats.ordersAll'), value: stats.total_orders.toLocaleString() },
    { label: t('tenants.stats.revenueAll'), value: formatCurrency(stats.total_revenue) },
    { label: t('tenants.stats.orders30d'), value: stats.orders_30d.toLocaleString() },
    { label: t('tenants.stats.revenue30d'), value: formatCurrency(stats.revenue_30d) },
    { label: t('tenants.stats.employees'), value: stats.employee_count },
    { label: t('tenants.stats.menuItems'), value: stats.menu_item_count },
    { label: t('tenants.stats.categories'), value: stats.category_count },
    { label: t('tenants.stats.customers'), value: stats.customer_count },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate('/super-admin/tenants')}
            className="p-2 hover:bg-neutral-800 rounded-lg text-neutral-400 hover:text-white transition-colors"
          >
            <ArrowLeft size={20} />
          </button>
          <div>
            <h2 className="text-2xl font-black text-white tracking-tight">{tenant.name}</h2>
            <p className="text-neutral-500 text-sm">
              {tenant.subdomain} &middot; {tenant.owner_email} &middot; {t('tenants.joined')} {new Date(tenant.created_at).toLocaleDateString()}
            </p>
          </div>
        </div>
        {actionMsg && (
          <span className="text-sm text-green-400 bg-green-400/10 px-3 py-1 rounded-lg">{actionMsg}</span>
        )}
      </div>

      {/* Tenant Info */}
      <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
        <div className="flex flex-wrap items-center gap-3">
          <span className={`inline-block px-2.5 py-1 rounded text-xs font-semibold ${tenant.plan === 'pro' ? 'bg-brand-600/20 text-brand-400' : 'bg-neutral-700/50 text-neutral-300'}`}>
            {tenant.plan.toUpperCase()}
          </span>
          <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${tenant.active ? 'text-green-400' : 'text-neutral-500'}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${tenant.active ? 'bg-green-400' : 'bg-neutral-500'}`} />
            {tenant.active ? t('tenants.active') : t('tenants.inactive')}
          </span>
          {stats.last_order_at && (
            <span className="text-neutral-500 text-xs">
              {t('tenants.lastOrder')} {new Date(stats.last_order_at).toLocaleDateString()}
            </span>
          )}
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {statItems.map((item, i) => (
          <div key={i} className="bg-neutral-900 border border-neutral-800 rounded-xl p-4">
            <p className="text-neutral-400 text-xs font-medium">{item.label}</p>
            <p className="text-white text-lg font-bold mt-1">{item.value}</p>
          </div>
        ))}
      </div>

      {/* Employees */}
      <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
        <h3 className="text-white font-semibold mb-3">{t('tenants.employeesAndPins')}</h3>
        {employees.length === 0 ? (
          <p className="text-neutral-500 text-sm">{t('tenants.noEmployees')}</p>
        ) : (
          <div className="space-y-2">
            {employees.map(emp => (
              <div key={emp.id} className="flex items-center justify-between py-2 px-3 bg-neutral-800/50 rounded-lg">
                <div>
                  <p className="text-white text-sm font-medium">{emp.name}</p>
                  <p className="text-neutral-500 text-xs capitalize">{emp.role}</p>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={pinInputs[emp.id] || ''}
                    onChange={e => setPinInputs(prev => ({ ...prev, [emp.id]: e.target.value }))}
                    placeholder={t('tenants.pinPlaceholder')}
                    className="w-24 px-2 py-1.5 bg-neutral-700 border border-neutral-600 rounded text-white text-xs placeholder-neutral-500 focus:outline-none focus:ring-1 focus:ring-brand-600"
                    maxLength={6}
                  />
                  <button
                    onClick={() => handleSetPin(emp.id)}
                    disabled={!pinInputs[emp.id] || (pinInputs[emp.id]?.length || 0) < 4}
                    className="px-2.5 py-1.5 bg-brand-600 hover:bg-brand-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-medium rounded transition-colors"
                  >
                    {t('tenants.setPin')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
        <h3 className="text-white font-semibold mb-4">{t('tenants.actionsLabel')}</h3>
        <div className="flex flex-wrap gap-3">
          <button
            onClick={handleToggleActive}
            className="flex items-center gap-2 px-4 py-2 bg-neutral-800 hover:bg-neutral-700 text-white text-sm rounded-lg transition-colors"
          >
            {tenant.active ? <ToggleRight size={16} /> : <ToggleLeft size={16} />}
            {tenant.active ? t('tenants.deactivate') : t('tenants.activate')}
          </button>
          <button
            onClick={handleChangePlan}
            className="flex items-center gap-2 px-4 py-2 bg-neutral-800 hover:bg-neutral-700 text-white text-sm rounded-lg transition-colors"
          >
            <RefreshCw size={16} />
            Switch to {tenant.plan === 'free' ? 'Pro' : 'Free'}
          </button>
          <button
            onClick={() => setShowResetPw(true)}
            className="flex items-center gap-2 px-4 py-2 bg-neutral-800 hover:bg-neutral-700 text-white text-sm rounded-lg transition-colors"
          >
            <Key size={16} />
            {t('tenants.resetPassword')}
          </button>
          <button
            onClick={handleSeed}
            className="flex items-center gap-2 px-4 py-2 bg-neutral-800 hover:bg-neutral-700 text-white text-sm rounded-lg transition-colors"
          >
            <Database size={16} />
            {t('tenants.seedDemoDataAction')}
          </button>
          <button
            onClick={() => setShowDelete(true)}
            className="flex items-center gap-2 px-4 py-2 bg-red-600/20 hover:bg-red-600/30 text-red-400 text-sm rounded-lg transition-colors"
          >
            <Trash2 size={16} />
            {t('tenants.deleteTenant')}
          </button>
        </div>
      </div>

      {/* Reset Password Modal */}
      {showResetPw && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
          <div className="bg-neutral-900 border border-neutral-800 rounded-2xl p-6 w-full max-w-sm">
            <h3 className="text-white font-bold text-lg mb-1">{t('tenantManagement.resetPasswordTitle')}</h3>
            <p className="text-neutral-400 text-sm mb-4">
              {t('tenantManagement.newPasswordFor')} <span className="text-white font-medium">{tenant.name}</span>
            </p>
            <input
              type="password"
              value={newPassword}
              onChange={e => setNewPassword(e.target.value)}
              placeholder={t('tenantManagement.newPassword')}
              className="w-full px-4 py-2.5 bg-neutral-800 border border-neutral-700 rounded-lg text-white text-sm placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-brand-600 mb-1"
            />
            <p className="text-neutral-500 text-xs mb-4">{t('tenantManagement.minChars')}</p>
            <div className="flex gap-3">
              <button
                onClick={() => { setShowResetPw(false); setNewPassword(''); }}
                className="flex-1 py-2 bg-neutral-800 hover:bg-neutral-700 text-white text-sm rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleResetPassword}
                disabled={newPassword.length < 8}
                className="flex-1 py-2 bg-brand-600 hover:bg-brand-500 disabled:opacity-50 text-white text-sm font-semibold rounded-lg transition-colors"
              >
                {t('tenantManagement.resetButton')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {showDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
          <div className="bg-neutral-900 border border-neutral-800 rounded-2xl p-6 w-full max-w-sm">
            <h3 className="text-red-400 font-bold text-lg mb-1">{t('tenantManagement.deleteTitle')}</h3>
            <p className="text-neutral-400 text-sm mb-4">
              {t('tenantManagement.deleteWarning', { name: tenant.name })}
            </p>
            <p className="text-neutral-400 text-sm mb-2">
              {t('tenantManagement.typeToConfirm')} <code className="text-white bg-neutral-800 px-1.5 py-0.5 rounded text-xs">{id}</code> {t('tenantManagement.toConfirm')}
            </p>
            <input
              type="text"
              value={deleteConfirm}
              onChange={e => setDeleteConfirm(e.target.value)}
              className="w-full px-4 py-2.5 bg-neutral-800 border border-neutral-700 rounded-lg text-white text-sm placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-red-600 mb-4"
              placeholder={id}
            />
            <div className="flex gap-3">
              <button
                onClick={() => { setShowDelete(false); setDeleteConfirm(''); }}
                className="flex-1 py-2 bg-neutral-800 hover:bg-neutral-700 text-white text-sm rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={deleteConfirm !== id}
                className="flex-1 py-2 bg-red-600 hover:bg-red-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-lg transition-colors"
              >
                {t('tenantManagement.deletePermanently')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
