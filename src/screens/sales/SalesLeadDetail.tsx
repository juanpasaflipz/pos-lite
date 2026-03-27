import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams, useNavigate } from 'react-router-dom';
import { getLead, updateLead, logActivity, type Lead, type SalesActivity } from '../../api/salesApi';

const STATUSES = ['new', 'contacted', 'demo_scheduled', 'negotiating', 'converted', 'lost'];
const ACTIVITY_TYPES = ['call', 'email', 'meeting', 'demo', 'note', 'follow_up'];

const STATUS_COLORS: Record<string, string> = {
  new: 'bg-blue-500/20 text-blue-400',
  contacted: 'bg-yellow-500/20 text-yellow-400',
  demo_scheduled: 'bg-purple-500/20 text-purple-400',
  negotiating: 'bg-orange-500/20 text-orange-400',
  converted: 'bg-green-500/20 text-green-400',
  lost: 'bg-red-500/20 text-red-400',
};

export default function SalesLeadDetail() {
  const { t } = useTranslation('sales');
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [lead, setLead] = useState<Lead | null>(null);
  const [activities, setActivities] = useState<SalesActivity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notes, setNotes] = useState('');
  const [savingNotes, setSavingNotes] = useState(false);
  const [showActivityForm, setShowActivityForm] = useState(false);
  const [activityType, setActivityType] = useState('call');
  const [activityDesc, setActivityDesc] = useState('');
  const [submittingActivity, setSubmittingActivity] = useState(false);

  const fetchLead = () => {
    if (!id) return;
    setLoading(true);
    getLead(Number(id))
      .then((data) => {
        setLead(data.lead);
        setActivities(data.activities);
        setNotes(data.lead.notes || '');
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchLead();
  }, [id]);

  const handleStatusChange = async (newStatus: string) => {
    if (!lead) return;
    try {
      const updated = await updateLead(lead.id, { status: newStatus } as Partial<Lead>);
      setLead(updated);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleSaveNotes = async () => {
    if (!lead) return;
    setSavingNotes(true);
    try {
      const updated = await updateLead(lead.id, { notes } as Partial<Lead>);
      setLead(updated);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSavingNotes(false);
    }
  };

  const handleLogActivity = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!lead) return;
    setSubmittingActivity(true);
    try {
      await logActivity(lead.id, { activity_type: activityType, description: activityDesc });
      setActivityDesc('');
      setShowActivityForm(false);
      fetchLead();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSubmittingActivity(false);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <div className="text-brand-600 animate-pulse">Loading...</div>
      </div>
    );
  }

  if (error && !lead) {
    return <div className="text-red-400 bg-red-900/20 border border-red-800 rounded-lg p-4">{error}</div>;
  }

  if (!lead) return null;

  return (
    <div className="space-y-6">
      {/* Back button */}
      <button
        onClick={() => navigate('/sales/leads')}
        className="text-neutral-400 hover:text-white text-sm transition flex items-center gap-1"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
        {t('leads.title')}
      </button>

      {/* Lead Info Card */}
      <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h1 className="text-xl font-bold text-white">
              {lead.restaurant_name || lead.name || lead.email}
            </h1>
            <p className="text-neutral-500 text-sm mt-1">{lead.email}</p>
            {lead.phone && <p className="text-neutral-500 text-sm">{lead.phone}</p>}
          </div>
          <span
            className={`text-xs px-2.5 py-1 rounded-full font-medium ${
              STATUS_COLORS[lead.status] || 'bg-neutral-700 text-neutral-300'
            }`}
          >
            {t(`leads.statuses.${lead.status}`, lead.status)}
          </span>
        </div>

        {/* Status Update */}
        <div className="flex items-center gap-3 mb-4">
          <label className="text-sm text-neutral-400">{t('leads.status')}:</label>
          <select
            value={lead.status}
            onChange={(e) => handleStatusChange(e.target.value)}
            className="bg-neutral-800 border border-neutral-700 text-white text-sm rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-brand-600"
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`leads.statuses.${s}`, s)}
              </option>
            ))}
          </select>
        </div>

        {/* Notes */}
        <div>
          <label className="block text-sm font-medium text-neutral-400 mb-1.5">Notes</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            className="w-full px-3 py-2.5 bg-neutral-800 border border-neutral-700 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-brand-600 text-sm resize-none"
          />
          <button
            onClick={handleSaveNotes}
            disabled={savingNotes}
            className="mt-2 px-4 py-1.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 text-sm rounded-lg transition disabled:opacity-50"
          >
            {savingNotes ? '...' : 'Save Notes'}
          </button>
        </div>

        {error && (
          <div className="text-red-400 text-sm mt-3">{error}</div>
        )}
      </div>

      {/* Activity Timeline */}
      <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-white">{t('leads.activity.title')}</h2>
          <button
            onClick={() => setShowActivityForm(!showActivityForm)}
            className="px-3 py-1.5 bg-brand-600 hover:bg-brand-700 text-white text-sm rounded-lg transition"
          >
            {t('leads.activity.logActivity')}
          </button>
        </div>

        {/* Log Activity Form */}
        {showActivityForm && (
          <form onSubmit={handleLogActivity} className="mb-5 bg-neutral-800/50 rounded-lg p-4 space-y-3">
            <select
              value={activityType}
              onChange={(e) => setActivityType(e.target.value)}
              className="w-full bg-neutral-800 border border-neutral-700 text-white text-sm rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-brand-600"
            >
              {ACTIVITY_TYPES.map((at) => (
                <option key={at} value={at}>
                  {t(`leads.activity.types.${at}`, at)}
                </option>
              ))}
            </select>
            <textarea
              value={activityDesc}
              onChange={(e) => setActivityDesc(e.target.value)}
              placeholder="Description..."
              rows={2}
              className="w-full px-3 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-brand-600 text-sm resize-none"
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setShowActivityForm(false)}
                className="px-3 py-1.5 bg-neutral-700 text-neutral-300 text-sm rounded-lg transition hover:bg-neutral-600"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submittingActivity}
                className="px-3 py-1.5 bg-brand-600 hover:bg-brand-700 text-white text-sm rounded-lg transition disabled:opacity-50"
              >
                {submittingActivity ? '...' : 'Log'}
              </button>
            </div>
          </form>
        )}

        {/* Timeline */}
        {activities.length === 0 ? (
          <p className="text-neutral-500 text-sm">No activity recorded yet.</p>
        ) : (
          <div className="space-y-3">
            {activities.map((a) => (
              <div key={a.id} className="flex gap-3">
                <div className="w-2 h-2 rounded-full bg-brand-600 mt-2 flex-shrink-0" />
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-neutral-300 capitalize">
                      {t(`leads.activity.types.${a.activity_type}`, a.activity_type)}
                    </span>
                    <span className="text-xs text-neutral-600">
                      {new Date(a.created_at).toLocaleString()}
                    </span>
                  </div>
                  {a.description && (
                    <p className="text-sm text-neutral-400 mt-0.5">{a.description}</p>
                  )}
                  {a.rep_name && (
                    <p className="text-xs text-neutral-600 mt-0.5">by {a.rep_name}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
