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
  AlertOctagon,
  ImagePlus,
} from 'lucide-react';
import {
  getInventory,
  createInventoryItem,
  deleteInventoryItem,
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
  getStaleStock,
  getDormantStock,
  getUnlinkedExpenses,
  getInventoryTouchedToday,
  getInventoryScanActivity,
} from '../api';
import type { UnlinkedExpense, InventoryScanActivity } from '../api';
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
import { useAuth } from '../context/AuthContext';
import StockTab from '../components/inventory/StockTab';
import InventoryPulseGrid, { PulseBucket } from '../components/inventory/InventoryPulseGrid';
import UnlinkedPurchasesBanner from '../components/inventory/UnlinkedPurchasesBanner';
import UnlinkedPurchasesModal from '../components/inventory/UnlinkedPurchasesModal';
import CostReviewBanner from '../components/inventory/CostReviewBanner';
import CostReviewPanel from '../components/inventory/CostReviewPanel';
import { getCostReviewCandidates } from '../api';
import ScanTab from '../components/inventory/ScanTab';
import WasteTab from '../components/inventory/WasteTab';
import CountTab from '../components/inventory/CountTab';
import VarianceTab from '../components/inventory/VarianceTab';
import AlertsTab from '../components/inventory/AlertsTab';
import AIInsightsTab from '../components/inventory/AIInsightsTab';
import StaleStockPanel from '../components/inventory/StaleStockPanel';
import ShelfLifeAuditBanner from '../components/inventory/ShelfLifeAuditBanner';
import InventoryResetModal from '../components/inventory/InventoryResetModal';

type Tab = 'stock' | 'scan' | 'waste' | 'count' | 'variance' | 'alerts' | 'insights';
type SortField = 'name' | 'quantity' | 'status';
type InventoryItemForm = {
  name: string;
  category: string;
  unit: string;
  quantity: string;
  low_stock_threshold: string;
  cost_price: string;
  sku: string;
  barcode: string;
  expiry_date: string;
  lot_number: string;
};

const emptyInventoryForm: InventoryItemForm = {
  name: '',
  category: '',
  unit: '',
  quantity: '0',
  low_stock_threshold: '0',
  cost_price: '0',
  sku: '',
  barcode: '',
  expiry_date: '',
  lot_number: '',
};

