import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSalesAuth } from '../../context/SalesAuthContext';
import { getReps, createRep, updateRep, resetRepPassword, type SalesRep } from '../../api/salesApi';

export default function SalesTeamManager() {
  const { t } = useTranslation('sales');
  const { isManager } = useSalesAuth();
  const [reps, setReps] = useState<SalesRep[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showAddModal, setShowAddModal] = useState(false);
  const [resetTarget, setResetTarget] = useState<SalesRep | null>(null);
  const [resetPw, setResetPw] = useState('');
  const [resetting, setResetting] = useState(false);

  const fetchReps = () => {
    setLoading(true);
    getReps()
      .then(setReps)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchReps();
  }, []);

  const handleToggleActive = async (rep: SalesRep) => {
    try {
      await updateRep(rep.id, { active: !rep.active } as Partial<SalesRep>);
      fetchReps();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleResetPassword = async () => {
    if (!resetTarget || !resetPw) return;
    setResetting(true);
    try {
      await resetRepPassword(resetTarget.id, resetPw);
      setResetTarget(null);
      setResetPw('');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setResetting(false);
    }
  };

  if (!isManager) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-neutral-500">Manager access required.</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <div className="text-brand-600 animate-pulse">Loading...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">{t('team.title')}</h1>
        <button
          onClick={() => setShowAddModal(true)}
          className="px-4 py-2 bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium rounded-lg transition"
        >
          {t('team.addRep')}
        </button>
      </div>

      {error && (
        <div className="text-red-400 bg-red-900/20 border border-red-800 rounded-lg p-3 text-sm">{error}</div>
      )}

      <div className="bg-neutral-900 border border-neutral-800 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-neutral-800">
                <th className="text-left px-4 py-3 text-neutral-500 font-medium">{t('team.name')}</th>
                <th className="text-left px-4 py-3 text-neutral-500 font-medium">{t('team.email')}</th>
                <th className="text-left px-4 py-3 text-neutral-500 font-medium">{t('team.phone')}</th>
                <th className="text-left px-4 py-3 text-neutral-500 font-medium">{t('team.role')}</th>
                <th className="text-left px-4 py-3 text-neutral-500 font-medium">{t('team.active')}</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {reps.map((rep) => (
                <tr key={rep.id} className="border-b border-neutral-800/50">
                  <td className="px-4 py-3 text-white font-medium">{rep.name}</td>
                  <td className="px-4 py-3 text-neutral-400">{rep.email}</td>
                  <td className="px-4 py-3 text-neutral-400">{rep.phone || '-'}</td>
                  <td className="px-4 py-3">
                    <span className="text-xs px-2 py-1 rounded-full font-medium bg-neutral-800 text-neutral-300 capitalize">
                      {rep.role}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => handleToggleActive(rep)}
                      className={`text-xs px-2 py-1 rounded-full font-medium transition ${
                        rep.active
                          ? 'bg-green-500/20 text-green-400 hover:bg-green-500/30'
                          : 'bg-red-500/20 text-red-400 hover:bg-red-500/30'
                      }`}
                    >
                      {rep.active ? 'Active' : 'Inactive'}
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => setResetTarget(rep)}
                      className="text-xs text-neutral-500 hover:text-white transition"
                    >
                      {t('team.resetPassword')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add Rep Modal */}
      {showAddModal && (
        <AddRepModal
          onClose={() => setShowAddModal(false)}
          onCreated={() => {
            setShowAddModal(false);
            fetchReps();
          }}
        />
      )}

      {/* Reset Password Modal */}
      {resetTarget && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="bg-neutral-900 border border-neutral-800 rounded-2xl w-full max-w-sm p-6">
            <h3 className="text-lg font-semibold text-white mb-1">{t('team.resetPassword')}</h3>
            <p className="text-sm text-neutral-500 mb-4">{resetTarget.name} ({resetTarget.email})</p>

            <input
              type="password"
              value={resetPw}
              onChange={(e) => setResetPw(e.target.value)}
              placeholder="New password"
              className="w-full px-3 py-2.5 bg-neutral-800 border border-neutral-700 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-brand-600 text-sm mb-4"
            />

            <div className="flex gap-3">
              <button
                onClick={() => {
                  setResetTarget(null);
                  setResetPw('');
                }}
                className="flex-1 py-2.5 bg-neutral-800 text-neutral-300 rounded-lg text-sm font-medium hover:bg-neutral-700 transition"
              >
                Cancel
              </button>
              <button
                onClick={handleResetPassword}
                disabled={!resetPw || resetting}
                className="flex-1 py-2.5 bg-brand-600 hover:bg-brand-700 text-white rounded-lg text-sm font-medium transition disabled:opacity-50"
              >
                {resetting ? '...' : 'Reset'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function AddRepModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { t } = useTranslation('sales');
  const [form, setForm] = useState({
    name: '',
    email: '',
    password: '',
    phone: '',
    role: 'rep',
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      await createRep({
        name: form.name,
        email: form.email,
        password: form.password,
        phone: form.phone || undefined,
        role: form.role,
      });
      onCreated();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
      <div className="bg-neutral-900 border border-neutral-800 rounded-2xl w-full max-w-md p-6">
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-lg font-semibold text-white">{t('team.addRep')}</h3>
          <button onClick={onClose} className="text-neutral-500 hover:text-white transition">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="text"
            placeholder={t('team.name')}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
            className="w-full px-3 py-2.5 bg-neutral-800 border border-neutral-700 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-brand-600 text-sm"
          />
          <input
            type="email"
            placeholder={t('team.email')}
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            required
            className="w-full px-3 py-2.5 bg-neutral-800 border border-neutral-700 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-brand-600 text-sm"
          />
          <input
            type="password"
            placeholder="Password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            required
            className="w-full px-3 py-2.5 bg-neutral-800 border border-neutral-700 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-brand-600 text-sm"
          />
          <input
            type="tel"
            placeholder={t('team.phone')}
            value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
            className="w-full px-3 py-2.5 bg-neutral-800 border border-neutral-700 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-brand-600 text-sm"
          />
          <select
            value={form.role}
            onChange={(e) => setForm({ ...form, role: e.target.value })}
            className="w-full px-3 py-2.5 bg-neutral-800 border border-neutral-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-brand-600 text-sm"
          >
            <option value="rep">Rep</option>
            <option value="manager">Manager</option>
          </select>

          {error && (
            <div className="text-red-400 text-sm bg-red-900/20 border border-red-800 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2.5 bg-neutral-800 text-neutral-300 rounded-lg text-sm font-medium hover:bg-neutral-700 transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="flex-1 py-2.5 bg-brand-600 hover:bg-brand-700 text-white rounded-lg text-sm font-medium transition disabled:opacity-50"
            >
              {submitting ? '...' : t('team.addRep')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
