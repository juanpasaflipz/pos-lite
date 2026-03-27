import React, { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { getLeads, createLead, type Lead } from '../../api/salesApi';

const STATUSES = ['all', 'new', 'contacted', 'demo_scheduled', 'negotiating', 'converted', 'lost'] as const;

const STATUS_COLORS: Record<string, string> = {
  new: 'bg-blue-500/20 text-blue-400',
  contacted: 'bg-yellow-500/20 text-yellow-400',
  demo_scheduled: 'bg-purple-500/20 text-purple-400',
  negotiating: 'bg-orange-500/20 text-orange-400',
  converted: 'bg-green-500/20 text-green-400',
  lost: 'bg-red-500/20 text-red-400',
};

export default function SalesLeadsScreen() {
  const { t } = useTranslation('sales');
  const navigate = useNavigate();
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [showModal, setShowModal] = useState(false);

  const fetchLeads = useCallback(() => {
    setLoading(true);
    const params = statusFilter !== 'all' ? { status: statusFilter } : undefined;
    getLeads(params)
      .then(setLeads)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [statusFilter]);

  useEffect(() => {
    fetchLeads();
  }, [fetchLeads]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">{t('leads.title')}</h1>
        <button
          onClick={() => setShowModal(true)}
          className="px-4 py-2 bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium rounded-lg transition"
        >
          {t('leads.createLead')}
        </button>
      </div>

      {/* Status Tabs */}
      <div className="flex gap-1 overflow-x-auto pb-1">
        {STATUSES.map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium whitespace-nowrap transition ${
              statusFilter === s
                ? 'bg-brand-600 text-white'
                : 'bg-neutral-800 text-neutral-400 hover:text-white'
            }`}
          >
            {s === 'all' ? 'All' : t(`leads.statuses.${s}`, s)}
          </button>
        ))}
      </div>

      {error && (
        <div className="text-red-400 bg-red-900/20 border border-red-800 rounded-lg p-3 text-sm">{error}</div>
      )}

      {loading ? (
        <div className="flex justify-center py-12">
          <div className="text-brand-600 animate-pulse">Loading...</div>
        </div>
      ) : leads.length === 0 ? (
        <p className="text-neutral-500 text-center py-12">{t('leads.noLeads')}</p>
      ) : (
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-800">
                  <th className="text-left px-4 py-3 text-neutral-500 font-medium">{t('leads.restaurant')}</th>
                  <th className="text-left px-4 py-3 text-neutral-500 font-medium">{t('leads.contact')}</th>
                  <th className="text-left px-4 py-3 text-neutral-500 font-medium">{t('leads.status')}</th>
                  <th className="text-left px-4 py-3 text-neutral-500 font-medium">{t('leads.lastContact')}</th>
                </tr>
              </thead>
              <tbody>
                {leads.map((lead) => (
                  <tr
                    key={lead.id}
                    onClick={() => navigate(`/sales/leads/${lead.id}`)}
                    className="border-b border-neutral-800/50 hover:bg-neutral-800/50 cursor-pointer transition"
                  >
                    <td className="px-4 py-3 text-white font-medium">
                      {lead.restaurant_name || '-'}
                    </td>
                    <td className="px-4 py-3">
                      <p className="text-neutral-300">{lead.name || '-'}</p>
                      <p className="text-neutral-500 text-xs">{lead.email}</p>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`text-xs px-2 py-1 rounded-full font-medium ${
                          STATUS_COLORS[lead.status] || 'bg-neutral-700 text-neutral-300'
                        }`}
                      >
                        {t(`leads.statuses.${lead.status}`, lead.status)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-neutral-500 text-xs">
                      {lead.last_contacted_at
                        ? new Date(lead.last_contacted_at).toLocaleDateString()
                        : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* New Lead Modal */}
      {showModal && (
        <NewLeadModal
          onClose={() => setShowModal(false)}
          onCreated={() => {
            setShowModal(false);
            fetchLeads();
          }}
        />
      )}
    </div>
  );
}

function NewLeadModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { t } = useTranslation('sales');
  const [form, setForm] = useState({
    restaurant_name: '',
    name: '',
    email: '',
    phone: '',
    source: 'manual',
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      await createLead(form);
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
          <h3 className="text-lg font-semibold text-white">{t('leads.createLead')}</h3>
          <button onClick={onClose} className="text-neutral-500 hover:text-white transition">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="text"
            placeholder={t('onboard.restaurantName')}
            value={form.restaurant_name}
            onChange={(e) => setForm({ ...form, restaurant_name: e.target.value })}
            className="w-full px-3 py-2.5 bg-neutral-800 border border-neutral-700 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-brand-600 text-sm"
          />
          <input
            type="text"
            placeholder={t('onboard.ownerName')}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className="w-full px-3 py-2.5 bg-neutral-800 border border-neutral-700 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-brand-600 text-sm"
          />
          <input
            type="email"
            placeholder={t('onboard.ownerEmail')}
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            required
            className="w-full px-3 py-2.5 bg-neutral-800 border border-neutral-700 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-brand-600 text-sm"
          />
          <input
            type="tel"
            placeholder={t('onboard.ownerPhone')}
            value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
            className="w-full px-3 py-2.5 bg-neutral-800 border border-neutral-700 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-brand-600 text-sm"
          />

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
              {submitting ? '...' : t('leads.createLead')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
