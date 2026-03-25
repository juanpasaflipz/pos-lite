import React, { useState, useEffect, useCallback } from 'react';
import { Loader2, FileText, ChevronLeft, Settings, Clock } from 'lucide-react';
import { fetchAgentReports, fetchAgentReport, fetchAgentReportConfig, updateAgentReportConfig } from '../../api/index';

interface Report {
  id: number;
  report_date: string;
  report_type: string;
  content_md?: string;
  highlights?: any[];
  cost_usd: number;
  created_at: string;
}

interface ReportConfig {
  enabled: boolean;
  report_hour: number;
  timezone: string;
  delivery_method: string;
  custom_prompt: string | null;
}

export default function AgentReports() {
  const [reports, setReports] = useState<Report[]>([]);
  const [selectedReport, setSelectedReport] = useState<Report | null>(null);
  const [config, setConfig] = useState<ReportConfig | null>(null);
  const [showConfig, setShowConfig] = useState(false);
  const [loading, setLoading] = useState(true);
  const [savingConfig, setSavingConfig] = useState(false);

  useEffect(() => {
    loadReports();
  }, []);

  const loadReports = async () => {
    setLoading(true);
    try {
      const [reportsData, configData] = await Promise.all([
        fetchAgentReports(),
        fetchAgentReportConfig(),
      ]);
      setReports(reportsData.reports || []);
      setConfig(configData.config || null);
    } catch (err) {
      console.error('Failed to load reports:', err);
    } finally {
      setLoading(false);
    }
  };

  const loadFullReport = async (id: number) => {
    try {
      const data = await fetchAgentReport(id);
      setSelectedReport(data.report);
    } catch (err) {
      console.error('Failed to load report:', err);
    }
  };

  const handleToggleEnabled = useCallback(async () => {
    if (!config) return;
    setSavingConfig(true);
    try {
      await updateAgentReportConfig({ ...config, enabled: !config.enabled });
      setConfig(prev => prev ? { ...prev, enabled: !prev.enabled } : null);
    } catch (err) {
      console.error('Failed to update config:', err);
    } finally {
      setSavingConfig(false);
    }
  }, [config]);

  const handleSaveConfig = useCallback(async () => {
    if (!config) return;
    setSavingConfig(true);
    try {
      await updateAgentReportConfig(config);
      setShowConfig(false);
    } catch (err) {
      console.error('Failed to save config:', err);
    } finally {
      setSavingConfig(false);
    }
  }, [config]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-neutral-500" />
      </div>
    );
  }

  // Report detail view
  if (selectedReport) {
    return (
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="px-4 py-3 border-b border-neutral-700 flex items-center gap-2">
          <button
            onClick={() => setSelectedReport(null)}
            className="p-1 rounded hover:bg-neutral-700 text-neutral-400"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <div>
            <p className="text-sm font-medium text-neutral-200">
              {new Date(selectedReport.report_date).toLocaleDateString('en-US', {
                weekday: 'long',
                year: 'numeric',
                month: 'long',
                day: 'numeric',
              })}
            </p>
            <p className="text-[10px] text-neutral-500">
              {selectedReport.report_type} report
              {selectedReport.cost_usd > 0 && ` \u00B7 $${selectedReport.cost_usd.toFixed(4)}`}
            </p>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-4">
          <div className="prose prose-invert prose-sm max-w-none text-neutral-200">
            {(selectedReport.content_md || 'No content available.').split('\n').map((line, i) => {
              const rendered = line
                .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
                .replace(/^### (.*)/, '<h3>$1</h3>')
                .replace(/^## (.*)/, '<h2>$1</h2>')
                .replace(/^# (.*)/, '<h1>$1</h1>')
                .replace(/^- (.*)/, '<li>$1</li>');
              return <p key={i} className={i > 0 ? 'mt-1' : ''} dangerouslySetInnerHTML={{ __html: rendered }} />;
            })}
          </div>
        </div>
      </div>
    );
  }

  // Config panel
  if (showConfig && config) {
    return (
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="px-4 py-3 border-b border-neutral-700 flex items-center gap-2">
          <button
            onClick={() => setShowConfig(false)}
            className="p-1 rounded hover:bg-neutral-700 text-neutral-400"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <p className="text-sm font-medium text-neutral-200">Report Settings</p>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          <label className="flex items-center justify-between">
            <span className="text-sm text-neutral-300">Nightly reports</span>
            <button
              onClick={handleToggleEnabled}
              disabled={savingConfig}
              className={`relative w-10 h-5 rounded-full transition-colors ${
                config.enabled ? 'bg-brand-600' : 'bg-neutral-600'
              }`}
            >
              <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition-transform ${
                config.enabled ? 'left-5' : 'left-0.5'
              }`} />
            </button>
          </label>

          <div>
            <label className="block text-xs text-neutral-400 mb-1">Report hour (0-23)</label>
            <input
              type="number"
              min={0}
              max={23}
              value={config.report_hour}
              onChange={(e) => setConfig(prev => prev ? { ...prev, report_hour: parseInt(e.target.value) || 5 } : null)}
              className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-neutral-200"
            />
          </div>

          <div>
            <label className="block text-xs text-neutral-400 mb-1">Timezone</label>
            <select
              value={config.timezone}
              onChange={(e) => setConfig(prev => prev ? { ...prev, timezone: e.target.value } : null)}
              className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-neutral-200"
            >
              <option value="America/Mexico_City">Mexico City (CST)</option>
              <option value="America/New_York">New York (EST)</option>
              <option value="America/Chicago">Chicago (CST)</option>
              <option value="America/Denver">Denver (MST)</option>
              <option value="America/Los_Angeles">Los Angeles (PST)</option>
              <option value="America/Bogota">Bogota (COT)</option>
              <option value="America/Sao_Paulo">Sao Paulo (BRT)</option>
              <option value="Europe/Madrid">Madrid (CET)</option>
            </select>
          </div>

          <button
            onClick={handleSaveConfig}
            disabled={savingConfig}
            className="w-full py-2 rounded-lg bg-brand-600 hover:bg-brand-500 text-white text-sm font-medium disabled:opacity-50 transition-colors"
          >
            {savingConfig ? 'Saving...' : 'Save Settings'}
          </button>
        </div>
      </div>
    );
  }

  // Report list view
  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="px-4 py-3 border-b border-neutral-700 flex items-center justify-between">
        <p className="text-xs text-neutral-400">
          {config?.enabled ? (
            <span className="text-green-400">
              <Clock className="w-3 h-3 inline mr-1" />
              Runs daily at {config.report_hour}:00 ({config.timezone.split('/')[1]})
            </span>
          ) : (
            <span className="text-neutral-500">Nightly reports disabled</span>
          )}
        </p>
        <button
          onClick={() => setShowConfig(true)}
          className="p-1.5 rounded-lg hover:bg-neutral-700 text-neutral-400 hover:text-neutral-200 transition-colors"
        >
          <Settings className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {reports.length === 0 ? (
          <div className="text-center py-12 px-4">
            <FileText className="w-10 h-10 mx-auto text-neutral-600 mb-3" />
            <p className="text-sm text-neutral-400">No reports yet</p>
            <p className="text-xs text-neutral-500 mt-1">
              {config?.enabled
                ? 'Your first report will be generated tomorrow morning.'
                : 'Enable nightly reports in settings to get daily insights.'}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-neutral-800">
            {reports.map((report) => (
              <button
                key={report.id}
                onClick={() => loadFullReport(report.id)}
                className="w-full text-left px-4 py-3 hover:bg-neutral-800/50 transition-colors"
              >
                <p className="text-sm font-medium text-neutral-200">
                  {new Date(report.report_date).toLocaleDateString('en-US', {
                    weekday: 'short',
                    month: 'short',
                    day: 'numeric',
                  })}
                </p>
                <p className="text-xs text-neutral-500 mt-0.5">
                  {report.report_type}
                  {report.cost_usd > 0 && ` \u00B7 $${report.cost_usd.toFixed(4)}`}
                </p>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
