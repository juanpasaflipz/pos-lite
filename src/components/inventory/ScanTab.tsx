import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  ScanLine,
  CheckCircle,
  X,
  Camera,
  CameraOff,
} from 'lucide-react';
import { InventoryItem, ScanSession } from '../../types';
import { formatDateTime } from '../../utils/dateFormat';

interface ScanTabProps {
  scanInput: string;
  scanLoading: boolean;
  scannedItem: InventoryItem | null;
  scanRestockQty: string;
  scanCostPrice: string;
  scanSession: ScanSession[];
  cameraActive: boolean;
  cameraSupported: boolean;
  actionLoading: boolean;
  videoRef: React.RefObject<HTMLVideoElement>;
  scanInputRef: React.RefObject<HTMLInputElement>;
  onScanInputChange: (value: string) => void;
  onScanLookup: () => void;
  onScanRestock: () => void;
  onCameraToggle: () => void;
  onScannedItemClear: () => void;
  onScanRestockQtyChange: (value: string) => void;
  onScanCostPriceChange: (value: string) => void;
  onClearSession: () => void;
}

export default function ScanTab({
  scanInput,
  scanLoading,
  scannedItem,
  scanRestockQty,
  scanCostPrice,
  scanSession,
  cameraActive,
  cameraSupported,
  actionLoading,
  videoRef,
  scanInputRef,
  onScanInputChange,
  onScanLookup,
  onScanRestock,
  onCameraToggle,
  onScannedItemClear,
  onScanRestockQtyChange,
  onScanCostPriceChange,
  onClearSession,
}: ScanTabProps) {
  const { t } = useTranslation('inventory');

  return (
    <>
      <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800 mb-6">
        <h3 className="text-lg font-bold text-white mb-4">{t('scan.title')}</h3>

        {/* Scan input */}
        <div className="flex gap-3 mb-6">
          <div className="relative flex-1">
            <ScanLine className="absolute left-3 top-3 text-neutral-500" size={20} />
            <input
              ref={scanInputRef}
              type="text"
              value={scanInput}
              onChange={(e) => onScanInputChange(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && onScanLookup()}
              placeholder={t('scan.inputPlaceholder')}
              className="w-full pl-10 pr-4 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:border-brand-600"
              autoFocus
            />
          </div>
          <button
            onClick={onScanLookup}
            disabled={scanLoading || !scanInput.trim()}
            className="px-6 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors disabled:opacity-50 font-medium"
          >
            {scanLoading ? t('scan.scanning') : t('scan.lookup')}
          </button>
          {cameraSupported && (
            <button
              onClick={onCameraToggle}
              className={`px-4 py-2 rounded-lg transition-colors font-medium ${
                cameraActive
                  ? 'bg-red-600 text-white hover:bg-red-700'
                  : 'bg-neutral-700 text-neutral-300 hover:bg-neutral-600'
              }`}
            >
              {cameraActive ? <CameraOff size={20} /> : <Camera size={20} />}
            </button>
          )}
        </div>

        {/* Camera view */}
        {cameraActive && (
          <div className="mb-6 rounded-lg overflow-hidden border border-neutral-700">
            <video ref={videoRef} className="w-full max-h-64 object-cover bg-black" />
          </div>
        )}

        {/* Scanned item detail */}
        {scannedItem && (
          <div className="p-4 bg-neutral-800 rounded-lg border border-brand-700 mb-6">
            <div className="flex items-center gap-2 mb-3">
              <CheckCircle className="text-brand-400" size={20} />
              <h4 className="text-white font-semibold">{t('scan.itemFound')}</h4>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
              <div>
                <p className="text-neutral-400 text-xs">{t('inventory.columns.itemName')}</p>
                <p className="text-white font-medium">{scannedItem.name}</p>
              </div>
              <div>
                <p className="text-neutral-400 text-xs">{t('scan.currentStock')}</p>
                <p className="text-white">{scannedItem.quantity} {scannedItem.unit}</p>
              </div>
              {scannedItem.barcode && (
                <div>
                  <p className="text-neutral-400 text-xs">{t('inventory.barcode')}</p>
                  <p className="text-neutral-300 text-sm">{scannedItem.barcode}</p>
                </div>
              )}
              {scannedItem.sku && (
                <div>
                  <p className="text-neutral-400 text-xs">{t('inventory.sku')}</p>
                  <p className="text-neutral-300 text-sm">{scannedItem.sku}</p>
                </div>
              )}
            </div>
            <div className="flex gap-3 items-end">
              <div>
                <label className="text-neutral-400 text-xs block mb-1">{t('scan.restockQty')}</label>
                <input
                  type="number"
                  value={scanRestockQty}
                  onChange={(e) => onScanRestockQtyChange(e.target.value)}
                  className="w-24 px-3 py-2 bg-neutral-700 border border-neutral-600 rounded-lg text-white focus:outline-none focus:border-brand-600"
                  min="0.1"
                  step="0.1"
                />
              </div>
              <div>
                <label className="text-neutral-400 text-xs block mb-1">{t('scan.costPrice')}</label>
                <input
                  type="number"
                  value={scanCostPrice}
                  onChange={(e) => onScanCostPriceChange(e.target.value)}
                  className="w-28 px-3 py-2 bg-neutral-700 border border-neutral-600 rounded-lg text-white focus:outline-none focus:border-brand-600"
                  min="0"
                  step="0.01"
                  placeholder="$0.00"
                />
              </div>
              <button
                onClick={onScanRestock}
                disabled={actionLoading || !scanRestockQty}
                className="px-6 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors disabled:opacity-50 font-medium"
              >
                {actionLoading ? t('scan.restocking') : t('scan.confirmRestock')}
              </button>
              <button
                onClick={onScannedItemClear}
                className="px-4 py-2 bg-neutral-700 text-neutral-300 rounded-lg hover:bg-neutral-600 transition-colors"
              >
                <X size={20} />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Scan session */}
      <div className="bg-neutral-900 p-6 rounded-lg border border-neutral-800">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold text-white">{t('scan.session')}</h3>
          {scanSession.length > 0 && (
            <button
              onClick={onClearSession}
              className="text-sm text-neutral-400 hover:text-white transition-colors"
            >
              {t('scan.clearSession')}
            </button>
          )}
        </div>
        {scanSession.length === 0 ? (
          <div className="text-center py-12">
            <ScanLine className="mx-auto text-neutral-600 mb-3" size={40} />
            <p className="text-neutral-400">{t('scan.sessionEmpty')}</p>
            <p className="text-neutral-500 text-sm mt-1">{t('scan.sessionHint')}</p>
          </div>
        ) : (
          <div className="space-y-2">
            {scanSession.map((entry, idx) => (
              <div key={idx} className="flex items-center justify-between p-3 bg-neutral-800 rounded-lg">
                <div>
                  <p className="text-white font-medium">{entry.item.name}</p>
                  <p className="text-neutral-500 text-xs">
                    {entry.item.barcode || entry.item.sku || ''}
                  </p>
                </div>
                <div className="flex items-center gap-4">
                  <span className="text-brand-400 font-medium">+{entry.quantity} {entry.item.unit}</span>
                  <span className="text-neutral-500 text-xs">
                    {formatDateTime(new Date(entry.scanned_at))}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
