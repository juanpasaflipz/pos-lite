import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowLeft,
  FileText,
  Settings,
  ListOrdered,
  XCircle,
  CheckCircle,
  Loader2,
} from 'lucide-react';
import { getCfdiConfig, getCfdiCatalogs } from '../api';
import type { CfdiConfig, CfdiCatalogs } from '../types';
import ConfigTab from '../components/invoicing/ConfigTab';
import IssueInvoiceTab from '../components/invoicing/IssueInvoiceTab';
import InvoiceListTab from '../components/invoicing/InvoiceListTab';

type Tab = 'config' | 'issue' | 'list';

export default function InvoicingScreen() {
  const [activeTab, setActiveTab] = useState<Tab>('config');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [config, setConfig] = useState<CfdiConfig | null>(null);
  const [catalogs, setCatalogs] = useState<CfdiCatalogs | null>(null);

  useEffect(() => {
    fetchInitialData();
  }, []);

  const fetchInitialData = async () => {
    try {
      setLoading(true);
      setError(null);
      const [configRes, catalogsRes] = await Promise.all([
        getCfdiConfig(),
        getCfdiCatalogs(),
      ]);
      setConfig(configRes.config);
      setCatalogs(catalogsRes);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error loading data');
    } finally {
      setLoading(false);
    }
  };

  const handleError = (msg: string) => {
    setError(msg);
  };

  const handleSuccess = (msg: string) => {
    setSuccess(msg);
    setTimeout(() => setSuccess(null), 4000);
  };

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'config', label: 'CFDI Settings', icon: <Settings size={18} /> },
    { id: 'issue', label: 'Issue Invoice', icon: <FileText size={18} /> },
    { id: 'list', label: 'Invoice List', icon: <ListOrdered size={18} /> },
  ];

  return (
    <div className="min-h-screen bg-neutral-950">
      {/* Header */}
      <div className="bg-neutral-900 text-white p-6 border-b border-neutral-800">
        <div className="flex items-center gap-4">
          <Link
            to="/admin"
            className="p-2 hover:bg-neutral-800 rounded-lg transition-colors"
          >
            <ArrowLeft size={24} />
          </Link>
          <FileText className="text-brand-500" size={28} />
          <h1 className="text-3xl font-black tracking-tighter">
            Electronic Invoicing
          </h1>
        </div>
      </div>

      {/* Tab Navigation */}
      <div className="bg-neutral-900 border-b border-neutral-800 px-6">
        <div className="flex gap-1 overflow-x-auto">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 px-4 py-3 text-sm font-medium rounded-t-lg transition-colors whitespace-nowrap ${
                activeTab === tab.id
                  ? 'bg-neutral-950 text-brand-500 border-t-2 border-brand-500'
                  : 'text-neutral-400 hover:text-white hover:bg-neutral-800'
              }`}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div className="max-w-7xl mx-auto p-6">
        {/* Alerts */}
        {error && (
          <div className="bg-red-900/30 border border-red-800 rounded-lg p-4 mb-6 flex items-start gap-3">
            <XCircle className="text-red-400 flex-shrink-0 mt-0.5" size={18} />
            <p className="text-red-300 text-sm">{error}</p>
            <button
              onClick={() => setError(null)}
              className="ml-auto text-red-500 hover:text-red-300"
            >
              <XCircle size={16} />
            </button>
          </div>
        )}

        {success && (
          <div className="bg-green-900/30 border border-green-800 rounded-lg p-4 mb-6 flex items-start gap-3">
            <CheckCircle className="text-green-400 flex-shrink-0 mt-0.5" size={18} />
            <p className="text-green-300 text-sm">{success}</p>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 size={32} className="animate-spin text-brand-500" />
          </div>
        ) : (
          <>
            {activeTab === 'config' && (
              <ConfigTab
                config={config}
                catalogs={catalogs}
                onConfigUpdate={setConfig}
                onError={handleError}
                onSuccess={handleSuccess}
              />
            )}

            {activeTab === 'issue' && (
              <IssueInvoiceTab
                catalogs={catalogs}
                onError={handleError}
                onSuccess={handleSuccess}
              />
            )}

            {activeTab === 'list' && (
              <InvoiceListTab
                catalogs={catalogs}
                onError={handleError}
                onSuccess={handleSuccess}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
