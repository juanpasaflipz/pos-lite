import React, { useEffect, useState, useCallback } from 'react';
import { RefreshCw, Check, Filter } from 'lucide-react';

interface AlertItem {
  id: number;
  created_at: string;
  severity: 'warning' | 'critical';
  category: string;
  title: string;
  message: string;
  metadata: string;
  acknowledged: boolean;
  acknowledged_at: string | null;
}

function getSecret(): string {
  return sessionStorage.getItem('admin_secret') || '';
}

export default function SAAlertsScreen() {
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');

  // Filters
  const [severityFilter, setSeverityFilter] = useState<string>('');
  const [ackFilter, setAckFilter] = useState<string>('');

  const flash = (text: string) => {
    setMsg(text);
    setTimeout(() => setMsg(''), 3000);
  };

  const fetchAlerts = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/admin/agent/alerts', {
        headers: { 'x-admin-secret': getSecret() },
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Error: ${res.status}`);
      }
      const data = await res.json();
      setAlerts(Array.isArray(data) ? data : []);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAlerts();
  }, [fetchAlerts]);

  const handleAcknowledge = async (alertId: number) => {
    try {
      const res = await fetch(`/admin/agent/alerts/${alertId}/acknowledge`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-secret': getSecret(),
        },
      });
      if (!res.ok) throw new Error('Failed to acknowledge');
      setAlerts(prev =>
        prev.map(a =>
          a.id === alertId
            ? { ...a, acknowledged: true, acknowledged_at: new Date().toISOString() }
            : a
        )
      );
      flash('Alert acknowledged');
    } catch (err: any) {
      flash(`Failed: ${err.message}`);
    }
  };

  const filteredAlerts = alerts.filter(a => {
    if (severityFilter && a.severity !== severityFilter) return false;
    if (ackFilter === 'yes' && !a.acknowledged) return false;
    if (ackFilter === 'no' && a.acknowledged) return false;
    return true;
  });

  const parseMetadata = (metaStr: string): Record<string, any> | null => {
    try {
      const parsed = JSON.parse(metaStr);
      return typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-black text-white tracking-tight">Alerts</h2>
        <div className="flex items-center gap-2">
          {msg && (
            <span className="text-sm text-green-400 bg-green-400/10 px-3 py-1 rounded-lg">{msg}</span>
          )}
          <button
            onClick={fetchAlerts}
            disabled={loading}
            className="flex items-center gap-2 px-3 py-2 bg-neutral-800 hover:bg-neutral-700 disabled:opacity-50 text-white text-sm rounded-lg transition-colors"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 text-neutral-400 text-sm">
          <Filter size={14} />
          <span>Filters:</span>
        </div>
        <select
          value={severityFilter}
          onChange={e => setSeverityFilter(e.target.value)}
          className="px-3 py-2 bg-neutral-900 border border-neutral-800 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-brand-600"
        >
          <option value="">All Severities</option>
          <option value="warning">Warning</option>
          <option value="critical">Critical</option>
        </select>
        <select
          value={ackFilter}
          onChange={e => setAckFilter(e.target.value)}
          className="px-3 py-2 bg-neutral-900 border border-neutral-800 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-brand-600"
        >
          <option value="">All Status</option>
          <option value="no">Unacknowledged</option>
          <option value="yes">Acknowledged</option>
        </select>
        <span className="text-neutral-500 text-sm ml-auto">
          {filteredAlerts.length} alert{filteredAlerts.length !== 1 ? 's' : ''}
        </span>
      </div>

      {error && <p className="text-red-400 text-sm">{error}</p>}

      {/* Alerts List */}
      {loading && alerts.length === 0 ? (
        <p className="text-neutral-400 animate-pulse py-8 text-center">Loading alerts...</p>
      ) : filteredAlerts.length === 0 ? (
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-8 text-center">
          <p className="text-neutral-500">No alerts match filters</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filteredAlerts.map(alert => {
            const meta = parseMetadata(alert.metadata);
            return (
              <div
                key={alert.id}
                className={`bg-neutral-900 border rounded-xl p-5 transition-colors ${
                  alert.acknowledged
                    ? 'border-neutral-800/50 opacity-70'
                    : alert.severity === 'critical'
                      ? 'border-red-800/50'
                      : 'border-yellow-800/50'
                }`}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    {/* Header */}
                    <div className="flex items-center gap-2 mb-1">
                      <span
                        className={`text-xs px-2 py-0.5 rounded font-semibold ${
                          alert.severity === 'critical'
                            ? 'bg-red-400/15 text-red-400'
                            : 'bg-yellow-400/15 text-yellow-400'
                        }`}
                      >
                        {alert.severity.toUpperCase()}
                      </span>
                      {alert.category && (
                        <span className="text-xs px-2 py-0.5 rounded bg-neutral-700/50 text-neutral-400">
                          {alert.category}
                        </span>
                      )}
                    </div>

                    {/* Title */}
                    <h4 className="text-white font-medium">{alert.title}</h4>

                    {/* Message */}
                    <p className="text-neutral-400 text-sm mt-1">{alert.message}</p>

                    {/* Metadata */}
                    {meta && Object.keys(meta).length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {Object.entries(meta).slice(0, 6).map(([key, val]) => (
                          <span key={key} className="text-xs bg-neutral-800 text-neutral-400 px-2 py-1 rounded">
                            <span className="text-neutral-500">{key}:</span> {String(val)}
                          </span>
                        ))}
                      </div>
                    )}

                    {/* Timestamp */}
                    <p className="text-neutral-500 text-xs mt-2">
                      {new Date(alert.created_at).toLocaleString()}
                      {alert.acknowledged && alert.acknowledged_at && (
                        <> &middot; Ack'd {new Date(alert.acknowledged_at).toLocaleString()}</>
                      )}
                    </p>
                  </div>

                  {/* Action */}
                  {!alert.acknowledged ? (
                    <button
                      onClick={() => handleAcknowledge(alert.id)}
                      className="flex items-center gap-1.5 px-3 py-2 bg-neutral-800 hover:bg-neutral-700 text-white text-sm rounded-lg transition-colors shrink-0"
                    >
                      <Check size={14} />
                      Acknowledge
                    </button>
                  ) : (
                    <span className="text-green-400/60 text-xs shrink-0 pt-1">Acknowledged</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
