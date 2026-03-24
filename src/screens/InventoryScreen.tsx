import React, { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  Check,
  X,
  Sparkles,
  ClipboardList,
  BarChart3,
  AlertTriangle,
  ScanLine,
  Trash2,
} from 'lucide-react';
import {
  getInventory,
  restockItem,
  updateInventory,
  getInventoryForecast,
  recordInventoryCount,
  getInventoryCounts,
  getVarianceReport,
  getShrinkageAlerts,
  acknowledgeShrinkageAlert,
  lookupInventoryItem,
  scanRestock,
  logWaste,
  getWasteLog,
  getWasteReport,
  getCOGSSummary,
  getInventoryInsights,
} from '../api';
import {
  InventoryItem,
  InventoryForecast,
  InventoryCount,
  ShrinkageAlert,
  VarianceReport,
  WasteLogEntry,
  WasteReport,
  COGSSummary,
  ScanSession,
  InventoryInsights,
} from '../types';
import BrandLogo from '../components/BrandLogo';
import { usePlan } from '../context/PlanContext';
import StockTab from '../components/inventory/StockTab';
import ScanTab from '../components/inventory/ScanTab';
import WasteTab from '../components/inventory/WasteTab';
import CountTab from '../components/inventory/CountTab';
import VarianceTab from '../components/inventory/VarianceTab';
import AlertsTab from '../components/inventory/AlertsTab';
import AIInsightsTab from '../components/inventory/AIInsightsTab';

type Tab = 'stock' | 'scan' | 'waste' | 'count' | 'variance' | 'alerts' | 'insights';
type SortField = 'name' | 'quantity' | 'status';

