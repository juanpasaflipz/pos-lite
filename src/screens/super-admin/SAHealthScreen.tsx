import React, { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';
import {
  getDetailedHealth,
  type DetailedHealthData,
} from '../../api/superAdmin';

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function statusColor(status: string): string {
  switch (status) {
    case 'ok': return 'text-green-400';
    case 'degraded': return 'text-yellow-400';
    case 'down': return 'text-red-400';
    default: return 'text-neutral-500';
  }
}

function statusBadge(status: string): string {
  switch (status) {
    case 'ok': return 'bg-green-400/15 text-green-400';
    case 'degraded': return 'bg-yellow-400/15 text-yellow-400';
    case 'down': return 'bg-red-400/15 text-red-400';
    default: return 'bg-neutral-700/50 text-neutral-500';
  }
}

export default function SAHealthScreen() {
  const { t } = useTranslation('superAdmin');
  const [health, setHealth] = useState<DetailedHealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const fetchHealth = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await getDetailedHealth();
      setHealth(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchHealth();
  }, [fetchHealth]);

  if (loading && !health) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-neutral-400 animate-pulse">{t('health.loading')}</p>
      </div>
    );
  }

  if (error && !health) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-red-400">{error}</p>
      </div>
    );
  }

  if (!health) return null;

  const poolData = [
    { label: t('health.tenantPool'), pool: health.pools.tenant },
    { label: t('health.adminPool'), pool: health.pools.admin },
  ];

  const services = Object.entries(health.services).filter(
    ([key]) => key !== 'dns'
  ) as [string, { status: string; latency_ms: number; message?: string }][];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-black text-white tracking-tight">
          {t('tabs.health')}
        </h2>
        <button
          onClick={fetchHealth}
          disabled={loading}
          className="flex items-center gap-2 px-3 py-2 bg-neutral-800 hover:bg-neutral-700 disabled:opacity-50 text-white text-sm rounded-lg transition-colors"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          {t('health.refresh')}
        </button>
      </div>

      {/* KPI Row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
          <p className="text-neutral-400 text-sm font-medium">{t('health.kpi.uptime')}</p>
          <p className="text-2xl font-bold text-white mt-1">{formatUptime(health.uptime_seconds)}</p>
        </div>
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
          <p className="text-neutral-400 text-sm font-medium">{t('health.kpi.node')}</p>
          <p className="text-2xl font-bold text-white mt-1">{health.node_version}</p>
        </div>
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
          <p className="text-neutral-400 text-sm font-medium">{t('health.kpi.cpus')}</p>
          <p className="text-2xl font-bold text-white mt-1">{health.os.cpus}</p>
        </div>
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
          <p className="text-neutral-400 text-sm font-medium">{t('health.kpi.postgres')}</p>
          <p className="text-2xl font-bold text-white mt-1">{health.postgres_version}</p>
        </div>
      </div>

      {/* Memory */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
          <h3 className="text-white font-semibold mb-3">{t('health.heapMemory')}</h3>
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-neutral-400">Used</span>
              <span className="text-white">{health.memory.heap_used_mb.toFixed(1)} MB</span>
            </div>
            <div className="h-2 rounded-full bg-neutral-800 overflow-hidden">
              <div
                className="h-full bg-brand-600 rounded-full transition-all"
                style={{ width: `${(health.memory.heap_used_mb / health.memory.heap_total_mb) * 100}%` }}
              />
            </div>
            <div className="flex justify-between text-xs text-neutral-500">
              <span>Total: {health.memory.heap_total_mb.toFixed(1)} MB</span>
              <span>{t('health.rss', { value: health.memory.rss_mb.toFixed(1) })}</span>
            </div>
          </div>
        </div>

        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
          <h3 className="text-white font-semibold mb-3">{t('health.osMemory')}</h3>
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-neutral-400">Used</span>
              <span className="text-white">{(health.os.total_mem_mb - health.os.free_mem_mb).toFixed(0)} MB</span>
            </div>
            <div className="h-2 rounded-full bg-neutral-800 overflow-hidden">
              <div
                className="h-full bg-brand-600 rounded-full transition-all"
                style={{ width: `${((health.os.total_mem_mb - health.os.free_mem_mb) / health.os.total_mem_mb) * 100}%` }}
              />
            </div>
            <div className="flex justify-between text-xs text-neutral-500">
              <span>Total: {health.os.total_mem_mb.toFixed(0)} MB</span>
              <span>Free: {health.os.free_mem_mb.toFixed(0)} MB</span>
            </div>
          </div>
        </div>
      </div>

      {/* Connection Pools */}
      <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
        <h3 className="text-white font-semibold mb-4">{t('health.connectionPools')}</h3>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {poolData.map((p, i) => (
            <div key={i} className="bg-neutral-800/50 rounded-lg p-4 space-y-2">
              <p className="text-white font-medium text-sm">{p.label}</p>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div>
                  <span className="text-neutral-400">{t('health.active')}:</span>
                  <span className="text-white ml-1">{p.pool.active}/{p.pool.max}</span>
                </div>
                <div>
                  <span className="text-neutral-400">{t('health.peak')}:</span>
                  <span className="text-white ml-1">{p.pool.peakActive}</span>
                </div>
                <div>
                  <span className="text-neutral-400">{t('health.successRate')}:</span>
                  <span className="text-white ml-1">
                    {p.pool.successes + p.pool.failures > 0
                      ? ((p.pool.successes / (p.pool.successes + p.pool.failures)) * 100).toFixed(1)
                      : '100'}%
                  </span>
                </div>
                <div>
                  <span className="text-neutral-400">{t('health.avgWait')}:</span>
                  <span className="text-white ml-1">{p.pool.avgWaitMs.toFixed(1)}ms</span>
                </div>
                <div>
                  <span className="text-neutral-400">{t('health.failures')}:</span>
                  <span className={`ml-1 ${p.pool.failures > 0 ? 'text-red-400' : 'text-green-400'}`}>
                    {p.pool.failures}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* External Services */}
      <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
        <h3 className="text-white font-semibold mb-4">{t('health.externalServices')}</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {services.map(([name, svc]) => (
            <div key={name} className="bg-neutral-800/50 rounded-lg p-4">
              <div className="flex items-center justify-between mb-1">
                <p className="text-white font-medium text-sm capitalize">{name}</p>
                <span className={`text-xs px-2 py-0.5 rounded font-medium ${statusBadge(svc.status)}`}>
                  {svc.status}
                </span>
              </div>
              <p className="text-neutral-500 text-xs">
                {t('health.latency', { value: svc.latency_ms })}
              </p>
              {svc.message && (
                <p className="text-neutral-500 text-xs mt-1 truncate">{svc.message}</p>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Error Rate & Throughput */}
      <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
        <h3 className="text-white font-semibold mb-4">{t('health.errorRate')}</h3>
        <div className="grid grid-cols-3 gap-4 mb-4">
          <div>
            <p className="text-neutral-400 text-xs">{t('health.totalRequests')}</p>
            <p className="text-white font-bold text-lg">{health.requests.totalRequests.toLocaleString()}</p>
          </div>
          <div>
            <p className="text-neutral-400 text-xs">{t('health.totalErrors')}</p>
            <p className="text-white font-bold text-lg">{health.requests.totalErrors.toLocaleString()}</p>
          </div>
          <div>
            <p className="text-neutral-400 text-xs">{t('health.currentErrorRate')}</p>
            <p className={`font-bold text-lg ${health.requests.errorRate > 5 ? 'text-red-400' : health.requests.errorRate > 1 ? 'text-yellow-400' : 'text-green-400'}`}>
              {health.requests.errorRate.toFixed(2)}%
            </p>
          </div>
        </div>

        {/* Recent Errors */}
        <h4 className="text-neutral-300 text-sm font-medium mb-2">{t('health.recentErrors')}</h4>
        {health.requests.recentErrors.length === 0 ? (
          <p className="text-neutral-500 text-sm">{t('health.noErrors')}</p>
        ) : (
          <div className="space-y-1 max-h-48 overflow-y-auto">
            {health.requests.recentErrors.slice(0, 10).map((err, i) => (
              <div key={i} className="flex items-start gap-3 py-1.5 px-3 bg-neutral-800/50 rounded text-xs">
                <span className="text-red-400 font-mono shrink-0">{err.status}</span>
                <span className="text-neutral-400 shrink-0">{err.method}</span>
                <span className="text-neutral-300 truncate flex-1">{err.path}</span>
                <span className="text-neutral-500 shrink-0">
                  {new Date(err.timestamp).toLocaleTimeString()}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Scheduler */}
      <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
        <div className="flex items-center gap-3 mb-4">
          <h3 className="text-white font-semibold">{t('health.aiScheduler')}</h3>
          <span className={`text-xs px-2 py-0.5 rounded font-medium ${health.scheduler.running ? 'bg-green-400/15 text-green-400' : 'bg-red-400/15 text-red-400'}`}>
            {health.scheduler.running ? t('health.schedulerRunning') : t('health.schedulerStopped')}
          </span>
        </div>
        {health.scheduler.jobs.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-neutral-800 text-neutral-400">
                  <th className="text-left px-3 py-2 font-medium">{t('health.jobName')}</th>
                  <th className="text-left px-3 py-2 font-medium">{t('health.interval')}</th>
                  <th className="text-left px-3 py-2 font-medium">{t('health.lastRun')}</th>
                  <th className="text-right px-3 py-2 font-medium">{t('health.runs')}</th>
                  <th className="text-left px-3 py-2 font-medium">{t('health.status')}</th>
                </tr>
              </thead>
              <tbody>
                {health.scheduler.jobs.map((job, i) => (
                  <tr key={i} className="border-b border-neutral-800/50">
                    <td className="px-3 py-2 text-white">{job.name}</td>
                    <td className="px-3 py-2 text-neutral-400">{(job.intervalMs / 60000).toFixed(0)}m</td>
                    <td className="px-3 py-2 text-neutral-400">
                      {job.lastRun ? new Date(job.lastRun).toLocaleTimeString() : t('health.never')}
                    </td>
                    <td className="px-3 py-2 text-right text-neutral-300">{job.runCount}</td>
                    <td className="px-3 py-2">
                      {job.lastError ? (
                        <span className="text-red-400 truncate block max-w-[200px]" title={job.lastError}>Error</span>
                      ) : (
                        <span className="text-green-400">OK</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
