import React, { useEffect, useState, useCallback } from 'react';
import { RefreshCw, Check, AlertTriangle, Shield } from 'lucide-react';

interface MonitoringRule {
  id: number;
  name: string;
  metric_type: string;
  metric_name: string;
  condition: string;
  threshold: number;
  severity: string;
  cooldown_minutes: number;
  webhook_url: string | null;
  enabled: boolean;
}

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

async function adminFetch<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(endpoint, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'x-admin-secret': getSecret(),
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Error: ${res.status}`);
  }
  return res.json();
}

export default function SAAgentMonitorScreen() {
  const [rules, setRules] = useState<MonitoringRule[]>([]);
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [loadingRules, setLoadingRules] = useState(true);
  const [loadingAlerts, setLoadingAlerts] = useState(true);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');

  const flash = (text: string) => {
    setMsg(text);
    setTimeout(() => setMsg(''), 3000);
  };

  const fetchRules = useCallback(async () => {
    setLoadingRules(true);
    try {
      const data = await adminFetch<MonitoringRule[]>('/admin/agent/monitor/rules');
      setRules(Array.isArray(data) ? data : []);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoadingRules(false);
    }
  }, []);

  const fetchAlerts = useCallback(async () => {
    setLoadingAlerts(true);
    try {
      const data = await adminFetch<AlertItem[]>('/admin/agent/alerts');
      setAlerts(Array.isArray(data) ? data : []);
    } catch (err: any) {
      // Non-blocking: alerts may not be available
    } finally {
      setLoadingAlerts(false);
    }
  }, []);

  useEffect(() => {
    fetchRules();
    fetchAlerts();
  }, [fetchRules, fetchAlerts]);

  const handleToggleRule = async (rule: MonitoringRule) => {
    try {
      await adminFetch(`/admin/agent/monitor/rules/${rule.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !rule.enabled }),
      });
      setRules(prev => prev.map(r => r.id === rule.id ? { ...r, enabled: !r.enabled } : r));
      flash(`Rule "${rule.name}" ${!rule.enabled ? 'enabled' : 'disabled'}`);
    } catch (err: any) {
      flash(`Failed: ${err.message}`);
    }
  };

  const handleAcknowledge = async (alertId: number) => {
    try {
      await adminFetch(`/admin/agent/alerts/${alertId}/acknowledge`, { method: 'PATCH' });
      setAlerts(prev => prev.map(a => a.id === alertId ? { ...a, acknowledged: true, acknowledged_at: new Date().toISOString() } : a));
      flash('Alert acknowledged');
    } catch (err: any) {
      flash(`Failed: ${err.message}`);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-black text-white tracking-tight">Monitoring</h2>
        <div className="flex items-center gap-2">
          {msg && (
            <span className="text-sm text-green-400 bg-green-400/10 px-3 py-1 rounded-lg">{msg}</span>
          )}
          <button
            onClick={() => { fetchRules(); fetchAlerts(); }}
            disabled={loadingRules || loadingAlerts}
            className="flex items-center gap-2 px-3 py-2 bg-neutral-800 hover:bg-neutral-700 disabled:opacity-50 text-white text-sm rounded-lg transition-colors"
          >
            <RefreshCw size={14} className={(loadingRules || loadingAlerts) ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
      </div>

      {error && <p className="text-red-400 text-sm">{error}</p>}

      {/* Monitoring Rules */}
      <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
        <div className="flex items-center gap-2 mb-4">
          <Shield size={18} className="text-brand-400" />
          <h3 className="text-white font-semibold">Monitoring Rules</h3>
        </div>

        {loadingRules ? (
          <p className="text-neutral-400 animate-pulse text-sm">Loading rules...</p>
        ) : rules.length === 0 ? (
          <p className="text-neutral-500 text-sm">No monitoring rules configured</p>
        ) : (
          <div className="space-y-2">
            {rules.map(rule => (
              <div
                key={rule.id}
                className="flex items-center justify-between py-3 px-4 bg-neutral-800/50 rounded-lg"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-white text-sm font-medium">{rule.name}</p>
                    <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                      rule.severity === 'critical'
                        ? 'bg-red-400/15 text-red-400'
                        : 'bg-yellow-400/15 text-yellow-400'
                    }`}>
                      {rule.severity}
                    </span>
                  </div>
                  <p className="text-neutral-500 text-xs mt-0.5">
                    {rule.metric_type}.{rule.metric_name} {rule.condition} {rule.threshold}
                    {' '}&middot; Cooldown: {rule.cooldown_minutes}m
                  </p>
                </div>
                <button
                  onClick={() => handleToggleRule(rule)}
                  className={`ml-3 relative w-10 h-5 rounded-full transition-colors ${
                    rule.enabled ? 'bg-brand-600' : 'bg-neutral-700'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                      rule.enabled ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Recent Alerts */}
      <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
        <div className="flex items-center gap-2 mb-4">
          <AlertTriangle size={18} className="text-yellow-400" />
          <h3 className="text-white font-semibold">Recent Alerts</h3>
        </div>

        {loadingAlerts ? (
          <p className="text-neutral-400 animate-pulse text-sm">Loading alerts...</p>
        ) : alerts.length === 0 ? (
          <p className="text-neutral-500 text-sm">No alerts</p>
        ) : (
          <div className="space-y-2">
            {alerts.slice(0, 20).map(alert => (
              <div
                key={alert.id}
                className={`py-3 px-4 rounded-lg ${
                  alert.acknowledged ? 'bg-neutral-800/30' : 'bg-neutral-800/50'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                        alert.severity === 'critical'
                          ? 'bg-red-400/15 text-red-400'
                          : 'bg-yellow-400/15 text-yellow-400'
                      }`}>
                        {alert.severity}
                      </span>
                      <p className="text-white text-sm font-medium truncate">{alert.title}</p>
                    </div>
                    <p className="text-neutral-400 text-xs mt-1 line-clamp-2">{alert.message}</p>
                    <p className="text-neutral-500 text-xs mt-1">
                      {new Date(alert.created_at).toLocaleString()}
                      {alert.category && <> &middot; {alert.category}</>}
                    </p>
                  </div>
                  {!alert.acknowledged && (
                    <button
                      onClick={() => handleAcknowledge(alert.id)}
                      className="flex items-center gap-1.5 px-2.5 py-1.5 bg-neutral-700 hover:bg-neutral-600 text-white text-xs rounded transition-colors shrink-0"
                    >
                      <Check size={12} />
                      Ack
                    </button>
                  )}
                  {alert.acknowledged && (
                    <span className="text-green-400/70 text-xs shrink-0">Acknowledged</span>
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