export default function InventoryScreen() {
  const { t } = useTranslation('inventory');
  const { limits } = usePlan();
  const { currentEmployee } = useAuth();
  const [activeTab, setActiveTab] = useState<Tab>('stock');
  const [resetModalOpen, setResetModalOpen] = useState(false);

  // Stock tab state
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [filteredItems, setFilteredItems] = useState<InventoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [sortBy, setSortBy] = useState<SortField>('name');
  const [restockingId, setRestockingId] = useState<number | null>(null);
  const [restockAmount, setRestockAmount] = useState<string>('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editThreshold, setEditThreshold] = useState<string>('');
  const [editingQuantityId, setEditingQuantityId] = useState<number | null>(null);
  const [editQuantity, setEditQuantity] = useState<string>('');
  const [itemFormOpen, setItemFormOpen] = useState(false);
  const [itemFormMode, setItemFormMode] = useState<'create' | 'edit'>('create');
  const [itemForm, setItemForm] = useState<InventoryItemForm>(emptyInventoryForm);
  const [editingItemId, setEditingItemId] = useState<number | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [forecasts, setForecasts] = useState<InventoryForecast[]>([]);
  const [showForecasts, setShowForecasts] = useState(false);
  const [staleIds, setStaleIds] = useState<Set<number>>(new Set());
  const [dormantIds, setDormantIds] = useState<Set<number>>(new Set());
  const [touchedTodayIds, setTouchedTodayIds] = useState<Set<number>>(new Set());
  const [pulseLoading, setPulseLoading] = useState(false);
  const [activeBucket, setActiveBucket] = useState<PulseBucket | null>(null);
  const [unlinkedExpenses, setUnlinkedExpenses] = useState<UnlinkedExpense[]>([]);
  const [unlinkedLoading, setUnlinkedLoading] = useState(false);
  const [unlinkedModalOpen, setUnlinkedModalOpen] = useState(false);
  const [costReviewCount, setCostReviewCount] = useState(0);
  const [costReviewOpen, setCostReviewOpen] = useState(false);

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
    loadPulseBuckets();
    loadUnlinked();
    loadCostReviewCount();
  }, []);

  const loadCostReviewCount = async () => {
    try {
      const data = await getCostReviewCandidates();
      setCostReviewCount(data.length);
    } catch {
      // Quiet — banner just won't show.
    }
  };

  const loadUnlinked = async () => {
    try {
      setUnlinkedLoading(true);
      const data = await getUnlinkedExpenses(30);
      setUnlinkedExpenses(data);
    } catch {
      // Quiet failure — banner just won't show
    } finally {
      setUnlinkedLoading(false);
    }
  };

  // A reset touches items, history and (in wipe mode) recipes — reload every
  // panel on this screen rather than trusting local state.
  const handleResetComplete = async () => {
    setError(null);
    await Promise.all([
      fetchItems(),
      loadPulseBuckets(),
      loadUnlinked(),
      loadCostReviewCount(),
    ]);
  };

  const handleUnlinkedLinked = async () => {
    // After a link saves, refresh everything: unlinked list (current expense
    // should disappear), inventory items (quantity bumped), pulse buckets.
    await Promise.all([loadUnlinked(), fetchItems(), loadPulseBuckets()]);
  };

  const loadPulseBuckets = async () => {
    try {
      setPulseLoading(true);
      const [stale, dormant, touched] = await Promise.all([
        getStaleStock(true).catch(() => []),
        getDormantStock(30).catch(() => []),
        getInventoryTouchedToday().catch(() => []),
      ]);
      setStaleIds(new Set(stale.map((s) => s.id)));
      setDormantIds(new Set(dormant.map((d) => d.id)));
      setTouchedTodayIds(new Set(touched));
    } finally {
      setPulseLoading(false);
    }
  };

  // "Added today" = anything touched today (direct restock OR retroactive
  // link of an older expense). Server endpoint is authoritative — see
  // /api/inventory/touched-today.
  const addedTodayIds = touchedTodayIds;

  const pulseCounts = React.useMemo(() => {
    let added_today = 0;
    let low = 0;
    let stale = 0;
    let dormant = 0;
    let healthy = 0;
    for (const it of items) {
      const isOut = it.quantity === 0;
      const isLow = !isOut && it.quantity <= it.low_stock_threshold;
      const isStale = staleIds.has(it.id);
      const isAdded = addedTodayIds.has(it.id);
      const isDormant = dormantIds.has(it.id);
      // Mutually exclusive classification (matches StockTab.classifyItem)
      if (isOut || isLow) {
        low++;
      } else if (isStale) {
        stale++;
      } else if (isAdded) {
        added_today++;
      } else if (isDormant) {
        dormant++;
      } else {
        healthy++;
      }
    }
    return { added_today, low, stale, dormant, healthy, total: items.length };
  }, [items, staleIds, dormantIds, addedTodayIds]);

  const handleBucketToggle = (bucket: PulseBucket) => {
    setActiveBucket((prev) => (prev === bucket ? null : bucket));
  };

  useEffect(() => {
    filterAndSortItems();
  }, [items, searchTerm, sortBy]);

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
      await Promise.all([fetchItems(), loadPulseBuckets()]);
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

  const handleEditQuantity = async (id: number) => {
    if (editQuantity === '') return;
    try {
      setActionLoading(true);
      const qty = parseFloat(editQuantity);
      if (isNaN(qty) || qty < 0) {
        setError(t('inventory.invalidQuantity'));
        return;
      }
      await recordInventoryCount(id, {
        counted_quantity: qty,
        notes: t('inventory.manualAdjustNote'),
      });
      await fetchItems();
      setEditingQuantityId(null);
      setEditQuantity('');
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('inventory.failedUpdateQuantity'));
    } finally {
      setActionLoading(false);
    }
  };

  const openCreateItemForm = () => {
    setItemFormMode('create');
    setEditingItemId(null);
    setItemForm(emptyInventoryForm);
    setItemFormOpen(true);
  };

  const openEditItemForm = (item: InventoryItem) => {
    setItemFormMode('edit');
    setEditingItemId(item.id);
    setItemForm({
      name: item.name || '',
      category: item.category || '',
      unit: item.unit || '',
      quantity: String(item.quantity ?? 0),
      low_stock_threshold: String(item.low_stock_threshold ?? 0),
      cost_price: String(item.cost_price ?? 0),
      sku: item.sku || '',
      barcode: item.barcode || '',
      expiry_date: item.expiry_date ? item.expiry_date.slice(0, 10) : '',
      lot_number: item.lot_number || '',
    });
    setItemFormOpen(true);
  };

  const closeItemForm = () => {
    setItemFormOpen(false);
    setEditingItemId(null);
    setItemForm(emptyInventoryForm);
  };

  const numberFromForm = (value: string, fallback = 0) => {
    if (value.trim() === '') return fallback;
    const n = Number(value);
    return Number.isFinite(n) ? n : NaN;
  };

  const handleSaveItem = async () => {
    const name = itemForm.name.trim();
    const quantity = numberFromForm(itemForm.quantity);
    const threshold = numberFromForm(itemForm.low_stock_threshold);
    const costPrice = numberFromForm(itemForm.cost_price);

    if (!name) {
      setError(t('inventory.itemNameRequired'));
      return;
    }
    if ([quantity, threshold, costPrice].some((value) => Number.isNaN(value) || value < 0)) {
      setError(t('inventory.invalidItemFields'));
      return;
    }

    const payload = {
      name,
      category: itemForm.category.trim(),
      unit: itemForm.unit.trim(),
      quantity,
      low_stock_threshold: threshold,
      cost_price: costPrice,
      sku: itemForm.sku.trim(),
      barcode: itemForm.barcode.trim(),
      expiry_date: itemForm.expiry_date,
      lot_number: itemForm.lot_number.trim(),
    };

    try {
      setActionLoading(true);
      setError(null);
      if (itemFormMode === 'edit' && editingItemId) {
        await updateInventory(editingItemId, payload);
      } else {
        await createInventoryItem(payload);
      }
      closeItemForm();
      await fetchItems();
    } catch (err) {
      setError(err instanceof Error ? err.message : t(itemFormMode === 'edit' ? 'inventory.failedSaveItem' : 'inventory.failedCreateItem'));
    } finally {
      setActionLoading(false);
    }
  };

  const handleDeleteItem = async (item: InventoryItem) => {
    if (!window.confirm(t('inventory.confirmDeleteItem', { name: item.name }))) return;
    try {
      setActionLoading(true);
      setError(null);
      await deleteInventoryItem(item.id);
      await fetchItems();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('inventory.failedDeleteItem'));
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

        <ShelfLifeAuditBanner onAuditComplete={fetchItems} />
        <StaleStockPanel onItemUpdated={fetchItems} />

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
          <>
            <CostReviewBanner count={costReviewCount} onOpen={() => setCostReviewOpen(true)} />
            <CostReviewPanel
              open={costReviewOpen}
              onClose={() => setCostReviewOpen(false)}
              onApplied={async () => {
                await Promise.all([loadCostReviewCount(), fetchItems()]);
              }}
            />
            <UnlinkedPurchasesBanner
              expenses={unlinkedExpenses}
              loading={unlinkedLoading}
              onOpen={() => setUnlinkedModalOpen(true)}
            />
            <UnlinkedPurchasesModal
              expenses={unlinkedExpenses}
              open={unlinkedModalOpen}
              onClose={() => setUnlinkedModalOpen(false)}
              onLinked={handleUnlinkedLinked}
            />
            <InventoryPulseGrid
              counts={pulseCounts}
              loading={loading || pulseLoading}
              activeBucket={activeBucket}
              onBucketToggle={handleBucketToggle}
            />
            <StockTab
              items={items}
              filteredItems={filteredItems}
              loading={loading}
              searchTerm={searchTerm}
              sortBy={sortBy}
              restockingId={restockingId}
              restockAmount={restockAmount}
              editingId={editingId}
              editThreshold={editThreshold}
              editingQuantityId={editingQuantityId}
              editQuantity={editQuantity}
              itemFormOpen={itemFormOpen}
              itemFormMode={itemFormMode}
              itemForm={itemForm}
              actionLoading={actionLoading}
              cogsSummary={cogsSummary}
              forecasts={forecasts}
              showForecasts={showForecasts}
              addedTodayIds={addedTodayIds}
              staleIds={staleIds}
              dormantIds={dormantIds}
              activeBucket={activeBucket}
              onSearchChange={setSearchTerm}
              onSortChange={setSortBy}
              onRestock={handleRestock}
              onEditThreshold={handleEditThreshold}
              onEditQuantity={handleEditQuantity}
              onRestockingIdChange={setRestockingId}
              onRestockAmountChange={setRestockAmount}
              onEditingIdChange={setEditingId}
              onEditThresholdChange={setEditThreshold}
              onEditingQuantityIdChange={setEditingQuantityId}
              onEditQuantityChange={setEditQuantity}
              onItemFormChange={setItemForm}
              onCreateItem={openCreateItemForm}
              onEditItem={openEditItemForm}
              onSaveItem={handleSaveItem}
              onDeleteItem={handleDeleteItem}
              onCloseItemForm={closeItemForm}
              onShowForecastsChange={setShowForecasts}
            />

            {/* Danger zone — clears inventory left over from testing the system */}
            <div className="mt-10 border border-brand-900 bg-brand-950/20 rounded-lg p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-start gap-3">
                <AlertOctagon size={20} className="text-brand-400 shrink-0 mt-0.5" />
                <div>
                  <h3 className="text-white font-semibold text-sm">{t('reset.zoneTitle')}</h3>
                  <p className="text-neutral-400 text-xs mt-1 max-w-xl leading-relaxed">
                    {t('reset.zoneDescription')}
                  </p>
                </div>
              </div>
              <button
                onClick={() => setResetModalOpen(true)}
                className="px-4 py-2 min-h-[40px] bg-brand-700 hover:bg-brand-600 text-white rounded-lg text-sm font-semibold whitespace-nowrap"
              >
                {t('reset.zoneButton')}
              </button>
            </div>

            <InventoryResetModal
              open={resetModalOpen}
              isAdmin={currentEmployee?.role === 'admin'}
              onClose={() => setResetModalOpen(false)}
              onReset={handleResetComplete}
            />
          </>
        )}

        {activeTab === 'scan' && <PhotoScanActivity />}

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

