import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Plus, Printer as PrinterIcon } from 'lucide-react';
import {
  getPrinters,
  createPrinter,
  updatePrinter,
  getCategoryPrinterRoutes,
  updateCategoryPrinterRoute,
  getCategories,
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

  useEffect(() => {
    fetchData();
  }, []);

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
                    <button onClick={handleCreatePrinter} className="px-4 py-2 bg-green-600 text-white rounded-lg font-medium hover:bg-green-700">{t('common:buttons.create')}</button>
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
                      </div>
                    </div>
                    <button
                      onClick={() => handleTogglePrinter(printer)}
                      className={`px-3 py-1 rounded-lg text-sm font-medium ${printer.active ? 'bg-green-900/30 text-green-400' : 'bg-neutral-800 text-neutral-500'}`}
                    >
                      {printer.active ? t('printers.active') : t('printers.inactive')}
                    </button>
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
