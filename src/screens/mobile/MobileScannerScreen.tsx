import React, { useState, useRef, useCallback, useEffect, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import {
  lookupInventoryItem,
  scanRestock,
  scanReceipt,
  createExpense,
  type ReceiptScanResult,
  type Expense,
  type InventoryMatch,
} from '../../api';
import { InventoryItem } from '../../types';
import { successFeedback, errorFeedback, tapFeedback } from '../../lib/haptics';
import MobileHeader from '../../components/mobile/MobileHeader';
import { Camera, CameraOff, Search, Check, Package, Loader2, Receipt, X, CircleCheck } from 'lucide-react';

const InventoryMatchStep = React.lazy(() => import('../../components/expenses/InventoryMatchStep'));

interface SessionEntry {
  item: InventoryItem;
  quantity: number;
  newQuantity: number;
}

type ReceiptStep = 'idle' | 'scanning' | 'results' | 'inventory-match' | 'saving' | 'done';

const MobileScannerScreen: React.FC = () => {
  const { t } = useTranslation('pos');
  const [cameraActive, setCameraActive] = useState(false);
  const [manualInput, setManualInput] = useState('');
  const [foundItem, setFoundItem] = useState<InventoryItem | null>(null);
  const [restockQty, setRestockQty] = useState('1');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<SessionEntry[]>([]);
  const [showSession, setShowSession] = useState(false);

  // Receipt capture state
  const [receiptStep, setReceiptStep] = useState<ReceiptStep>('idle');
  const [receiptResult, setReceiptResult] = useState<ReceiptScanResult | null>(null);
  const [receiptMatches, setReceiptMatches] = useState<InventoryMatch[] | undefined>(undefined);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cameraActiveRef = useRef(false);
  const scanningRef = useRef(false);

  const stopCamera = useCallback(() => {
    cameraActiveRef.current = false;
    scanningRef.current = false;
    if (videoRef.current?.srcObject) {
      const stream = videoRef.current.srcObject as MediaStream;
      stream.getTracks().forEach((track) => track.stop());
      videoRef.current.srcObject = null;
    }
    setCameraActive(false);
  }, []);

  const handleLookup = useCallback(async (barcode: string) => {
    if (!barcode.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const item = await lookupInventoryItem(barcode.trim());
      setFoundItem(item);
      setRestockQty('1');
      tapFeedback();
    } catch {
      setError(t('mobileScanner.noItemFound', { barcode }));
      setFoundItem(null);
      errorFeedback();
    } finally {
      setLoading(false);
    }
  }, [t]);

  const startCamera = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        setCameraActive(true);
        cameraActiveRef.current = true;
        scanningRef.current = true;

        // Start barcode detection
        if ('BarcodeDetector' in window) {
          const BarcodeDetectorAPI = (window as any).BarcodeDetector;
          const detector = new BarcodeDetectorAPI({
            formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39'],
          });

          const scan = async () => {
            if (!cameraActiveRef.current || !scanningRef.current || !videoRef.current) return;
            try {
              const barcodes = await detector.detect(videoRef.current);
              if (barcodes.length > 0) {
                const code = barcodes[0].rawValue;
                scanningRef.current = false;
                stopCamera();
                handleLookup(code);
                setManualInput(code);
                return;
              }
            } catch { /* ignore detection errors */ }
            if (cameraActiveRef.current && scanningRef.current) {
              requestAnimationFrame(scan);
            }
          };
          requestAnimationFrame(scan);
        }
      }
    } catch {
      setError(t('mobileScanner.cameraAccessDenied'));
    }
  }, [stopCamera, handleLookup, t]);

  // Capture photo from video stream for receipt scanning
  const captureReceipt = useCallback(async () => {
    if (!videoRef.current || !canvasRef.current) return;

    const video = videoRef.current;
    const canvas = canvasRef.current;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.drawImage(video, 0, 0);
    tapFeedback();

    // Stop camera and barcode scanning
    scanningRef.current = false;
    stopCamera();

    // Convert canvas to File
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.85)
    );
    if (!blob) {
      setError(t('mobileScanner.failedCapture'));
      return;
    }

    const file = new File([blob], `receipt-${Date.now()}.jpg`, { type: 'image/jpeg' });

    // Send to AI scan
    setReceiptStep('scanning');
    setError(null);
    try {
      const result = await scanReceipt(file);
      setReceiptResult(result);
      setReceiptStep('results');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('mobileScanner.failedScan'));
      setReceiptStep('idle');
    }
  }, [stopCamera, t]);

  // Save receipt as expense
  const saveReceiptExpense = useCallback(async () => {
    if (!receiptResult) return;
    const parsed = receiptResult.parsed;

    try {
      const receiptData: Record<string, unknown> = { ...(parsed as Record<string, unknown>) };
      if (receiptMatches && receiptMatches.length > 0) {
        receiptData.inventory_matches = receiptMatches;
      }

      await createExpense({
        vendor: parsed?.vendor || undefined,
        description: parsed?.items?.map((i) => i.description).join(', ') || undefined,
        amount: parsed?.total || parsed?.subtotal || 0,
        tax_amount: parsed?.tax || 0,
        expense_date: parsed?.date || new Date().toISOString().slice(0, 10),
        payment_method: parsed?.payment_method || undefined,
        category: parsed?.category || 'food_cost',
        receipt_image_url: receiptResult.image_url,
        receipt_data: receiptData,
        inventory_matches: receiptMatches,
      } as Partial<Expense> & { inventory_matches?: InventoryMatch[] });

      setReceiptStep('done');
      successFeedback();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('mobileScanner.restockFailed'));
      setReceiptStep('results');
      errorFeedback();
    }
  }, [receiptResult, receiptMatches, t]);

  const resetReceiptFlow = useCallback(() => {
    setReceiptStep('idle');
    setReceiptResult(null);
    setReceiptMatches(undefined);
    setError(null);
  }, []);

  // Auto-save when receiptStep transitions to 'saving'
  useEffect(() => {
    if (receiptStep === 'saving') {
      saveReceiptExpense();
    }
  }, [receiptStep, saveReceiptExpense]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cameraActiveRef.current = false;
      scanningRef.current = false;
      if (videoRef.current?.srcObject) {
        const stream = videoRef.current.srcObject as MediaStream;
        stream.getTracks().forEach((track) => track.stop());
      }
    };
  }, []);

  const handleRestock = async () => {
    if (!foundItem) return;
    const qty = parseInt(restockQty);
    if (isNaN(qty) || qty <= 0) return;

    setLoading(true);
    try {
      const result = await scanRestock({ barcode: foundItem.barcode || foundItem.sku || '', quantity: qty });
      setSession((prev) => [
        { item: foundItem, quantity: qty, newQuantity: result.new_quantity },
        ...prev,
      ]);
      setFoundItem(null);
      setManualInput('');
      setRestockQty('1');
      successFeedback();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('mobileScanner.restockFailed'));
      errorFeedback();
    } finally {
      setLoading(false);
    }
  };

  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (manualInput.trim()) handleLookup(manualInput.trim());
  };

  // Receipt flow is active (not idle and not done)
  const receiptActive = receiptStep !== 'idle' && receiptStep !== 'done';

  return (
    <>
      <MobileHeader
        title={t('mobileScanner.title')}
        rightAction={
          session.length > 0 ? (
            <button
              onClick={() => setShowSession(!showSession)}
              className="relative p-2 text-neutral-400 hover:text-white touch-manipulation"
            >
              <Package className="w-5 h-5" />
              <span className="absolute -top-1 -right-1 bg-brand-600 text-white text-xs w-4 h-4 rounded-full flex items-center justify-center font-bold">
                {session.length}
              </span>
            </button>
          ) : undefined
        }
      />

      {/* Hidden canvas for photo capture */}
      <canvas ref={canvasRef} className="hidden" />

      <div className="flex flex-col">
        {/* Camera viewfinder */}
        <div className="relative bg-black" style={{ height: '55vh' }}>
          <video
            ref={videoRef}
            className="w-full h-full object-cover"
            playsInline
            muted
          />

          {!cameraActive && receiptStep === 'idle' && (
            <div className="absolute inset-0 flex items-center justify-center bg-neutral-900">
              <button
                onClick={startCamera}
                className="flex flex-col items-center gap-3 p-8 touch-manipulation"
              >
                <Camera className="w-16 h-16 text-neutral-500" />
                <span className="text-neutral-400 font-semibold">{t('mobileScanner.tapToScan')}</span>
              </button>
            </div>
          )}

          {/* Receipt scanning overlay */}
          {!cameraActive && receiptStep === 'scanning' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-neutral-900 gap-3">
              <Loader2 className="w-12 h-12 text-brand-400 animate-spin" />
              <span className="text-brand-400 font-semibold">{t('mobileScanner.analyzingReceipt')}</span>
            </div>
          )}

          {/* Receipt done overlay */}
          {!cameraActive && receiptStep === 'done' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-neutral-900 gap-4">
              <CircleCheck className="w-16 h-16 text-green-400" />
              <span className="text-green-400 font-bold text-lg">{t('mobileScanner.expenseSaved')}</span>
              {receiptMatches && receiptMatches.length > 0 && (
                <span className="text-neutral-400 text-sm">{t('mobileScanner.inventoryUpdated', { count: receiptMatches.length })}</span>
              )}
              <button
                onClick={() => { resetReceiptFlow(); startCamera(); }}
                className="mt-2 px-6 py-3 bg-brand-600 text-white font-bold rounded-xl touch-manipulation"
              >
                {t('mobileScanner.scanAnother')}
              </button>
            </div>
          )}

          {cameraActive && (
            <>
              {/* Scan frame overlay */}
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="w-64 h-40 border-2 border-brand-500 rounded-xl">
                  <div className="absolute top-0 left-0 w-6 h-6 border-t-4 border-l-4 border-brand-400 rounded-tl-lg" />
                  <div className="absolute top-0 right-0 w-6 h-6 border-t-4 border-r-4 border-brand-400 rounded-tr-lg" />
                  <div className="absolute bottom-0 left-0 w-6 h-6 border-b-4 border-l-4 border-brand-400 rounded-bl-lg" />
                  <div className="absolute bottom-0 right-0 w-6 h-6 border-b-4 border-r-4 border-brand-400 rounded-br-lg" />
                </div>
              </div>

              {/* Top-right: stop camera */}
              <button
                onClick={stopCamera}
                className="absolute top-4 right-4 bg-black/50 p-2 rounded-full text-white touch-manipulation"
              >
                <CameraOff className="w-5 h-5" />
              </button>

              {/* Bottom center: capture receipt photo button */}
              <div className="absolute bottom-6 left-0 right-0 flex justify-center">
                <button
                  onClick={captureReceipt}
                  className="w-16 h-16 rounded-full bg-white border-4 border-brand-500 flex items-center justify-center shadow-lg active:scale-95 transition-transform touch-manipulation"
                >
                  <Receipt className="w-7 h-7 text-neutral-800" />
                </button>
              </div>
            </>
          )}
        </div>

        <div className="p-4 space-y-4">
          {/* Receipt results */}
          {receiptStep === 'results' && receiptResult && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-base font-bold text-white">{t('mobileScanner.receiptScanned')}</h3>
                <button onClick={resetReceiptFlow} className="p-1 text-neutral-400 hover:text-white touch-manipulation">
                  <X className="w-5 h-5" />
                </button>
              </div>

              {receiptResult.parsed ? (
                <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-3 space-y-2 text-sm">
                  {receiptResult.parsed.vendor && (
                    <div className="flex justify-between">
                      <span className="text-neutral-400">{t('mobileScanner.vendor')}</span>
                      <span className="text-white font-medium">{receiptResult.parsed.vendor}</span>
                    </div>
                  )}
                  {receiptResult.parsed.date && (
                    <div className="flex justify-between">
                      <span className="text-neutral-400">{t('mobileScanner.date')}</span>
                      <span className="text-white font-medium">{receiptResult.parsed.date}</span>
                    </div>
                  )}
                  {receiptResult.parsed.items && receiptResult.parsed.items.length > 0 && (
                    <div>
                      <span className="text-neutral-400">{t('mobileScanner.items')}</span>
                      <div className="mt-1 space-y-1">
                        {receiptResult.parsed.items.map((item, i) => (
                          <div key={i} className="flex justify-between text-white">
                            <span className="truncate mr-2">{item.description}</span>
                            <span className="shrink-0">${Number(item.amount).toFixed(2)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="border-t border-neutral-700 pt-2 flex justify-between font-bold">
                    <span className="text-neutral-400">{t('mobileScanner.total')}</span>
                    <span className="text-white">${Number(receiptResult.parsed.total || 0).toFixed(2)}</span>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-neutral-400">{receiptResult.message}</p>
              )}

              <div className="flex gap-3">
                <button
                  onClick={resetReceiptFlow}
                  className="flex-1 py-3 bg-neutral-800 text-white font-semibold rounded-xl hover:bg-neutral-700 transition-colors touch-manipulation"
                >
                  {t('common:buttons.cancel')}
                </button>
                {receiptResult.parsed?.items && receiptResult.parsed.items.length > 0 ? (
                  <button
                    onClick={() => setReceiptStep('inventory-match')}
                    className="flex-1 py-3 bg-brand-600 text-white font-semibold rounded-xl hover:bg-brand-700 transition-colors touch-manipulation"
                  >
                    {t('mobileScanner.matchAndSave')}
                  </button>
                ) : (
                  <button
                    onClick={() => setReceiptStep('saving')}
                    className="flex-1 py-3 bg-brand-600 text-white font-semibold rounded-xl hover:bg-brand-700 transition-colors touch-manipulation"
                  >
                    {t('mobileScanner.saveExpense')}
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Inventory matching step */}
          {receiptStep === 'inventory-match' && receiptResult?.parsed?.items && (
            <Suspense fallback={
              <div className="flex items-center justify-center py-8 text-neutral-400">
                <Loader2 className="w-5 h-5 animate-spin mr-2" />
                {t('mobileScanner.loadingInventory')}
              </div>
            }>
              <InventoryMatchStep
                items={receiptResult.parsed.items}
                onContinue={(matches) => {
                  setReceiptMatches(matches.length > 0 ? matches : undefined);
                  // Save immediately after matching
                  setReceiptStep('saving');
                  // Need to trigger save after state update
                }}
                onSkipAll={() => {
                  setReceiptMatches(undefined);
                  setReceiptStep('saving');
                }}
              />
            </Suspense>
          )}

          {/* Saving spinner */}
          {receiptStep === 'saving' && (
            <div className="flex items-center justify-center py-8 text-brand-400">
              <Loader2 className="w-6 h-6 animate-spin mr-2" />
              <span className="font-semibold">{t('mobileScanner.savingExpense')}</span>
            </div>
          )}

          {/* Regular barcode flow — hide when receipt flow is active */}
          {!receiptActive && (
            <>
              {/* Manual input */}
              <form onSubmit={handleManualSubmit} className="flex gap-2">
                <input
                  type="text"
                  value={manualInput}
                  onChange={(e) => setManualInput(e.target.value)}
                  placeholder={t('mobileScanner.barcodePlaceholder')}
                  className="flex-1 px-4 py-3 bg-neutral-900 border border-neutral-700 rounded-xl text-white placeholder-neutral-500 focus:outline-none focus:border-brand-600"
                />
                <button
                  type="submit"
                  disabled={!manualInput.trim() || loading}
                  className="px-4 py-3 bg-brand-600 text-white rounded-xl font-bold disabled:opacity-50 touch-manipulation"
                >
                  <Search className="w-5 h-5" />
                </button>
              </form>

              {/* Found item detail card */}
              {foundItem && (
                <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-4 space-y-3">
                  <div>
                    <p className="text-lg font-bold text-white">{foundItem.name}</p>
                    <div className="flex items-center gap-3 mt-1">
                      <span className="text-sm text-neutral-400">
                        {t('mobileScanner.currentStock')} <span className="font-bold text-white">{foundItem.quantity} {foundItem.unit}</span>
                      </span>
                      {foundItem.low_stock_threshold && foundItem.quantity <= foundItem.low_stock_threshold && (
                        <span className="text-xs bg-amber-600 text-white px-2 py-0.5 rounded-full font-bold">{t('lowStock')}</span>
                      )}
                    </div>
                    {foundItem.barcode && (
                      <p className="text-xs text-neutral-500 mt-1">{t('mobileScanner.barcode')} {foundItem.barcode}</p>
                    )}
                  </div>

                  <div className="flex items-center gap-3">
                    <label className="text-sm text-neutral-400 font-semibold">{t('mobileScanner.qty')}</label>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setRestockQty(String(Math.max(1, parseInt(restockQty) - 1)))}
                        className="w-10 h-10 bg-neutral-800 text-white font-bold rounded-lg border border-neutral-700 text-lg touch-manipulation"
                      >
                        −
                      </button>
                      <input
                        type="number"
                        value={restockQty}
                        onChange={(e) => setRestockQty(e.target.value)}
                        className="w-16 text-center py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-white font-bold"
                        min="1"
                      />
                      <button
                        onClick={() => setRestockQty(String(parseInt(restockQty) + 1))}
                        className="w-10 h-10 bg-neutral-800 text-white font-bold rounded-lg border border-neutral-700 text-lg touch-manipulation"
                      >
                        +
                      </button>
                    </div>
                  </div>

                  <button
                    onClick={handleRestock}
                    disabled={loading}
                    className="w-full py-4 bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white font-bold rounded-xl text-lg flex items-center justify-center gap-2 transition-colors touch-manipulation"
                  >
                    <Check className="w-5 h-5" />
                    {loading ? t('mobileScanner.restocking') : t('mobileScanner.restock')}
                  </button>
                </div>
              )}

              {/* Session tracker */}
              {showSession && session.length > 0 && (
                <div className="bg-neutral-900 border border-neutral-800 rounded-xl overflow-hidden">
                  <div className="p-3 border-b border-neutral-800">
                    <p className="text-sm font-bold text-neutral-300">{t('mobileScanner.session', { count: session.length })}</p>
                  </div>
                  <div className="divide-y divide-neutral-800 max-h-48 overflow-y-auto">
                    {session.map((entry, i) => (
                      <div key={i} className="px-3 py-2 flex items-center justify-between">
                        <div>
                          <p className="text-sm text-white font-semibold">{entry.item.name}</p>
                          <p className="text-xs text-neutral-500">+{entry.quantity} {entry.item.unit}</p>
                        </div>
                        <span className="text-sm text-green-400 font-bold">{entry.newQuantity}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {/* Error */}
          {error && (
            <div className="bg-red-900/30 border border-red-700 rounded-xl p-3">
              <p className="text-red-300 text-sm">{error}</p>
            </div>
          )}
        </div>
      </div>
    </>
  );
};

export default MobileScannerScreen;