/**
 * Owner-facing window into the photo → inventory flow.
 *
 * The capture screen is phone-only (`/m/scan-photo` renders only when
 * deviceType === 'phone'), so from this desktop screen the feature is
 * otherwise invisible — an owner has no way to learn it exists or whether
 * anyone is using it. This says what it does, where it lives, and shows what
 * it has actually produced.
 */
function PhotoScanActivity() {
  const { t } = useTranslation('inventory');
  const [activity, setActivity] = useState<InventoryScanActivity | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getInventoryScanActivity(5)
      .then((data) => { if (!cancelled) setActivity(data); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, []);

  // A dead panel is worse than no panel — if the feed can't load, the
  // explanation above it is still the useful part, so only that renders.
  const scans = failed ? [] : activity?.scans ?? [];

  return (
    <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6 mb-6">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-lg bg-brand-600/20 flex items-center justify-center shrink-0">
          <ImagePlus size={20} className="text-brand-400" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-white font-bold">{t('photoScan.title')}</h3>
          <p className="text-neutral-400 text-sm mt-1 leading-relaxed">
            {t('photoScan.body')}
          </p>
          <p className="text-neutral-500 text-xs mt-2">{t('photoScan.where')}</p>
        </div>
        {activity && (
          <div className="text-right shrink-0">
            <p className="text-2xl font-bold text-white">{activity.confirmed_30d}</p>
            <p className="text-neutral-500 text-xs">{t('photoScan.last30d')}</p>
          </div>
        )}
      </div>

      {scans.length > 0 && (
        <div className="mt-5 border-t border-neutral-800 pt-4 space-y-2">
          {scans.map((s) => (
            <div key={s.id} className="flex items-center justify-between gap-3 text-sm">
              <span className="text-neutral-300 truncate">
                {s.intent === 'count_inventory'
                  ? t('photoScan.intentCount')
                  : t('photoScan.intentPurchase')}
                {s.employee_name && <span className="text-neutral-500"> · {s.employee_name}</span>}
              </span>
              <span className="flex items-center gap-3 shrink-0">
                <span className={
                  s.status === 'confirmed' ? 'text-green-400'
                    : s.status === 'pending_confirm' ? 'text-amber-400'
                      : 'text-neutral-500'
                }>
                  {t(`photoScan.status.${s.status}`, { defaultValue: s.status })}
                </span>
                <span className="text-neutral-600 text-xs">
                  {new Date(s.created_at).toLocaleDateString()}
                </span>
              </span>
            </div>
          ))}
        </div>
      )}

      {activity && scans.length === 0 && (
        <p className="text-neutral-500 text-sm mt-5 border-t border-neutral-800 pt-4">
          {t('photoScan.empty')}
        </p>
      )}
    </div>
  );
}
