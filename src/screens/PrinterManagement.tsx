import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Plus, Printer as PrinterIcon, Wifi, WifiOff, KeyRound, FileCheck, Activity, CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import {
  getPrinters,
  createPrinter,
  updatePrinter,
  getCategoryPrinterRoutes,
  updateCategoryPrinterRoute,
  getCategories,
  getPrintBridgeStatus,
  generatePrintAgentToken,
  sendTestPrint,
  pingPrinter,
  getPrintJobStatus,
  PrintBridgeStatus,
} from '../api';
import { Printer, MenuCategory } from '../types';
import BrandLogo from '../components/BrandLogo';
import FeatureGate from '../components/FeatureGate';

export default function PrinterManagement() {
  const { t } = useTranslation('inventory');
  const [printers, setPrinters] = useState<Printer[]>([]);
  const [categories, setCategories] = useState<MenuCategory[]>([]);
  const [routes, setRoutes] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddPrinter, setShowAddPrinter] = useState(false);
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState('receipt');
  const [newAddress, setNewAddress] = useState('');
  const [bridge, setBridge] = useState<PrintBridgeStatus | null>(null);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [testSent, setTestSent] = useState(false);
  // Connectivity checks keyed by printer id ('default' = bridge default printer)
  const [pingResults, setPingResults] = useState<Record<string, { state: 'running' | 'ok' | 'fail'; message?: string }>>({});

  useEffect(() => {
    fetchData();
    fetchBridge();
    const interval = setInterval(fetchBridge, 15000);
    return () => clearInterval(interval);
  }, []);

  const fetchBridge = async () => {
    try {
      setBridge(await getPrintBridgeStatus());
    } catch (err) {
      console.error('Failed to load bridge status:', err);
    }
  };

  const handleGenerateToken = async () => {
    if (bridge?.configured && !window.confirm(t('printers.bridge.rotateConfirm'))) return;
    try {
      const { token } = await generatePrintAgentToken();
      setNewToken(token);
      fetchBridge();
    } catch (err) {
      console.error('Failed to generate token:', err);
    }
  };

  const handleTestPrint = async () => {
    try {
      await sendTestPrint(null);
      setTestSent(true);
      setTimeout(() => setTestSent(false), 4000);
    } catch (err) {
      console.error('Failed to send test print:', err);
    }
  };

  // End-to-end connectivity check: server enqueues a ping job, the on-site
  // bridge claims it and opens a TCP socket to the printer (no paper), then
  // reports back. We poll the job until it lands. Typical round-trip: 3-8s.
  const handlePingPrinter = async (printerId: number | null) => {
    const key = printerId === null ? 'default' : String(printerId);
    const setResult = (state: 'running' | 'ok' | 'fail', message?: string) =>
      setPingResults((prev) => ({ ...prev, [key]: { state, message } }));

    setResult('running');
    try {
      const res = await pingPrinter(printerId);
      if (res.status === 'not_configured') {
        setResult('fail', t('printers.ping.notConfigured'));
        return;
      }
      if (res.status === 'bridge_offline') {
        setResult('fail', t('printers.ping.bridgeOffline'));
        return;
      }
      // Poll the job: bridge claim poll is 3s + 5s socket timeout worst case
      const jobId = res.job_id!;
      for (let i = 0; i < 16; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        const job = await getPrintJobStatus(jobId);
        if (job.status === 'done') {
          setResult('ok', t('printers.ping.ok'));
          return;
        }
        if (job.status === 'error') {
          setResult('fail', t('printers.ping.fail', { error: job.last_error || '' }));
          return;
        }
      }
      setResult('fail', t('printers.ping.timeout'));
    } catch (err) {
      console.error('Printer ping failed:', err);
      setResult('fail', t('printers.ping.timeout'));
    }
  };

  const fetchData = async () => {
    try {
      setLoading(true);
      const [printersData, categoriesData, routesData] = await Promise.all([
        getPrinters(),
        getCategories(),
        getCategoryPrinterRoutes(),
      ]);
      setPrinters(printersData);
      setCategories(categoriesData);
      setRoutes(routesData);
    } catch (err) {
      console.error('Failed to load printer data:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleCreatePrinter = async () => {
    if (!newName.trim()) return;
    try {
      await createPrinter({ name: newName, printer_type: newType, address: newAddress });
      setNewName('');
      setNewAddress('');
      setShowAddPrinter(false);
      fetchData();
    } catch (err) {
      console.error('Failed to create printer:', err);
    }
  };

  const handleTogglePrinter = async (printer: Printer) => {
    try {
      await updatePrinter(printer.id, { active: !printer.active });
      fetchData();
    } catch (err) {
      console.error('Failed to toggle printer:', err);
    }
  };

  const handleRouteChange = async (categoryId: number, printerId: number | null) => {
    try {
      await updateCategoryPrinterRoute(categoryId, printerId);
      fetchData();
    } catch (err) {
      console.error('Failed to update route:', err);
    }
  };

  const getRouteForCategory = (categoryId: number) => {
    return routes.find((r) => r.category_id === categoryId);
  };

  const renderPingResult = (key: string) => {
    const result = pingResults[key];
    if (!result || result.state === 'running') return null;
    return (
      <p className={`text-sm mt-1 flex items-center gap-1.5 ${result.state === 'ok' ? 'text-green-400' : 'text-red-400'}`}>
        {result.state === 'ok' ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
        {result.message}
      </p>
    );
  };

  const pingButton = (printerId: number | null, key: string) => (
    <button
      onClick={() => handlePingPrinter(printerId)}
      disabled={!bridge?.configured || pingResults[key]?.state === 'running'}
      className="flex items-center gap-2 px-4 py-2 bg-neutral-800 text-white rounded-lg font-medium hover:bg-neutral-700 transition-colors disabled:opacity-40 min-h-[40px]"
    >
      {pingResults[key]?.state === 'running'
        ? <Loader2 size={18} className="animate-spin" />
        : <Activity size={18} />}
      {pingResults[key]?.state === 'running' ? t('printers.ping.running') : t('printers.ping.button')}
    </button>
  );

  return (
    <FeatureGate feature="printers" featureLabel="Printer Management">
    <div className="min-h-screen bg-neutral-950">
      <div className="bg-neutral-900 text-white p-6 border-b border-neutral-800">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link to="/admin" className="p-2 hover:bg-neutral-800 rounded-lg transition-colors">
              <ArrowLeft size={24} />
            </Link>
            <h1 className="text-3xl font-black tracking-tighter">{t('printers.title')}</h1>
          </div>
          <BrandLogo className="h-10" />
        </div>
      </div>

      <div className="max-w-5xl mx-auto p-6 space-y-8">
        {loading ? (
          <div className="space-y-4">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="h-24 bg-neutral-900 rounded-lg border border-neutral-800 animate-pulse" />
            ))}
          </div>
        ) : (
          <>
            {/* Print Bridge Section */}
            <div>
              <h2 className="text-xl font-bold text-white mb-4">{t('printers.bridge.title')}</h2>
              <div className="bg-neutral-900 rounded-lg border border-neutral-800 p-4 space-y-4">
                <div className="flex items-center justify-between flex-wrap gap-3">
                  <div className="flex items-center gap-3">
                    {bridge?.online ? (
                      <Wifi size={24} className="text-green-400" />
                    ) : (
                      <WifiOff size={24} className="text-neutral-500" />
                    )}
                    <div>
                      <p className="font-bold text-white">
                        {!bridge?.configured
                          ? t('printers.bridge.notConfigured')
                          : bridge.online
                            ? t('printers.bridge.online')
                            : t('printers.bridge.offline')}
                      </p>
                      {bridge?.last_seen && (
                        <p className="text-sm text-neutral-400">
                          {t('printers.bridge.lastSeen')}: {new Date(bridge.last_seen).toLocaleString()}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-2 flex-wrap">
                    <button
                      onClick={handleGenerateToken}
                      className="flex items-center gap-2 px-4 py-2 bg-neutral-800 text-white rounded-lg font-medium hover:bg-neutral-700 transition-colors min-h-[40px]"
                    >
                      <KeyRound size={18} /> {t('printers.bridge.generateToken')}
                    </button>
                    {pingButton(null, 'default')}
                    <button
                      onClick={handleTestPrint}
                      disabled={!bridge?.configured}
                      className="flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-lg font-medium hover:bg-brand-700 transition-colors disabled:opacity-40 min-h-[40px]"
                    >
                      <FileCheck size={18} /> {testSent ? t('printers.bridge.testSent') : t('printers.bridge.testPrint')}
                    </button>
                  </div>
                </div>
                {renderPingResult('default')}

                {bridge?.configured && (
                  <div className="flex gap-4 text-sm text-neutral-400 flex-wrap">
                    <span>{t('printers.bridge.queued')}: <span className="text-white font-medium">{bridge.queued}</span></span>
                    <span>{t('printers.bridge.printed24h')}: <span className="text-white font-medium">{bridge.done_24h}</span></span>
                    {bridge.errors_24h > 0 && (
                      <span className="text-red-400">{t('printers.bridge.errors24h')}: {bridge.errors_24h}</span>
                    )}
                  </div>
                )}

                {newToken && (
                  <div className="bg-neutral-800 rounded-lg p-3 space-y-2">
                    <p className="text-sm text-amber-400 font-medium">{t('printers.bridge.tokenOnce')}</p>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 text-sm text-green-300 break-all select-all">{newToken}</code>
                      <button
                        onClick={() => navigator.clipboard?.writeText(newToken)}
                        className="px-3 py-2 bg-neutral-700 text-white rounded-lg text-sm font-medium hover:bg-neutral-600 min-h-[40px]"
                      >
                        {t('common:buttons.copy', 'Copy')}
                      </button>
                    </div>
                    <p className="text-xs text-neutral-500">{t('printers.bridge.tokenHint')}</p>
                  </div>
                )}
              </div>
            </div>

            {/* Printers Section */}
            <div>
              <h2 className="text-xl font-bold text-white mb-4">{t('printers.printers')}</h2>
              <button
                onClick={() => setShowAddPrinter(true)}
                className="flex items-center gap-2 px-4 py-3 bg-brand-600 text-white rounded-lg font-medium hover:bg-brand-700 transition-colors mb-4"
              >
                <Plus size={20} /> {t('printers.addPrinter')}
              </button>

              {showAddPrinter && (
                <div className="bg-neutral-900 p-4 rounded-lg border border-neutral-800 space-y-3 mb-4">
                  <input
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder={t('printers.namePlaceholder')}
                    className="w-full bg-neutral-800 border border-neutral-700 rounded-lg p-3 text-white focus:outline-none focus:border-brand-600"
                  />
                  <div className="flex gap-3">
                    <select
                      value={newType}
                      onChange={(e) => setNewType(e.target.value)}
                      className="bg-neutral-800 border border-neutral-700 rounded-lg p-3 text-white focus:outline-none focus:border-brand-600"
                    >
                      <option value="receipt">{t('printers.types.receipt')}</option>
                      <option value="kitchen">{t('printers.types.kitchen')}</option>
                      <option value="bar">{t('printers.types.bar')}</option>
                    </select>
                    <input
                      value={newAddress}
                      onChange={(e) => setNewAddress(e.target.value)}
                      placeholder={t('printers.ipPlaceholder')}
                      className="flex-1 bg-neutral-800 border border-neutral-700 rounded-lg p-3 text-white focus:outline-none focus:border-brand-600"
                    />
                  </div>
                  <div className="flex gap-2">
                    <button onClick={handleCreatePrinter} className="px-4 py-2 bg-cockpit-green text-white rounded-lg font-medium hover:bg-cockpit-green/90">{t('common:buttons.create')}</button>
                    <button onClick={() => setShowAddPrinter(false)} className="px-4 py-2 bg-neutral-700 text-white rounded-lg font-medium hover:bg-neutral-600">{t('common:buttons.cancel')}</button>
                  </div>
                </div>
              )}

              <div className="space-y-3">
                {printers.map((printer) => (
                  <div key={printer.id} className={`bg-neutral-900 rounded-lg border border-neutral-800 p-4 flex items-center justify-between ${!printer.active ? 'opacity-50' : ''}`}>
                    <div className="flex items-center gap-3">
                      <PrinterIcon size={24} className="text-neutral-400" />
                      <div>
                        <p className="font-bold text-white">{printer.name}</p>
                        <p className="text-sm text-neutral-400">
                          {printer.printer_type} {printer.address && `\u2014 ${printer.address}`}
                        </p>
                        {renderPingResult(String(printer.id))}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {printer.active && pingButton(printer.id, String(printer.id))}
                      <button
                        onClick={() => handleTogglePrinter(printer)}
                        className={`px-3 py-1 rounded-lg text-sm font-medium min-h-[40px] ${printer.active ? 'bg-cockpit-green/30 text-cockpit-in-text' : 'bg-neutral-800 text-neutral-500'}`}
                      >
                        {printer.active ? t('printers.active') : t('printers.inactive')}
                      </button>
                    </div>
                  </div>
                ))}
                {printers.length === 0 && (
                  <p className="text-neutral-500 text-center py-6">{t('printers.noPrinters')}</p>
                )}
              </div>
            </div>

            {/* Category Routing Section */}
            <div>
              <h2 className="text-xl font-bold text-white mb-4">{t('printers.categoryRouting')}</h2>
              <p className="text-neutral-400 text-sm mb-4">
                {t('printers.routingHint')}
              </p>
              <div className="space-y-3">
                {categories.map((cat) => {
                  const route = getRouteForCategory(cat.id);
                  return (
                    <div key={cat.id} className="bg-neutral-900 rounded-lg border border-neutral-800 p-4 flex items-center justify-between">
                      <p className="font-bold text-white">{cat.name}</p>
                      <select
                        value={route?.printer_id || ''}
                        onChange={(e) => handleRouteChange(cat.id, e.target.value ? parseInt(e.target.value) : null)}
                        className="bg-neutral-800 border border-neutral-700 rounded-lg p-2 text-white focus:outline-none focus:border-brand-600"
                      >
                        <option value="">{t('printers.default')}</option>
                        {printers.filter((p) => p.active).map((p) => (
                          <option key={p.id} value={p.id}>{p.name}</option>
                        ))}
                      </select>
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
    </FeatureGate>
  );
}
