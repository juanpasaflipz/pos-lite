import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';
import { getDetailedHealth, type DetailedHealthData, type ServiceStatus } from '../../../api/superAdmin';

const fmtMs = (n: number) => (n < 1000 ? `${n.toFixed(0)}ms` : `${(n / 1000).toFixed(2)}s`);
const fmtUptime = (s: number) => {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
};

const statusColor = (s: ServiceStatus['status']) => ({
  ok: 'bg-cockpit-green/40 text-cockpit-green',
  degraded: 'bg-cockpit-yellow/40 text-cockpit-yellow',
  down: 'bg-cockpit-red/40 text-cockpit-red',
  unconfigured: 'bg-neutral-800 text-neutral-400',
}[s]);

const HealthTab: React.FC = () => {
  const { t } = useTranslation('superAdmin');
  const [data, setData] = useState<DetailedHealthData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = () => {
    setLoading(true);
    setErr(null);
    getDetailedHealth()
      .then(setData)
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  if (!data && !err) return <div className="text-neutral-400">{t('health.loading')}</div>;
  if (err) return <div className="text-cockpit-red">{err}</div>;
  if (!data) return null;

  const heapPct = (data.memory.heap_used_mb / data.memory.heap_total_mb) * 100;
  const osUsed = data.os.total_mem_mb - data.os.free_mem_mb;
  const osPct = (osUsed / data.os.total_mem_mb) * 100;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 flex-1">
          <Kpi label={t('health.kpi.uptime')} value={fmtUptime(data.uptime_seconds)} />
          <Kpi label={t('health.kpi.node')} value={data.node_version} />
          <Kpi label={t('health.kpi.cpus')} value={String(data.os.cpus)} />
          <Kpi label={t('health.kpi.postgres')} value={data.postgres_version?.split(' ')[1] || '—'} />
        </div>
        <button onClick={load} disabled={loading} className="ml-4 px-3 py-2 bg-neutral-900 border border-neutral-800 rounded-lg text-neutral-300 hover:bg-neutral-800 transition disabled:opacity-50">
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Memory */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card title={t('health.heapMemory')} subtitle={t('health.rss', { value: data.memory.rss_mb.toFixed(0) })}>
          <Bar pct={heapPct} label={`${data.memory.heap_used_mb.toFixed(0)} / ${data.memory.heap_total_mb.toFixed(0)} MB`} />
        </Card>
        <Card title={t('health.osMemory')}>
          <Bar pct={osPct} label={`${osUsed.toFixed(0)} / ${data.os.total_mem_mb.toFixed(0)} MB`} />
        </Card>
      </div>

      {/* Pools */}
      <Card title={t('health.connectionPools')}>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <PoolCard label={t('health.tenantPool')} pool={data.pools.tenant} />
          <PoolCard label={t('health.adminPool')} pool={data.pools.admin} />
        </div>
      </Card>

      {/* Services */}
      <Card title={t('health.externalServices')}>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {Object.entries({
            postgres: data.services.postgres,
            stripe: data.services.stripe,
            twilio: data.services.twilio,
            grok: data.services.grok,
          }).map(([name, svc]) => (
            <div key={name} className="bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-2 flex items-center justify-between">
              <div>
                <div className="text-sm text-neutral-200 capitalize">{name}</div>
                {svc.latency_ms > 0 && (
                  <div className="text-xs text-neutral-500">{t('health.latency', { value: svc.latency_ms })}</div>
                )}
              </div>
              <span className={`px-2 py-0.5 rounded text-xs font-semibold ${statusColor(svc.status)}`}>{svc.status}</span>
            </div>
          ))}
        </div>
      </Card>

      {/* Scheduler */}
      <Card
        title={t('health.aiScheduler')}
        subtitle={data.scheduler.running ? t('health.schedulerRunning') : t('health.schedulerStopped')}
      >
        {data.scheduler.jobs.length === 0 ? (
          <p className="text-sm text-neutral-500">—</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider text-neutral-500 border-b border-neutral-800">
                  <th className="py-2 pr-4">{t('health.jobName')}</th>
                  <th className="py-2 pr-4">{t('health.interval')}</th>
                  <th className="py-2 pr-4">{t('health.lastRun')}</th>
                  <th className="py-2 pr-4 text-right">{t('health.runs')}</th>
                  <th className="py-2">{t('health.status')}</th>
                </tr>
              </thead>
              <tbody>
                {data.scheduler.jobs.map((job) => (
                  <tr key={job.name} className="border-b border-neutral-800/60">
                    <td className="py-2 pr-4 text-neutral-200">{job.name}</td>
                    <td className="py-2 pr-4 text-neutral-400">{Math.round(job.intervalMs / 1000)}s</td>
                    <td className="py-2 pr-4 text-neutral-400">
                      {job.lastRun ? new Date(job.lastRun).toLocaleTimeString() : t('health.never')}
                    </td>
                    <td className="py-2 pr-4 text-right text-neutral-300">{job.runCount}</td>
                    <td className="py-2">
                      {job.lastError ? (
                        <span className="text-cockpit-red text-xs" title={job.lastError}>error</span>
                      ) : (
                        <span className="text-cockpit-green text-xs">ok</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Requests */}
      <Card title={t('health.errorRate')}>
        <div className="grid grid-cols-3 gap-3 mb-4">
          <MiniKpi label={t('health.totalRequests')} value={data.requests.totalRequests.toLocaleString()} />
          <MiniKpi label={t('health.totalErrors')} value={data.requests.totalErrors.toLocaleString()} />
          <MiniKpi label={t('health.currentErrorRate')} value={`${(data.requests.errorRate * 100).toFixed(2)}%`} />
        </div>
        <div>
          <div className="text-xs text-neutral-400 mb-2">{t('health.recentErrors')}</div>
          {data.requests.recentErrors.length === 0 ? (
            <p className="text-sm text-neutral-500">{t('health.noErrors')}</p>
          ) : (
            <ul className="space-y-1 text-xs font-mono max-h-64 overflow-y-auto">
              {data.requests.recentErrors.slice(0, 20).map((e, i) => (
                <li key={i} className="flex gap-3 text-neutral-400">
                  <span className="text-neutral-600">{new Date(e.timestamp).toLocaleTimeString()}</span>
                  <span className="text-cockpit-red">{e.status}</span>
                  <span className="text-neutral-300">{e.method}</span>
                  <span className="truncate">{e.path}</span>
                  {e.tenant && <span className="text-brand-400">[{e.tenant}]</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
    </div>
  );
};

const Kpi: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-4">
    <div className="text-xs uppercase tracking-wider text-neutral-500">{label}</div>
    <div className="text-xl font-bold text-white mt-1 truncate">{value}</div>
  </div>
);

const MiniKpi: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="bg-neutral-950 border border-neutral-800 rounded-lg p-3">
    <div className="text-xs text-neutral-500">{label}</div>
    <div className="text-lg font-semibold text-white mt-0.5">{value}</div>
  </div>
);

const Card: React.FC<{ title: string; subtitle?: string; children: React.ReactNode }> = ({ title, subtitle, children }) => (
  <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
    <div className="flex items-center justify-between mb-4">
      <h3 className="text-sm font-semibold text-neutral-300">{title}</h3>
      {subtitle && <span className="text-xs text-neutral-500">{subtitle}</span>}
    </div>
    {children}
  </div>
);

const Bar: React.FC<{ pct: number; label: string }> = ({ pct, label }) => (
  <div>
    <div className="flex justify-between text-xs text-neutral-400 mb-1">
      <span>{label}</span>
      <span>{pct.toFixed(0)}%</span>
    </div>
    <div className="h-2 bg-neutral-800 rounded-full overflow-hidden">
      <div
        className={`h-full ${pct > 90 ? 'bg-cockpit-red' : pct > 70 ? 'bg-cockpit-yellow' : 'bg-brand-600'}`}
        style={{ width: `${Math.min(pct, 100)}%` }}
      />
    </div>
  </div>
);

const PoolCard: React.FC<{ label: string; pool: DetailedHealthData['pools']['tenant'] }> = ({ label, pool }) => {
  const { t } = useTranslation('superAdmin');
  const pct = pool.max > 0 ? (pool.active / pool.max) * 100 : 0;
  const successRate = pool.totalReserves > 0 ? (pool.successes / pool.totalReserves) * 100 : 100;
  return (
    <div className="bg-neutral-950 border border-neutral-800 rounded-lg p-4">
      <div className="text-sm font-semibold text-neutral-200 mb-3">{label}</div>
      <Bar pct={pct} label={`${pool.active} / ${pool.max} ${t('health.active')}`} />
      <div className="grid grid-cols-3 gap-2 mt-3 text-xs">
        <Stat label={t('health.successRate')} value={`${successRate.toFixed(1)}%`} />
        <Stat label={t('health.avgWait')} value={fmtMs(pool.avgWaitMs)} />
        <Stat label={t('health.peak')} value={String(pool.peakActive)} />
      </div>
      {pool.failures > 0 && (
        <div className="mt-2 text-xs text-cockpit-red">
          {t('health.failures')}: {pool.failures}
        </div>
      )}
    </div>
  );
};

const Stat: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div>
    <div className="text-neutral-500">{label}</div>
    <div className="text-neutral-200 font-semibold">{value}</div>
  </div>
);

export default HealthTab;
