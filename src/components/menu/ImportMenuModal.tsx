import React, { useState, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Loader2, Check, Upload, FileText, AlertTriangle, Download } from 'lucide-react';
import { previewMenuCSV, commitMenuCSV } from '../../api';
import { CSVImportPreview, MenuImportStats } from '../../types';

type Step = 'upload' | 'preview' | 'importing' | 'done';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onImportComplete?: () => void;
}

function generateExampleCSV(): string {
  return [
    'name,price,category,description,ingredients',
    'Taco de Asada,35,Tacos,Carne asada con cebolla y cilantro,"carne asada,tortilla,cebolla,cilantro"',
    'Quesadilla de Queso,45,Quesadillas,Queso Oaxaca derretido,"tortilla,queso oaxaca"',
    'Agua de Horchata,25,Bebidas,Agua fresca de horchata,',
    'Torta de Milanesa,65,Tortas,Milanesa con frijoles y aguacate,"milanesa,pan telera,frijoles,aguacate"',
  ].join('\n');
}

export default function ImportMenuModal({ isOpen, onClose, onImportComplete }: Props) {
  const { t } = useTranslation('admin');
  const [step, setStep] = useState<Step>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<CSVImportPreview | null>(null);
  const [stats, setStats] = useState<MenuImportStats | null>(null);
  const [error, setError] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setStep('upload');
    setFile(null);
    setPreview(null);
    setStats(null);
    setError('');
    setDragOver(false);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleFile = useCallback(async (f: File) => {
    setFile(f);
    setError('');
    try {
      const result = await previewMenuCSV(f);
      setPreview(result);
      setStep('preview');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('menuImport.failedParse'));
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
  }, [handleFile]);

  const handleCommit = async () => {
    if (!file) return;
    setStep('importing');
    setError('');
    try {
      const result = await commitMenuCSV(file, preview?.column_mapping);
      setStats(result);
      setStep('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('menuImport.failedImport'));
      setStep('preview');
    }
  };

  const handleDownloadExample = () => {
    const csv = generateExampleCSV();
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'menu_example.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleDone = () => {
    onImportComplete?.();
    handleClose();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={handleClose}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
      <div
        className="relative bg-neutral-900 border border-neutral-800 rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="sticky top-0 bg-neutral-900 border-b border-neutral-800 px-6 py-4 flex items-center justify-between z-10">
          <h2 className="text-lg font-bold text-white">
            {step === 'upload' && t('menuImport.title')}
            {step === 'preview' && t('menuImport.previewTitle')}
            {step === 'importing' && t('menuImport.importing')}
            {step === 'done' && t('menuImport.importComplete')}
          </h2>
          <button onClick={handleClose} className="p-2 hover:bg-neutral-800 rounded-lg transition-colors">
            <X size={18} className="text-neutral-400" />
          </button>
        </div>

        <div className="p-6">
          {/* Upload step */}
          {step === 'upload' && (
            <div className="space-y-4">
              <div
                onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                className={`border-2 border-dashed rounded-xl p-12 text-center cursor-pointer transition-colors ${
                  dragOver
                    ? 'border-brand-500 bg-brand-950/30'
                    : 'border-neutral-700 hover:border-neutral-600 bg-neutral-800/30'
                }`}
              >
                <Upload size={36} className="mx-auto text-neutral-500 mb-4" />
                <p className="text-white font-medium mb-1">
                  {t('menuImport.dropFile')}
                </p>
                <p className="text-neutral-400 text-sm">
                  {t('menuImport.orClickBrowse')}
                </p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,.tsv,.txt"
                  className="hidden"
                  onChange={e => {
                    const f = e.target.files?.[0];
                    if (f) handleFile(f);
                  }}
                />
              </div>

              {error && (
                <div className="text-red-400 text-sm bg-red-900/20 border border-red-800/40 rounded-lg p-3">{error}</div>
              )}

              <div className="flex items-center justify-between pt-2">
                <button
                  onClick={handleDownloadExample}
                  className="flex items-center gap-2 text-brand-400 hover:text-brand-300 text-sm font-medium transition-colors"
                >
                  <Download size={14} /> {t('menuImport.downloadExample')}
                </button>
                <p className="text-neutral-500 text-xs">
                  {t('menuImport.supportsExports')}
                </p>
              </div>
            </div>
          )}

          {/* Preview step */}
          {step === 'preview' && preview && (
            <div className="space-y-5">
              {/* Summary */}
              <div className="flex gap-4">
                <div className="flex-1 bg-neutral-800/60 rounded-lg p-3 text-center">
                  <p className="text-2xl font-bold text-brand-400">{preview.valid_count}</p>
                  <p className="text-neutral-400 text-xs mt-1">{t('menuImport.validItems')}</p>
                </div>
                {preview.invalid_count > 0 && (
                  <div className="flex-1 bg-neutral-800/60 rounded-lg p-3 text-center">
                    <p className="text-2xl font-bold text-amber-400">{preview.invalid_count}</p>
                    <p className="text-neutral-400 text-xs mt-1">{t('menuImport.skippedRows')}</p>
                  </div>
                )}
                <div className="flex-1 bg-neutral-800/60 rounded-lg p-3 text-center">
                  <p className="text-2xl font-bold text-neutral-300">{preview.detected_categories.length}</p>
                  <p className="text-neutral-400 text-xs mt-1">{t('menuImport.categories')}</p>
                </div>
              </div>

              {/* File info */}
              <div className="flex items-center gap-3 text-sm text-neutral-400">
                <FileText size={14} />
                <span>{file?.name}</span>
                <span>&middot;</span>
                <span>{preview.total} total rows</span>
              </div>

              {/* Column mapping */}
              <div>
                <h4 className="text-neutral-300 text-sm font-medium mb-2">{t('menuImport.detectedColumns')}</h4>
                <div className="flex flex-wrap gap-2">
                  {Object.entries(preview.column_mapping).map(([key, col]) => (
                    <span key={key} className="px-2.5 py-1 bg-brand-900/30 text-brand-400 text-xs rounded-md font-medium">
                      {key}: {col}
                    </span>
                  ))}
                </div>
              </div>

              {/* Categories */}
              <div>
                <h4 className="text-neutral-300 text-sm font-medium mb-2">{t('menuImport.categoriesToCreate')}</h4>
                <div className="flex flex-wrap gap-2">
                  {preview.detected_categories.map(c => (
                    <span key={c} className="px-2.5 py-1 bg-neutral-800 text-neutral-300 text-xs rounded-md">
                      {c}
                    </span>
                  ))}
                </div>
              </div>

              {/* Preview table */}
              <div>
                <h4 className="text-neutral-300 text-sm font-medium mb-2">{t('menuImport.previewRows')}</h4>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-neutral-700">
                        <th className="text-left py-2 pr-3 text-neutral-400 font-medium">{t('menuImport.colName')}</th>
                        <th className="text-right py-2 px-3 text-neutral-400 font-medium">{t('menuImport.colPrice')}</th>
                        <th className="text-left py-2 px-3 text-neutral-400 font-medium">{t('menuImport.colCategory')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.valid_rows.slice(0, 10).map((row, i) => (
                        <tr key={i} className="border-b border-neutral-800/50">
                          <td className="py-2 pr-3 text-neutral-200">{row.name as string}</td>
                          <td className="py-2 px-3 text-neutral-300 text-right font-mono">${row.price as number}</td>
                          <td className="py-2 px-3 text-neutral-400">{row.category as string}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Invalid rows warning */}
              {preview.invalid_count > 0 && (
                <div className="bg-amber-900/20 border border-amber-700/40 rounded-lg p-3">
                  <div className="flex items-start gap-2">
                    <AlertTriangle size={14} className="text-amber-400 flex-shrink-0 mt-0.5" />
                    <div className="text-sm text-amber-300">
                      <p className="font-medium mb-1">{t('menuImport.rowsSkipped', { count: preview.invalid_count })}</p>
                      {preview.invalid_rows.slice(0, 3).map((r, i) => (
                        <p key={i} className="text-xs text-amber-400/80">
                          Row {r.row}: {r.reason}
                        </p>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {error && (
                <div className="text-red-400 text-sm bg-red-900/20 border border-red-800/40 rounded-lg p-3">{error}</div>
              )}

              <div className="flex gap-3">
                <button
                  onClick={reset}
                  className="flex-1 py-3 border border-neutral-700 text-neutral-300 font-medium rounded-xl hover:bg-neutral-800 transition-colors text-sm"
                >
                  {t('menuImport.chooseDifferentFile')}
                </button>
                <button
                  onClick={handleCommit}
                  className="flex-1 py-3 bg-brand-600 hover:bg-brand-500 text-white font-semibold rounded-xl transition-colors text-sm"
                >
                  {t('menuImport.importItems', { count: preview.valid_count })}
                </button>
              </div>
            </div>
          )}

          {/* Importing step */}
          {step === 'importing' && (
            <div className="flex flex-col items-center justify-center py-16">
              <Loader2 size={36} className="text-brand-500 animate-spin mb-4" />
              <p className="text-neutral-300 text-sm">{t('menuImport.importingItems')}</p>
            </div>
          )}

          {/* Done step */}
          {step === 'done' && stats && (
            <div className="space-y-5">
              <div className="flex items-center justify-center">
                <div className="w-16 h-16 rounded-full bg-brand-600/20 flex items-center justify-center">
                  <Check size={32} className="text-brand-400" />
                </div>
              </div>
              <h3 className="text-white text-xl font-bold text-center">{t('menuImport.importComplete')}</h3>

              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                {stats.categoriesCreated > 0 && (
                  <div className="bg-neutral-800/60 rounded-lg p-3 text-center">
                    <p className="text-2xl font-bold text-brand-400">{stats.categoriesCreated}</p>
                    <p className="text-neutral-400 text-xs mt-1">{t('menuImport.categories')}</p>
                  </div>
                )}
                <div className="bg-neutral-800/60 rounded-lg p-3 text-center">
                  <p className="text-2xl font-bold text-brand-400">{stats.itemsCreated}</p>
                  <p className="text-neutral-400 text-xs mt-1">{t('menuImport.itemsCreated')}</p>
                </div>
                {stats.inventoryCreated > 0 && (
                  <div className="bg-neutral-800/60 rounded-lg p-3 text-center">
                    <p className="text-2xl font-bold text-brand-400">{stats.inventoryCreated}</p>
                    <p className="text-neutral-400 text-xs mt-1">{t('menuImport.ingredients')}</p>
                  </div>
                )}
              </div>

              {stats.warnings.length > 0 && (
                <div className="bg-amber-900/20 border border-amber-700/40 rounded-lg p-3">
                  {stats.warnings.map((w, i) => (
                    <p key={i} className="text-amber-300 text-sm flex items-start gap-2">
                      <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" /> {w}
                    </p>
                  ))}
                </div>
              )}

              <button
                onClick={handleDone}
                className="w-full py-3 bg-brand-600 hover:bg-brand-500 text-white font-semibold rounded-xl transition-colors text-sm"
              >
                {t('menuImport.goToMenu')}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
