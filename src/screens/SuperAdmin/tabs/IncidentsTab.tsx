import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw, ChevronDown, ChevronRight, ShieldCheck } from 'lucide-react';
import { getAdminIncidents, type AdminIncident } from '../../../api/superAdmin';

/**
 * Cross-tenant Sentinel incident feed (read-only).
 *
 * Deliberately has no approve/dismiss controls: acting on an incident goes
 * through the tenant's own panel where the playbook precondition guards and
 * RLS scoping live. This view answers "is anything on fire, and where?".
 */

const ACTIVE_STATUSES = ['open', 'diagnosing', 'waiting_approval', 'needs_human'];

const sevCls: Record<string, string> = {
  critical: 'bg-cockpit-red/40 text-cockpit-out-text',
  high: 'bg-amber-500/20 text-amber-300',
  medium: 'bg-amber-500/10 text-amber-200',
  low: 'bg-neutral-800 text-neutral-400',
};

const statusCls = (status: string) =>
  ACTIVE_STATUSES.includes(status)
    ? 'bg-brand-900/40 text-brand-300'
    : 'bg-neutral-800 text-neutral-500';

const fmtWhen = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

type StatusFilter = 'active' | 'all' | 'resolved' | 'dismissed';

const IncidentsTab: React.FC = () => {
  const { t } = useTranslation('superAdmin');
  const [incidents, setIncidents] = useState<AdminIncident[] | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('active');
  const [expanded, setExpanded] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    const params = statusFilter === 'all' ? { limit: 200 }
      : statusFilter === 'active' ? { limit: 200 }
      : { status: statusFilter, limit: 200 };
    getAdminIncidents(params)
      .then((rows) => {
        setIncidents(statusFilter === 'active' ? rows.filter((r) => ACTIVE_STATUSES.includes(r.status)) : rows);
      })
      .catch((e) => setError(e.message));
  }, [statusFilter]);

  useEffect(load, [load]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex gap-1">
          {(['active', 'all', 'resolved', 'dismissed'] as StatusFilter[]).map((f) => (
            <button
              key={f}
              onClick={() => setStatusFilter(f)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition ${
                statusFilter === f
                  ? 'bg-brand-600 text-white'
                  : 'bg-neutral-900 border border-neutral-800 text-neutral-400 hover:text-neutral-200'
              }`}
            >
              {t(`incidents.filters.${f}`)}
            </button>
          ))}
        </div>
        <button
          onClick={load}
          className="px-3 py-2 bg-neutral-900 border border-neutral-800 rounded-lg text-neutral-300 hover:bg-neutral-800 transition"
          title="Refresh"
        >
          <RefreshCw size={16} />
        </button>
      </div>

      {error && <div className="text-cockpit-out-text">{error}</div>}

      {!incidents ? (
        <div className="text-neutral-400">{t('incidents.loading')}</div>
      ) : incidents.length === 0 ? (
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-10 text-center">
          <ShieldCheck size={28} className="mx-auto text-cockpit-in-text mb-3" />
          <div className="text-neutral-300 font-medium">{t('incidents.allClear')}</div>
          <div className="text-sm text-neutral-500 mt-1">{t('incidents.allClearSub')}</div>
        </div>
      ) : (
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-neutral-950 border-b border-neutral-800">
              <tr className="text-left text-xs uppercase tracking-wider text-neutral-500">
                <th className="px-4 py-3 w-8"></th>
                <th className="px-4 py-3">{t('incidents.columns.severity')}</th>
                <th className="px-4 py-3">{t('incidents.columns.tenant')}</th>
                <th className="px-4 py-3">{t('incidents.columns.sensor')}</th>
                <th className="px-4 py-3">{t('incidents.columns.status')}</th>
                <th className="px-4 py-3">{t('incidents.columns.lastSeen')}</th>
              </tr>
            </thead>
            <tbody>
              {incidents.map((inc) => (
                <React.Fragment key={inc.id}>
                  <tr
                    onClick={() => setExpanded(expanded === inc.id ? null : inc.id)}
                    className="border-b border-neutral-800 hover:bg-neutral-800/50 cursor-pointer transition"
                  >
                    <td className="px-4 py-3 text-neutral-500">
                      {expanded === inc.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded text-xs font-semibold ${sevCls[inc.severity] || sevCls.low}`}>
                        {inc.severity}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-white">{inc.tenant_name || inc.tenant_id}</div>
                      <div className="text-xs text-neutral-500">{inc.tenant_subdomain || inc.tenant_id}</div>
                    </td>
                    <td className="px-4 py-3 text-neutral-300 font-mono text-xs">{inc.sensor}</td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded text-xs font-semibold ${statusCls(inc.status)}`}>
                        {inc.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-neutral-400 text-xs">{fmtWhen(inc.last_seen_at)}</td>
                  </tr>
                  {expanded === inc.id && (
                    <tr className="border-b border-neutral-800 bg-neutral-950/60">
                      <td colSpan={6} className="px-6 py-4">
                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 text-xs">
                          <div>
                            <div className="text-neutral-500 uppercase tracking-wider mb-1">{t('incidents.evidence')}</div>
                            <pre className="bg-neutral-950 border border-neutral-800 rounded p-3 text-neutral-300 overflow-x-auto whitespace-pre-wrap">
                              {JSON.stringify(inc.evidence, null, 2)}
                            </pre>
                          </div>
                          <div>
                            <div className="text-neutral-500 uppercase tracking-wider mb-1">{t('incidents.diagnosis')}</div>
                            {inc.diagnosis ? (
                              <pre className="bg-neutral-950 border border-neutral-800 rounded p-3 text-neutral-300 overflow-x-auto whitespace-pre-wrap">
                                {JSON.stringify(inc.diagnosis, null, 2)}
                              </pre>
                            ) : (
                              <div className="text-neutral-600">{t('incidents.noDiagnosis')}</div>
                            )}
                            <div className="text-neutral-500 mt-3">
                              {t('incidents.firstSeen')} {fmtWhen(inc.first_seen_at)}
                              {inc.resolved_at && <> · {t('incidents.resolvedAt')} {fmtWhen(inc.resolved_at)}</>}
                            </div>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default IncidentsTab;
