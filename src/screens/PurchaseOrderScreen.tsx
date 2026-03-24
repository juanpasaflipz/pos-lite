import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft, Plus, FileText, Truck, Check, X, Package, Send, ChevronDown, ChevronUp,
} from 'lucide-react';
import {
  getPurchaseOrders, getPurchaseOrder, createPurchaseOrder, submitPurchaseOrder,
  receivePurchaseOrder, cancelPurchaseOrder, getVendors, createVendor, getInventory,
} from '../api';
import { PurchaseOrder, PurchaseOrderItem, Vendor, InventoryItem } from '../types';
import { formatPrice } from '../utils/currency';
import { formatDate } from '../utils/dateFormat';

type View = 'list' | 'create' | 'detail';

const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-neutral-600',
  submitted: 'bg-blue-600',
  partial: 'bg-amber-600',
  received: 'bg-green-600',
  cancelled: 'bg-brand-600',
};

export default function PurchaseOrderScreen() {
  const { t } = useTranslation('inventory');
  const [view, setView] = useState<View>('list');
  const [pos, setPOs] = useState<PurchaseOrder[]>([]);
  const [selectedPO, setSelectedPO] = useState<PurchaseOrder | null>(null);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('');

  // Create PO form state
  const [newVendorId, setNewVendorId] = useState<number | ''>('');
  const [newNotes, setNewNotes] = useState('');
  const [newItems, setNewItems] = useState<Array<{ inventory_item_id: number; quantity_ordered: number; unit_cost: number }>>([]);
  const [creating, setCreating] = useState(false);

  // Add vendor inline
  const [showAddVendor, setShowAddVendor] = useState(false);
  const [newVendorName, setNewVendorName] = useState('');
  const [newVendorContact, setNewVendorContact] = useState('');
  const [newVendorPhone, setNewVendorPhone] = useState('');
  const [savingVendor, setSavingVendor] = useState(false);

  // Receive state
  const [receiveItems, setReceiveItems] = useState<Record<number, number>>({});
  const [receiving, setReceiving] = useState(false);

  const STATUS_LABELS: Record<string, string> = {
    '': t('purchaseOrders.filters.all'),
    draft: t('purchaseOrders.filters.draft'),
    submitted: t('purchaseOrders.filters.submitted'),
    partial: t('purchaseOrders.filters.partial'),
    received: t('purchaseOrders.filters.received'),
    cancelled: t('purchaseOrders.filters.cancelled'),
  };

  useEffect(() => {
    loadData();
  }, [statusFilter]);

  const loadData = async () => {
    try {
      setLoading(true);
      const [posData, vendorsData, invData] = await Promise.all([
        getPurchaseOrders(statusFilter || undefined),
        getVendors(),
        getInventory(),
      ]);
      setPOs(posData);
      setVendors(vendorsData);
      setInventory(invData);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.loadData'));
    } finally {
      setLoading(false);
    }
  };

  const showSuccess = (msg: string) => {
    setSuccess(msg);
    setTimeout(() => setSuccess(null), 3000);
  };

  const handleCreatePO = async () => {
    if (!newVendorId || newItems.length === 0) {
      setError(t('purchaseOrders.toast.vendorRequired'));
      return;
    }
    try {
      setCreating(true);
      setError(null);
      await createPurchaseOrder({
        vendor_id: newVendorId as number,
        items: newItems,
        notes: newNotes || undefined,
      });
      showSuccess(t('purchaseOrders.toast.created'));
      setView('list');
      setNewVendorId('');
      setNewNotes('');
      setNewItems([]);
      loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.createPo'));
    } finally {
      setCreating(false);
    }
  };

  const handleViewDetail = async (id: number) => {
    try {
      const po = await getPurchaseOrder(id);
      setSelectedPO(po);
      setReceiveItems({});
      setView('detail');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.loadPo'));
    }
  };

  const handleSubmitPO = async (id: number) => {
    try {
      await submitPurchaseOrder(id);
      showSuccess(t('purchaseOrders.toast.submitted'));
      handleViewDetail(id);
      loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.submitPo'));
    }
  };

  const handleReceivePO = async (id: number) => {
    const items = Object.entries(receiveItems)
      .filter(([_, qty]) => qty > 0)
      .map(([poItemId, qty]) => ({ po_item_id: Number(poItemId), quantity_received: qty }));
    if (items.length === 0) {
      setError(t('purchaseOrders.actions.enterReceived'));
      return;
    }
    try {
      setReceiving(true);
      await receivePurchaseOrder(id, items);
      showSuccess(t('purchaseOrders.toast.received'));
      handleViewDetail(id);
      loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.receivePo'));
    } finally {
      setReceiving(false);
    }
  };

  const handleCancelPO = async (id: number) => {
    try {
      await cancelPurchaseOrder(id);
      showSuccess(t('purchaseOrders.toast.cancelled'));
      handleViewDetail(id);
      loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.cancelPo'));
    }
  };

  const handleAddVendor = async () => {
    if (!newVendorName.trim()) return;
    try {
      setSavingVendor(true);
      const vendor = await createVendor({
        name: newVendorName.trim(),
        contact_name: newVendorContact.trim() || undefined,
        phone: newVendorPhone.trim() || undefined,
        active: true,
      });
      const vendorsData = await getVendors();
      setVendors(vendorsData);
      setNewVendorId(vendor.id);
      setShowAddVendor(false);
      setNewVendorName('');
      setNewVendorContact('');
      setNewVendorPhone('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error creating vendor');
    } finally {
      setSavingVendor(false);
    }
  };

  const addLineItem = () => {
    setNewItems((prev) => [...prev, { inventory_item_id: 0, quantity_ordered: 1, unit_cost: 0 }]);
  };

  const updateLineItem = (index: number, field: string, value: any) => {
    setNewItems((prev) => prev.map((item, i) => i === index ? { ...item, [field]: value } : item));
  };

  const removeLineItem = (index: number) => {
    setNewItems((prev) => prev.filter((_, i) => i !== index));
  };

  return (
    <div className="min-h-screen bg-neutral-950">
      <div className="bg-neutral-900 text-white p-6 border-b border-neutral-800">
        <div className="flex items-center gap-4">
          {view === 'list' ? (
            <Link to="/admin" className="p-2 hover:bg-neutral-800 rounded-lg transition-colors">
              <ArrowLeft size={24} />
            </Link>
          ) : (
            <button onClick={() => { setView('list'); loadData(); }} className="p-2 hover:bg-neutral-800 rounded-lg transition-colors">
              <ArrowLeft size={24} />
            </button>
          )}
          <FileText className="text-brand-500" size={28} />
          <h1 className="text-3xl font-black tracking-tighter">{t('purchaseOrders.title')}</h1>
          {view === 'list' && (
            <button
              onClick={() => setView('create')}
              className="ml-auto px-4 py-2 bg-brand-600 text-white font-bold rounded-lg hover:bg-brand-700 flex items-center gap-2"
            >
              <Plus size={18} /> {t('purchaseOrders.newPo')}
            </button>
          )}
        </div>
      </div>

      <div className="max-w-6xl mx-auto p-6">
        {error && (
          <div className="bg-brand-900/30 border border-brand-800 rounded-lg p-4 mb-6">
            <p className="text-brand-300">{error}</p>
            <button onClick={() => setError(null)} className="text-brand-400 text-sm mt-1 underline">{t('menu.dismiss')}</button>
          </div>
        )}
        {success && (
          <div className="bg-green-900/30 border border-green-800 rounded-lg p-4 mb-6">
            <p className="text-green-300">{success}</p>
          </div>
        )}

        {/* LIST VIEW */}
        {view === 'list' && (
          <>
            <div className="flex gap-2 mb-6 flex-wrap">
              {['', 'draft', 'submitted', 'partial', 'received', 'cancelled'].map((s) => (
                <button
                  key={s}
                  onClick={() => { setStatusFilter(s); }}
                  className={`px-3 py-1.5 rounded-lg text-sm font-bold transition-colors ${
                    statusFilter === s ? 'bg-brand-600 text-white' : 'bg-neutral-800 text-neutral-400 hover:bg-neutral-700'
                  }`}
                >
                  {STATUS_LABELS[s]}
                </button>
              ))}
            </div>

            {loading ? (
              <div className="text-center text-neutral-400 py-12">{t('purchaseOrders.loading')}</div>
            ) : pos.length === 0 ? (
              <div className="text-center text-neutral-500 py-12">{t('purchaseOrders.noPOs')}</div>
            ) : (
              <div className="space-y-3">
                {pos.map((po) => (
                  <div
                    key={po.id}
                    onClick={() => handleViewDetail(po.id)}
                    className="bg-neutral-900 border border-neutral-800 rounded-lg p-4 hover:border-brand-600 transition-colors cursor-pointer flex items-center justify-between"
                  >
                    <div>
                      <div className="flex items-center gap-3">
                        <span className="text-white font-bold text-lg">{po.po_number}</span>
                        <span className={`${STATUS_COLORS[po.status]} text-white text-xs px-2 py-0.5 rounded-full font-bold uppercase`}>
                          {po.status}
                        </span>
                      </div>
                      <p className="text-neutral-400 text-sm mt-1">
                        {po.vendor_name} &bull; {formatDate(new Date(po.created_at))}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-white font-bold">{formatPrice(po.total_amount)}</p>
                      {po.created_by_name && (
                        <p className="text-neutral-500 text-xs">{t('purchaseOrders.detail.by')} {po.created_by_name}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {/* CREATE VIEW */}
        {view === 'create' && (
          <div className="space-y-6">
            <div>
              <label className="block text-sm font-bold text-white mb-2">{t('purchaseOrders.form.vendor')}</label>
              <div className="flex gap-2">
                <select
                  value={newVendorId}
                  onChange={(e) => setNewVendorId(Number(e.target.value) || '')}
                  className="flex-1 bg-neutral-800 border border-neutral-700 rounded-lg p-3 text-white focus:outline-none focus:border-brand-600"
                >
                  <option value="">{t('purchaseOrders.form.selectVendor')}</option>
                  {vendors.filter((v) => v.active).map((v) => (
                    <option key={v.id} value={v.id}>{v.name}</option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => setShowAddVendor(!showAddVendor)}
                  className="px-3 bg-brand-600 text-white font-bold rounded-lg hover:bg-brand-700 flex items-center gap-1"
                >
                  <Plus size={18} />
                </button>
              </div>
              {showAddVendor && (
                <div className="mt-3 bg-neutral-800 border border-neutral-700 rounded-lg p-4 space-y-3">
                  <input
                    type="text"
                    value={newVendorName}
                    onChange={(e) => setNewVendorName(e.target.value)}
                    className="w-full bg-neutral-700 border border-neutral-600 rounded-lg p-2 text-white text-sm focus:outline-none focus:border-brand-600"
                    placeholder={t('purchaseOrders.form.vendorName')}
                    autoFocus
                  />
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={newVendorContact}
                      onChange={(e) => setNewVendorContact(e.target.value)}
                      className="flex-1 bg-neutral-700 border border-neutral-600 rounded-lg p-2 text-white text-sm focus:outline-none focus:border-brand-600"
                      placeholder={t('purchaseOrders.form.vendorContact')}
                    />
                    <input
                      type="text"
                      value={newVendorPhone}
                      onChange={(e) => setNewVendorPhone(e.target.value)}
                      className="flex-1 bg-neutral-700 border border-neutral-600 rounded-lg p-2 text-white text-sm focus:outline-none focus:border-brand-600"
                      placeholder={t('purchaseOrders.form.vendorPhone')}
                    />
                  </div>
                  <div className="flex gap-2 justify-end">
                    <button
                      onClick={() => { setShowAddVendor(false); setNewVendorName(''); setNewVendorContact(''); setNewVendorPhone(''); }}
                      className="px-3 py-1.5 bg-neutral-700 text-neutral-300 text-sm font-bold rounded-lg hover:bg-neutral-600"
                    >
                      {t('common:buttons.cancel')}
                    </button>
                    <button
                      onClick={handleAddVendor}
                      disabled={!newVendorName.trim() || savingVendor}
                      className="px-4 py-1.5 bg-brand-600 text-white text-sm font-bold rounded-lg hover:bg-brand-700 disabled:opacity-50"
                    >
                      {savingVendor ? t('purchaseOrders.form.savingVendor') : t('purchaseOrders.form.addVendor')}
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div>
              <label className="block text-sm font-bold text-white mb-2">{t('purchaseOrders.form.notes')}</label>
              <textarea
                value={newNotes}
                onChange={(e) => setNewNotes(e.target.value)}
                className="w-full bg-neutral-800 border border-neutral-700 rounded-lg p-3 text-white focus:outline-none focus:border-brand-600 h-20"
                placeholder={t('purchaseOrders.form.notesPlaceholder')}
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-3">
                <label className="text-sm font-bold text-white">{t('purchaseOrders.form.lineItems')}</label>
                <button onClick={addLineItem} className="text-brand-400 text-sm font-bold flex items-center gap-1 hover:text-brand-300">
                  <Plus size={14} /> {t('purchaseOrders.form.addItem')}
                </button>
              </div>
              {newItems.map((item, idx) => (
                <div key={idx} className="flex gap-2 mb-2 items-center">
                  <select
                    value={item.inventory_item_id}
                    onChange={(e) => updateLineItem(idx, 'inventory_item_id', Number(e.target.value))}
                    className="flex-1 bg-neutral-800 border border-neutral-700 rounded-lg p-2 text-white text-sm"
                  >
                    <option value={0}>{t('purchaseOrders.form.selectItem')}</option>
                    {inventory.map((inv) => (
                      <option key={inv.id} value={inv.id}>{inv.name} ({inv.unit})</option>
                    ))}
                  </select>
                  <input
                    type="number"
                    value={item.quantity_ordered}
                    onChange={(e) => updateLineItem(idx, 'quantity_ordered', Number(e.target.value))}
                    className="w-20 bg-neutral-800 border border-neutral-700 rounded-lg p-2 text-white text-sm"
                    placeholder={t('purchaseOrders.form.qty')}
                    min={1}
                  />
                  <input
                    type="number"
                    value={item.unit_cost}
                    onChange={(e) => updateLineItem(idx, 'unit_cost', Number(e.target.value))}
                    className="w-24 bg-neutral-800 border border-neutral-700 rounded-lg p-2 text-white text-sm"
                    placeholder={t('purchaseOrders.form.cost')}
                    min={0}
                    step={0.01}
                  />
                  <button onClick={() => removeLineItem(idx)} className="text-brand-400 hover:text-brand-300 p-1">
                    <X size={18} />
                  </button>
                </div>
              ))}
              {newItems.length > 0 && (
                <div className="text-right mt-2">
                  <span className="text-neutral-400 text-sm">{t('purchaseOrders.form.total')} </span>
                  <span className="text-white font-bold">
                    {formatPrice(newItems.reduce((sum, i) => sum + i.quantity_ordered * i.unit_cost, 0))}
                  </span>
                </div>
              )}
            </div>

            <div className="flex gap-3">
              <button onClick={() => setView('list')} className="flex-1 py-3 bg-neutral-700 text-white font-bold rounded-lg hover:bg-neutral-600">
                {t('common:buttons.cancel')}
              </button>
              <button
                onClick={handleCreatePO}
                disabled={creating}
                className="flex-1 py-3 bg-brand-600 text-white font-bold rounded-lg hover:bg-brand-700 disabled:opacity-50"
              >
                {creating ? t('purchaseOrders.form.creating') : t('purchaseOrders.form.createPo')}
              </button>
            </div>
          </div>
        )}

        {/* DETAIL VIEW */}
        {view === 'detail' && selectedPO && (
          <div className="space-y-6">
            <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-6">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="text-2xl font-bold text-white">{selectedPO.po_number}</h2>
                  <p className="text-neutral-400">{selectedPO.vendor_name}</p>
                </div>
                <span className={`${STATUS_COLORS[selectedPO.status]} text-white px-4 py-1.5 rounded-full font-bold uppercase text-sm`}>
                  {selectedPO.status}
                </span>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                <div>
                  <p className="text-neutral-500">{t('purchaseOrders.detail.total')}</p>
                  <p className="text-white font-bold">{formatPrice(selectedPO.total_amount)}</p>
                </div>
                <div>
                  <p className="text-neutral-500">{t('purchaseOrders.detail.created')}</p>
                  <p className="text-white">{formatDate(new Date(selectedPO.created_at))}</p>
                </div>
                {selectedPO.submitted_at && (
                  <div>
                    <p className="text-neutral-500">{t('purchaseOrders.detail.submitted')}</p>
                    <p className="text-white">{formatDate(new Date(selectedPO.submitted_at))}</p>
                  </div>
                )}
                {selectedPO.received_at && (
                  <div>
                    <p className="text-neutral-500">{t('purchaseOrders.detail.received')}</p>
                    <p className="text-white">{formatDate(new Date(selectedPO.received_at))}</p>
                  </div>
                )}
              </div>
              {selectedPO.notes && (
                <p className="text-neutral-400 text-sm mt-3 italic">{selectedPO.notes}</p>
              )}
            </div>

            {/* Items */}
            <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-6">
              <h3 className="text-lg font-bold text-white mb-4">{t('purchaseOrders.detail.items')}</h3>
              <div className="space-y-3">
                {selectedPO.items?.map((item) => (
                  <div key={item.id} className="flex items-center justify-between p-3 bg-neutral-800 rounded-lg">
                    <div>
                      <p className="text-white font-medium">{item.item_name}</p>
                      <p className="text-neutral-400 text-sm">
                        {item.quantity_ordered} x {formatPrice(item.unit_cost)} = {formatPrice(item.line_total)}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-neutral-400 text-sm">{t('purchaseOrders.detail.receivedCount')}</p>
                      <p className="text-white font-bold">{item.quantity_received} / {item.quantity_ordered}</p>
                    </div>
                    {['submitted', 'partial'].includes(selectedPO.status) && item.quantity_received < item.quantity_ordered && (
                      <input
                        type="number"
                        value={receiveItems[item.id] || ''}
                        onChange={(e) => setReceiveItems((prev) => ({ ...prev, [item.id]: Number(e.target.value) }))}
                        className="w-20 ml-3 bg-neutral-700 border border-neutral-600 rounded-lg p-2 text-white text-sm text-center"
                        placeholder={t('purchaseOrders.form.qty')}
                        min={0}
                        max={item.quantity_ordered - item.quantity_received}
                      />
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Actions */}
            <div className="flex gap-3 flex-wrap">
              {selectedPO.status === 'draft' && (
                <button
                  onClick={() => handleSubmitPO(selectedPO.id)}
                  className="px-6 py-3 bg-blue-600 text-white font-bold rounded-lg hover:bg-blue-700 flex items-center gap-2"
                >
                  <Send size={18} /> {t('purchaseOrders.actions.submitPo')}
                </button>
              )}
              {['submitted', 'partial'].includes(selectedPO.status) && (
                <button
                  onClick={() => handleReceivePO(selectedPO.id)}
                  disabled={receiving}
                  className="px-6 py-3 bg-green-600 text-white font-bold rounded-lg hover:bg-green-700 disabled:opacity-50 flex items-center gap-2"
                >
                  <Package size={18} /> {receiving ? t('purchaseOrders.actions.receiving') : t('purchaseOrders.actions.receiveItems')}
                </button>
              )}
              {!['received', 'cancelled'].includes(selectedPO.status) && (
                <button
                  onClick={() => handleCancelPO(selectedPO.id)}
                  className="px-6 py-3 bg-neutral-700 text-white font-bold rounded-lg hover:bg-neutral-600 flex items-center gap-2"
                >
                  <X size={18} /> {t('purchaseOrders.actions.cancelPo')}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
