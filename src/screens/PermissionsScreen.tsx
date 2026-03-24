import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Shield, Save } from 'lucide-react';
import { getAllPermissions, updateRolePermissions } from '../api';
import FeatureGate from '../components/FeatureGate';

const ROLES = ['admin', 'manager', 'cashier', 'kitchen', 'bar'];

export default function PermissionsScreen() {
  const { t } = useTranslation('admin');
  const [permissions, setPermissions] = useState<Record<string, Record<string, boolean>>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const PERMISSION_KEYS = [
    'pos_access', 'kitchen_access', 'bar_access', 'view_reports',
    'manage_menu', 'manage_inventory', 'manage_employees', 'manage_printers',
    'manage_delivery', 'manage_modifiers', 'manage_ai', 'process_refunds',
    'void_orders', 'apply_discounts', 'view_dashboard', 'manage_permissions',
    'manage_purchase_orders',
  ];

  useEffect(() => {
    fetchPermissions();
  }, []);

  const fetchPermissions = async () => {
    try {
      setLoading(true);
      const data = await getAllPermissions();
      setPermissions(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('permissions.failedLoad'));
    } finally {
      setLoading(false);
    }
  };

  const handleToggle = (role: string, permission: string) => {
    if (role === 'admin') return; // Admin always has all
    setPermissions((prev) => ({
      ...prev,
      [role]: {
        ...prev[role],
        [permission]: !prev[role]?.[permission],
      },
    }));
  };

  const handleSaveRole = async (role: string) => {
    try {
      setSaving(role);
      setError(null);
      await updateRolePermissions(role, permissions[role] || {});
      setSuccess(t('permissions.permissionsSaved', { role }));
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('permissions.failedSave'));
    } finally {
      setSaving(null);
    }
  };

  return (
    <FeatureGate feature="permissions" featureLabel="Permission Management">
      <div className="min-h-screen bg-neutral-950">
        <div className="bg-neutral-900 text-white p-6 border-b border-neutral-800">
          <div className="flex items-center gap-4">
            <Link to="/admin" className="p-2 hover:bg-neutral-800 rounded-lg transition-colors">
              <ArrowLeft size={24} />
            </Link>
            <Shield className="text-brand-500" size={28} />
            <h1 className="text-3xl font-black tracking-tighter">{t('permissions.title')}</h1>
          </div>
        </div>

        <div className="max-w-7xl mx-auto p-6">
          {error && (
            <div className="bg-brand-900/30 border border-brand-800 rounded-lg p-4 mb-6">
              <p className="text-brand-300">{error}</p>
            </div>
          )}
          {success && (
            <div className="bg-green-900/30 border border-green-800 rounded-lg p-4 mb-6">
              <p className="text-green-300">{success}</p>
            </div>
          )}

          {loading ? (
            <div className="text-center text-neutral-400 py-12">{t('permissions.loadingPermissions')}</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr>
                    <th className="text-left p-3 bg-neutral-900 text-neutral-300 font-bold border border-neutral-800 sticky left-0 z-10">
                      {t('permissions.permission')}
                    </th>
                    {ROLES.map((role) => (
                      <th key={role} className="p-3 bg-neutral-900 text-neutral-300 font-bold border border-neutral-800 text-center capitalize min-w-[120px]">
                        {t(`common:roles.${role}`)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {PERMISSION_KEYS.map((perm) => (
                    <tr key={perm} className="hover:bg-neutral-900/50">
                      <td className="p-3 border border-neutral-800 text-white font-medium bg-neutral-950 sticky left-0">
                        {t(`permissions.permLabels.${perm}`)}
                      </td>
                      {ROLES.map((role) => (
                        <td key={role} className="p-3 border border-neutral-800 text-center">
                          <button
                            onClick={() => handleToggle(role, perm)}
                            disabled={role === 'admin'}
                            className={`w-10 h-6 rounded-full transition-colors relative ${
                              permissions[role]?.[perm]
                                ? 'bg-brand-600'
                                : 'bg-neutral-700'
                            } ${role === 'admin' ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                          >
                            <span
                              className={`absolute top-0.5 w-5 h-5 bg-white rounded-full transition-transform ${
                                permissions[role]?.[perm] ? 'left-[18px]' : 'left-0.5'
                              }`}
                            />
                          </button>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td className="p-3 border border-neutral-800 bg-neutral-950 sticky left-0"></td>
                    {ROLES.map((role) => (
                      <td key={role} className="p-3 border border-neutral-800 text-center">
                        {role !== 'admin' && (
                          <button
                            onClick={() => handleSaveRole(role)}
                            disabled={saving === role}
                            className="px-4 py-2 bg-brand-600 text-white text-sm font-bold rounded-lg hover:bg-brand-700 disabled:opacity-50 transition-colors flex items-center gap-1 mx-auto"
                          >
                            <Save size={14} />
                            {saving === role ? t('permissions.saving') : t('permissions.save')}
                          </button>
                        )}
                      </td>
                    ))}
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      </div>
    </FeatureGate>
  );
}
