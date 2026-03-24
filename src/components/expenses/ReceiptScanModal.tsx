import React, { useState, useRef, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Camera, Upload, Loader2 } from 'lucide-react';
import { scanReceipt, type ReceiptScanResult, type Expense, type InventoryMatch } from '../../api';

const InventoryMatchStep = React.lazy(() => import('./InventoryMatchStep'));

interface Props {
  onParsed: (data: Partial<Expense> & { receipt_image_url?: string; inventory_matches?: InventoryMatch[] }) => void;
  onClose: () => void;
}

type Step = 'capture' | 'scan-results' | 'inventory-match';

const ReceiptScanModal: React.FC<Props> = ({ onParsed, onClose }) => {
  const { t } = useTranslation('admin');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState<ReceiptScanResult | null>(null);
  const [error, setError] = useState('');
  const [step, setStep] = useState<Step>('capture');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setFile(f);
    setPreview(URL.createObjectURL(f));
    setResult(null);
    setError('');
    setStep('capture');
  };

  const handleScan = async () => {
    if (!file) return;
    setScanning(true);
    setError('');
    try {
      const res = await scanReceipt(file);
      setResult(res);
      setStep('scan-results');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to scan receipt');
    } finally {
      setScanning(false);
    }
  };

  const buildExpenseData = (matches?: InventoryMatch[]) => {
    if (!result) return;
    const parsed = result.parsed;
    onParsed({
      vendor: parsed?.vendor || undefined,
      description: parsed?.items?.map(i => i.description).join(', ') || undefined,
      amount: parsed?.total || parsed?.subtotal || 0,
      tax_amount: parsed?.tax || 0,
      expense_date: parsed?.date || new Date().toISOString().slice(0, 10),
      payment_method: parsed?.payment_method || undefined,
      category: parsed?.category || 'food_cost',
      receipt_image_url: result.image_url,
      receipt_data: parsed as Record<string, unknown> | null,
      inventory_matches: matches,
    });
  };

  const handleConfirm = () => {
    if (!result) return;
    const parsedItems = result.parsed?.items;
    // If there are parsed items, show inventory matching step
    if (parsedItems && parsedItems.length > 0) {
      setStep('inventory-match');
    } else {
      // No items to match — go straight to form
      buildExpenseData();
    }
  };

  const handleInventoryMatches = (matches: InventoryMatch[]) => {
    buildExpenseData(matches.length > 0 ? matches : undefined);
  };

  const handleSkipMatching = () => {
    buildExpenseData();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="bg-neutral-900 rounded-xl border border-neutral-800 w-full max-w-lg max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-neutral-800">
          <h2 className="text-lg font-bold text-white">
            {step === 'inventory-match' ? t('expenses.matchInventory') : t('expenses.scanReceipt')}
          </h2>
          <button onClick={onClose} className="p-1 text-neutral-400 hover:text-white transition-colors">
            <X size={20} />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {/* Step: Inventory Match */}
          {step === 'inventory-match' && result?.parsed?.items && (
            <Suspense fallback={
              <div className="flex items-center justify-center py-8 text-neutral-400">
                <Loader2 size={20} className="animate-spin mr-2" />
                {t('expenses.loadingInventory')}
              </div>
            }>
              <InventoryMatchStep
                items={result.parsed.items}
                onContinue={handleInventoryMatches}
                onSkipAll={handleSkipMatching}
              />
            </Suspense>
          )}

          {/* Step: Capture / Scan Results */}
          {step !== 'inventory-match' && (
            <>
              {!preview ? (
                <div className="space-y-3">
                  <button
                    onClick={() => cameraInputRef.current?.click()}
                    className="w-full flex items-center justify-center gap-2 py-4 bg-brand-600 text-white font-semibold rounded-lg hover:bg-brand-700 transition-colors"
                  >
                    <Camera size={20} />
                    {t('expenses.takePhoto')}
                  </button>
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="w-full flex items-center justify-center gap-2 py-4 bg-neutral-800 text-white font-semibold rounded-lg border border-neutral-700 hover:bg-neutral-700 transition-colors"
                  >
                    <Upload size={20} />
                    {t('expenses.chooseFile')}
                  </button>
                  <input
                    ref={cameraInputRef}
                    type="file"
                    accept="image/*"
                    capture="environment"
                    onChange={handleFileSelect}
                    className="hidden"
                  />
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    onChange={handleFileSelect}
                    className="hidden"
                  />
                </div>
              ) : (
                <>
                  <div className="relative">
                    <img
                      src={preview}
                      alt="Receipt preview"
                      className="w-full max-h-64 object-contain rounded-lg bg-neutral-800"
                    />
                    <button
                      onClick={() => {
                        setFile(null);
                        setPreview(null);
                        setResult(null);
                        setStep('capture');
                      }}
                      className="absolute top-2 right-2 p-1 bg-black/60 rounded-full text-white hover:bg-black/80"
                    >
                      <X size={16} />
                    </button>
                  </div>

                  {!result && !scanning && (
                    <button
                      onClick={handleScan}
                      className="w-full py-3 bg-brand-600 text-white font-semibold rounded-lg hover:bg-brand-700 transition-colors"
                    >
                      {t('expenses.scanWithAI')}
                    </button>
                  )}

                  {scanning && (
                    <div className="flex items-center justify-center gap-2 py-4 text-brand-400">
                      <Loader2 size={20} className="animate-spin" />
                      <span className="font-medium">{t('expenses.analyzingReceipt')}</span>
                    </div>
                  )}

                  {error && (
                    <p className="text-red-400 text-sm text-center">{error}</p>
                  )}

                  {result && step === 'scan-results' && (
                    <div className="space-y-3">
                      <p className="text-sm text-neutral-400">{result.message}</p>

                      {result.parsed && (
                        <div className="bg-neutral-800 rounded-lg p-3 space-y-2 text-sm">
                          {result.parsed.vendor && (
                            <div className="flex justify-between">
                              <span className="text-neutral-400">{t('expenses.vendor')}</span>
                              <span className="text-white font-medium">{result.parsed.vendor}</span>
                            </div>
                          )}
                          {result.parsed.date && (
                            <div className="flex justify-between">
                              <span className="text-neutral-400">{t('expenses.date')}</span>
                              <span className="text-white font-medium">{result.parsed.date}</span>
                            </div>
                          )}
                          {result.parsed.items && result.parsed.items.length > 0 && (
                            <div>
                              <span className="text-neutral-400">{t('expenses.items')}</span>
                              <div className="mt-1 space-y-1">
                                {result.parsed.items.map((item, i) => (
                                  <div key={i} className="flex justify-between text-white">
                                    <span>{item.description}</span>
                                    <span>${Number(item.amount).toFixed(2)}</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                          <div className="border-t border-neutral-700 pt-2 flex justify-between font-bold">
                            <span className="text-neutral-400">{t('expenses.total')}</span>
                            <span className="text-white">${Number(result.parsed.total || 0).toFixed(2)}</span>
                          </div>
                        </div>
                      )}

                      <div className="flex gap-3">
                        <button
                          onClick={onClose}
                          className="flex-1 py-2.5 bg-neutral-800 text-white font-semibold rounded-lg hover:bg-neutral-700 transition-colors"
                        >
                          {t('common:buttons.cancel')}
                        </button>
                        <button
                          onClick={handleConfirm}
                          className="flex-1 py-2.5 bg-brand-600 text-white font-semibold rounded-lg hover:bg-brand-700 transition-colors"
                        >
                          {result.parsed ? t('expenses.editAndSave') : t('expenses.enterManually')}
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default ReceiptScanModal;