export default function InventoryScreen() {
  const { t } = useTranslation('inventory');
  const { limits } = usePlan();
  const [activeTab, setActiveTab] = useState<Tab>('stock');

  // Stock tab state
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [filteredItems, setFilteredItems] = useState<InventoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [sortBy, setSortBy] = useState<SortField>('name');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [restockingId, setRestockingId] = useState<number | null>(null);
  const [restockAmount, setRestockAmount] = useState<string>('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editThreshold, setEditThreshold] = useState<string>('');
  const [actionLoading, setActionLoading] = useState(false);
  const [forecasts, setForecasts] = useState<InventoryForecast[]>([]);
  const [showForecasts, setShowForecasts] = useState(false);

  // COGS widget state
  const [cogsSummary, setCogsSummary] = useState<COGSSummary | null>(null);
  const [cogsLoading, setCogsLoading] = useState(false);

  // Scan tab state
  const [scanInput, setScanInput] = useState('');
  const [scanLoading, setScanLoading] = useState(false);
  const [scannedItem, setScannedItem] = useState<InventoryItem | null>(null);
  const [scanRestockQty, setScanRestockQty] = useState('');
  const [scanCostPrice, setScanCostPrice] = useState('');
  const [scanSession, setScanSession] = useState<ScanSession[]>([]);
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraSupported, setCameraSupported] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const scanInputRef = useRef<HTMLInputElement>(null);

  // Waste tab state
  const [wasteItemId, setWasteItemId] = useState('');
  const [wasteQty, setWasteQty] = useState('');
  const [wasteReason, setWasteReason] = useState<string>('spoilage');
  const [wasteNotes, setWasteNotes] = useState('');
  const [wasteLoading, setWasteLoading] = useState(false);
  const [wasteEntries, setWasteEntries] = useState<WasteLogEntry[]>([]);
  const [wasteReport, setWasteReport] = useState<WasteReport | null>(null);
  const [wasteReportLoading, setWasteReportLoading] = useState(false);
  const [wasteAlerts, setWasteAlerts] = useState<any[]>([]);

  // Count tab state
  const [countItemId, setCountItemId] = useState<string>('');
  const [countedQty, setCountedQty] = useState<string>('');
  const [countNotes, setCountNotes] = useState('');
  const [countHistory, setCountHistory] = useState<InventoryCount[]>([]);
  const [countLoading, setCountLoading] = useState(false);

  // Variance tab state
  const [varianceData, setVarianceData] = useState<VarianceReport[]>([]);
  const [varianceLoading, setVarianceLoading] = useState(false);

  // Alerts tab state
  const [alerts, setAlerts] = useState<ShrinkageAlert[]>([]);
  const [alertsLoading, setAlertsLoading] = useState(false);

  // Insights tab state
  const [insights, setInsights] = useState<InventoryInsights | null>(null);
  const [insightsLoading, setInsightsLoading] = useState(false);
  const [expandedRisk, setExpandedRisk] = useState<Record<string, boolean>>({ critical: true, high: true, medium: false, low: false });

  useEffect(() => {
    fetchItems();
    getInventoryForecast()
      .then(setForecasts)
      .catch(() => {});
  }, []);

  useEffect(() => {
    filterAndSortItems();
  }, [items, searchTerm, sortBy, selectedCategory]);

  useEffect(() => {
    if (activeTab === 'stock') {
      loadCOGS();
    } else if (activeTab === 'count') {
      loadCountHistory();
    } else if (activeTab === 'variance') {
      loadVarianceReport();
    } else if (activeTab === 'alerts') {
      loadAlerts();
    } else if (activeTab === 'waste') {
      loadWasteData();
    } else if (activeTab === 'scan') {
      checkCameraSupport();
      scanInputRef.current?.focus();
    } else if (activeTab === 'insights') {
      loadInsights();
    }
  }, [activeTab]);

  // Cleanup camera on unmount or tab change
  useEffect(() => {
    return () => { stopCamera(); };
  }, [activeTab]);

  // ==================== Data Fetching ====================

  const fetchItems = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await getInventory();
      setItems(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors:fetchInventory'));
    } finally {
      setLoading(false);
    }
  };

  const filterAndSortItems = () => {
    let filtered = items;

    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      filtered = filtered.filter((item) =>
        item.name.toLowerCase().includes(term) ||
        item.sku?.toLowerCase().includes(term) ||
        item.barcode?.toLowerCase().includes(term)
      );
    }

    if (selectedCategory !== 'all') {
      filtered = filtered.filter((item) => item.category === selectedCategory);
    }

    filtered.sort((a, b) => {
      if (sortBy === 'name') {
        return a.name.localeCompare(b.name);
      } else if (sortBy === 'quantity') {
        return a.quantity - b.quantity;
      } else if (sortBy === 'status') {
        const aLow = a.quantity <= a.low_stock_threshold ? 0 : 1;
        const bLow = b.quantity <= b.low_stock_threshold ? 0 : 1;
        return bLow - aLow;
      }
      return 0;
    });

    setFilteredItems(filtered);
  };

  // ==================== Stock Tab Handlers ====================

  const handleRestock = async () => {
    if (!restockingId || !restockAmount) return;
    try {
      setActionLoading(true);
      const amount = parseFloat(restockAmount);
      if (isNaN(amount) || amount <= 0) {
        setError(t('inventory.invalidRestockAmount'));
        return;
      }
      await restockItem(restockingId, amount);
      await fetchItems();
      setRestockingId(null);
      setRestockAmount('');
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('inventory.failedRestock'));
    } finally {
      setActionLoading(false);
    }
  };

  const handleEditThreshold = async (id: number) => {
    if (!editThreshold) return;
    try {
      setActionLoading(true);
      const threshold = parseFloat(editThreshold);
      if (isNaN(threshold) || threshold < 0) {
        setError(t('inventory.invalidThreshold'));
        return;
      }
      await updateInventory(id, { low_stock_threshold: threshold });
      await fetchItems();
      setEditingId(null);
      setEditThreshold('');
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('inventory.failedUpdateThreshold'));
    } finally {
      setActionLoading(false);
    }
  };

  const loadCOGS = async () => {
    try {
      setCogsLoading(true);
      const data = await getCOGSSummary('30d');
      setCogsSummary(data);
    } catch {
      // Silently fail — widget is informational
    } finally {
      setCogsLoading(false);
    }
  };

  // ==================== Scan Tab Handlers ====================

  const checkCameraSupport = () => {
    setCameraSupported('BarcodeDetector' in window);
  };

  const handleScanLookup = async (value?: string) => {
    const input = value || scanInput.trim();
    if (!input) return;
    try {
      setScanLoading(true);
      setError(null);
      const item = await lookupInventoryItem(input);
      setScannedItem(item);
      setScanRestockQty('1');
      setScanCostPrice(item.cost_price ? String(item.cost_price) : '');
      setScanInput('');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('scan.notFound'));
      setScannedItem(null);
    } finally {
      setScanLoading(false);
    }
  };

  const handleScanRestock = async () => {
    if (!scannedItem || !scanRestockQty) return;
    const qty = parseFloat(scanRestockQty);
    if (isNaN(qty) || qty <= 0) return;
    try {
      setActionLoading(true);
      setError(null);
      const barcode = scannedItem.barcode || scannedItem.sku || '';
      const cost = scanCostPrice ? parseFloat(scanCostPrice) : undefined;
      await scanRestock({ barcode, quantity: qty, cost_price: cost });
      setScanSession(prev => [{
        item: scannedItem,
        quantity: qty,
        scanned_at: new Date().toISOString(),
      }, ...prev]);
      setError(null);
      setScannedItem(null);
      setScanRestockQty('');
      setScanCostPrice('');
      fetchItems();
      scanInputRef.current?.focus();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('scan.failedRestock'));
    } finally {
      setActionLoading(false);
    }
  };

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        setCameraActive(true);
        detectBarcode();
      }
    } catch {
      setError(t('scan.cameraNotSupported'));
    }
  };

  const stopCamera = () => {
    if (videoRef.current?.srcObject) {
      const stream = videoRef.current.srcObject as MediaStream;
      stream.getTracks().forEach(track => track.stop());
      videoRef.current.srcObject = null;
    }
    setCameraActive(false);
  };

  const detectBarcode = async () => {
    if (!('BarcodeDetector' in window) || !videoRef.current) return;
    const BarcodeDetectorAPI = (window as any).BarcodeDetector;
    const detector = new BarcodeDetectorAPI({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39'] });
    const scan = async () => {
      if (!videoRef.current || !cameraActive) return;
      try {
        const barcodes = await detector.detect(videoRef.current);
        if (barcodes.length > 0) {
          const code = barcodes[0].rawValue;
          stopCamera();
          setScanInput(code);
          handleScanLookup(code);
          return;
        }
      } catch { /* ignore detection errors */ }
      if (cameraActive) requestAnimationFrame(scan);
    };
    requestAnimationFrame(scan);
  };

  // ==================== Waste Tab Handlers ====================

  const loadWasteData = async () => {
    try {
      setWasteReportLoading(true);
      const [entries, report] = await Promise.all([
        getWasteLog(),
        getWasteReport(),
      ]);
      setWasteEntries(entries);
      setWasteReport(report);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('waste.failedLoadReport'));
    } finally {
      setWasteReportLoading(false);
    }
  };

  const handleLogWaste = async () => {
    if (!wasteItemId || !wasteQty || !wasteReason) return;
    const qty = parseFloat(wasteQty);
    if (isNaN(qty) || qty <= 0) return;
    try {
      setWasteLoading(true);
      setError(null);
      await logWaste({
        inventory_item_id: parseInt(wasteItemId),
        quantity: qty,
        reason: wasteReason,
        notes: wasteNotes || undefined,
      });
      setWasteItemId('');
      setWasteQty('');
      setWasteReason('spoilage');
      setWasteNotes('');
      await Promise.all([loadWasteData(), fetchItems()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('waste.failedLog'));
    } finally {
      setWasteLoading(false);
    }
  };

  // ==================== Count Tab Handlers ====================

  const loadCountHistory = async () => {
    try {
      setCountLoading(true);
      const data = await getInventoryCounts();
      setCountHistory(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('inventory.failedLoadCounts'));
    } finally {
      setCountLoading(false);
    }
  };

  const handleRecordCount = async () => {
    if (!countItemId || !countedQty) return;
    try {
      setActionLoading(true);
      setError(null);
      await recordInventoryCount(parseInt(countItemId), { counted_quantity: parseFloat(countedQty), notes: countNotes || undefined });
      setCountItemId('');
      setCountedQty('');
      setCountNotes('');
      await loadCountHistory();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors:recordCount'));
    } finally {
      setActionLoading(false);
    }
  };

  // ==================== Variance / Alerts / Insights Handlers ====================

  const loadVarianceReport = async () => {
    try {
      setVarianceLoading(true);
      const data = await getVarianceReport();
      setVarianceData(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors:loadVariance'));
    } finally {
      setVarianceLoading(false);
    }
  };

  const loadAlerts = async () => {
    try {
      setAlertsLoading(true);
      const data = await getShrinkageAlerts();
      setAlerts(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors:loadAlerts'));
    } finally {
      setAlertsLoading(false);
    }
  };

  const handleAcknowledge = async (alertId: number) => {
    try {
      setActionLoading(true);
      await acknowledgeShrinkageAlert(alertId);
      await loadAlerts();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors:acknowledgeAlert'));
    } finally {
      setActionLoading(false);
    }
  };

  const loadInsights = async () => {
    try {
      setInsightsLoading(true);
      const data = await getInventoryInsights();
      setInsights(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('insights.failedLoad'));
    } finally {
      setInsightsLoading(false);
    }
  };

  // ==================== Derived Data ====================

  const categories = ['all', ...Array.from(new Set(items.map((item) => item.category)))];

  const tabs: { key: Tab; label: string; icon: React.ReactNode }[] = [
    { key: 'stock', label: t('inventory.tabs.stock'), icon: <ClipboardList size={18} /> },
    { key: 'scan', label: t('inventory.tabs.scan'), icon: <ScanLine size={18} /> },
    { key: 'waste', label: t('inventory.tabs.waste'), icon: <Trash2 size={18} /> },
    { key: 'count', label: t('inventory.tabs.count'), icon: <Check size={18} /> },
    { key: 'variance', label: t('inventory.tabs.variance'), icon: <BarChart3 size={18} /> },
    { key: 'alerts', label: t('inventory.tabs.alerts'), icon: <AlertTriangle size={18} /> },
    { key: 'insights', label: t('inventory.tabs.insights'), icon: <Sparkles size={18} /> },
  ];

  // ==================== Render ====================

  return (
    <div className="min-h-screen bg-neutral-950">
      <div className="bg-neutral-900 text-white p-6 border-b border-neutral-800">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link
              to="/admin"
              className="p-2 hover:bg-neutral-800 rounded-lg transition-colors"
            >
              <ArrowLeft size={24} />
            </Link>
            <h1 className="text-3xl font-black tracking-tighter">{t('inventory.title')}</h1>
            {limits.inventoryItems !== Infinity && (
              <span className="text-sm text-neutral-400 ml-3">
                {items.length} / {limits.inventoryItems} {t('itemsCount')}
              </span>
            )}
          </div>
          <BrandLogo className="h-10" />
        </div>
      </div>

      <div className="max-w-7xl mx-auto p-6">
        {error && (
          <div className="bg-brand-900/30 border border-brand-800 rounded-lg p-4 mb-6 flex justify-between items-center">
            <p className="text-brand-300">{error}</p>
            <button
              onClick={() => setError(null)}
              className="text-brand-400 hover:text-brand-300"
            >
              <X size={20} />
            </button>
          </div>
        )}

        {/* Tabs */}
        <div className="flex gap-2 mb-6 border-b border-neutral-800 pb-4 overflow-x-auto">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors whitespace-nowrap ${
                activeTab === tab.key
                  ? 'bg-brand-600 text-white'
                  : 'bg-neutral-800 text-neutral-400 hover:text-white hover:bg-neutral-700'
              }`}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </div>

        {activeTab === 'stock' && (
          <StockTab
            items={items}
            filteredItems={filteredItems}
            loading={loading}
            searchTerm={searchTerm}
            selectedCategory={selectedCategory}
            sortBy={sortBy}
            restockingId={restockingId}
            restockAmount={restockAmount}
            editingId={editingId}
            editThreshold={editThreshold}
            actionLoading={actionLoading}
            cogsSummary={cogsSummary}
            forecasts={forecasts}
            showForecasts={showForecasts}
            categories={categories}
            onSearchChange={setSearchTerm}
            onCategoryChange={setSelectedCategory}
            onSortChange={setSortBy}
            onRestock={handleRestock}
            onEditThreshold={handleEditThreshold}
            onRestockingIdChange={setRestockingId}
            onRestockAmountChange={setRestockAmount}
            onEditingIdChange={setEditingId}
            onEditThresholdChange={setEditThreshold}
            onShowForecastsChange={setShowForecasts}
          />
        )}

        {activeTab === 'scan' && (
          <ScanTab
            scanInput={scanInput}
            scanLoading={scanLoading}
            scannedItem={scannedItem}
            scanRestockQty={scanRestockQty}
            scanCostPrice={scanCostPrice}
            scanSession={scanSession}
            cameraActive={cameraActive}
            cameraSupported={cameraSupported}
            actionLoading={actionLoading}
            videoRef={videoRef}
            scanInputRef={scanInputRef}
            onScanInputChange={setScanInput}
            onScanLookup={() => handleScanLookup()}
            onScanRestock={handleScanRestock}
            onCameraToggle={cameraActive ? stopCamera : startCamera}
            onScannedItemClear={() => { setScannedItem(null); scanInputRef.current?.focus(); }}
            onScanRestockQtyChange={setScanRestockQty}
            onScanCostPriceChange={setScanCostPrice}
            onClearSession={() => setScanSession([])}
          />
        )}

        {activeTab === 'waste' && (
          <WasteTab
            items={items}
            wasteItemId={wasteItemId}
            wasteQty={wasteQty}
            wasteReason={wasteReason}
            wasteNotes={wasteNotes}
            wasteLoading={wasteLoading}
            wasteEntries={wasteEntries}
            wasteReport={wasteReport}
            wasteReportLoading={wasteReportLoading}
            onWasteItemIdChange={setWasteItemId}
            onWasteQtyChange={setWasteQty}
            onWasteReasonChange={setWasteReason}
            onWasteNotesChange={setWasteNotes}
            onLogWaste={handleLogWaste}
          />
        )}

        {activeTab === 'count' && (
          <CountTab
            items={items}
            countItemId={countItemId}
            countedQty={countedQty}
            countNotes={countNotes}
            countHistory={countHistory}
            countLoading={countLoading}
            actionLoading={actionLoading}
            onCountItemIdChange={setCountItemId}
            onCountedQtyChange={setCountedQty}
            onCountNotesChange={setCountNotes}
            onRecordCount={handleRecordCount}
          />
        )}

        {activeTab === 'variance' && (
          <VarianceTab
            varianceData={varianceData}
            varianceLoading={varianceLoading}
            onRefresh={loadVarianceReport}
          />
        )}

        {activeTab === 'alerts' && (
          <AlertsTab
            alerts={alerts}
            alertsLoading={alertsLoading}
            actionLoading={actionLoading}
            onAcknowledge={handleAcknowledge}
            onRefresh={loadAlerts}
          />
        )}

        {activeTab === 'insights' && (
          <AIInsightsTab
            limits={limits}
            insights={insights}
            insightsLoading={insightsLoading}
            expandedRisk={expandedRisk}
            onExpandedRiskChange={setExpandedRisk}
          />
        )}
      </div>
    </div>
  );
}
