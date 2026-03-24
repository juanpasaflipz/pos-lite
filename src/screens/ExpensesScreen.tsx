import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import {
  ArrowLeft,
  Plus,
  Camera,
  Download,
  Pencil,
  Trash2,
  Receipt,
  DollarSign,
  Loader2,
  Image,
  X,
  ChevronDown,
  ChevronUp,
  FileText,
  CalendarDays,
  Eye,
  Package,
} from 'lucide-react';
import {
  getExpenses,
  createExpense,
  updateExpense,
  deleteExpense,
  exportExpenses,
  type Expense,
  type InventoryMatch,
} from '../api';
import { formatPrice } from '../utils/currency';
import ExpenseFormModal from '../components/expenses/ExpenseFormModal';
import ReceiptScanModal from '../components/expenses/ReceiptScanModal';


const CATEGORY_COLORS: Record<string, string> = {
  food_cost: 'bg-orange-500/20 text-orange-400',
  supplies: 'bg-blue-500/20 text-blue-400',
  utilities: 'bg-yellow-500/20 text-yellow-400',
  rent: 'bg-purple-500/20 text-purple-400',
  marketing: 'bg-pink-500/20 text-pink-400',
  other: 'bg-neutral-500/20 text-neutral-400',
};

function getMonthRange() {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  const to = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);
  return { from, to };
}

function formatDate(d: string) {
  const date = new Date(d + 'T12:00:00');
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/* ==================== Receipt Image Viewer ==================== */

const ReceiptViewer: React.FC<{ url: string; onClose: () => void }> = ({ url, onClose }) => (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={onClose}>
    <div className="relative max-w-2xl w-full max-h-[90vh]" onClick={e => e.stopPropagation()}>
      <button
        onClick={onClose}
        className="absolute -top-3 -right-3 z-10 p-2 bg-neutral-800 rounded-full text-white hover:bg-neutral-700 transition-colors shadow-lg"
      >
        <X size={20} />
      </button>
      <img
        src={url}
        alt="Receipt"
        className="w-full max-h-[85vh] object-contain rounded-xl bg-neutral-900 shadow-2xl"
      />
    </div>
  </div>
);

/* ==================== Expanded Expense Detail ==================== */

interface ExpenseDetailProps {
  expense: Expense;
  onEdit: () => void;
  onDelete: () => void;
  onViewReceipt: (url: string) => void;
  t: (key: string, options?: Record<string, unknown>) => string;
}

const ExpenseDetail: React.FC<ExpenseDetailProps> = ({ expense, onEdit, onDelete, onViewReceipt, t }) => {
  const receiptItems = (expense.receipt_data as any)?.items as { description: string; amount: number }[] | undefined;
  const inventoryMatches = (expense.receipt_data as any)?.inventory_matches as { inventory_item_name: string; quantity: number }[] | undefined;

  return (
    <div className="px-4 pb-4 space-y-3 animate-in slide-in-from-top-2">
      {/* Inventory updated badge */}
      {inventoryMatches && inventoryMatches.length > 0 && (
        <div className="flex items-center gap-2 px-3 py-2 bg-green-500/10 border border-green-500/20 rounded-lg">
          <Package size={14} className="text-green-400 shrink-0" />
          <div className="text-sm">
            <span className="text-green-400 font-medium">{t('expenses.inventoryUpdated')}</span>
            <span className="text-neutral-400"> — </span>
            <span className="text-neutral-300">
              {inventoryMatches.map(m => `${m.inventory_item_name} (+${m.quantity})`).join(', ')}
            </span>
          </div>
        </div>
      )}

      {/* Receipt image + parsed items side by side */}
      {(expense.receipt_image_url || receiptItems) && (
        <div className="flex gap-3">
          {expense.receipt_image_url && (
            <button
              onClick={() => onViewReceipt(expense.receipt_image_url!)}
              className="relative group shrink-0 w-24 h-32 rounded-lg overflow-hidden bg-neutral-800 border border-neutral-700 hover:border-brand-500 transition-colors"
            >
              <img
                src={expense.receipt_image_url}
                alt="Receipt"
                className="w-full h-full object-cover"
              />
              <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                <Eye size={20} className="text-white" />
              </div>
            </button>
          )}
          {receiptItems && receiptItems.length > 0 && (
            <div className="flex-1 bg-neutral-800/50 rounded-lg p-3 text-sm space-y-1 max-h-32 overflow-y-auto">
              <p className="text-xs font-medium text-neutral-500 uppercase mb-1.5">{t('expenses.parsedItems')}</p>
              {receiptItems.map((item, i) => (
                <div key={i} className="flex justify-between text-neutral-300">
                  <span className="truncate mr-2">{item.description}</span>
                  <span className="shrink-0 text-white font-medium">{formatPrice(Number(item.amount))}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Extra details row */}
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-neutral-400">
        {expense.description && (
          <div className="flex items-center gap-1.5">
            <FileText size={13} />
            <span>{expense.description}</span>
          </div>
        )}
        {expense.notes && (
          <div className="flex items-center gap-1.5 italic">
            <span>"{expense.notes}"</span>
          </div>
        )}
        {expense.created_by_name && (
          <span>{t('expenses.addedBy', { name: expense.created_by_name })}</span>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={onEdit}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-neutral-800 text-white text-sm rounded-lg border border-neutral-700 hover:bg-neutral-700 transition-colors"
        >
          <Pencil size={13} />
          {t('common:buttons.edit')}
        </button>
        <button
          onClick={onDelete}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-neutral-800 text-red-400 text-sm rounded-lg border border-neutral-700 hover:bg-red-950/30 hover:border-red-800 transition-colors"
        >
          <Trash2 size={13} />
          {t('common:buttons.delete')}
        </button>
      </div>
    </div>
  );
};

/* ==================== Main Screen ==================== */

const ExpensesScreen: React.FC = () => {
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [loading, setLoading] = useState(true);
  const [dateFrom, setDateFrom] = useState(getMonthRange().from);
  const [dateTo, setDateTo] = useState(getMonthRange().to);

  // Modals
  const [showForm, setShowForm] = useState(false);
  const [showScan, setShowScan] = useState(false);
  const [editingExpense, setEditingExpense] = useState<Expense | null>(null);
  const [scanInitialData, setScanInitialData] = useState<Partial<Expense> | undefined>(undefined);
  const [pendingInventoryMatches, setPendingInventoryMatches] = useState<InventoryMatch[] | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);

  // Detail/receipt viewer
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [viewingReceipt, setViewingReceipt] = useState<string | null>(null);

  const { t } = useTranslation('admin');
  const getCategoryLabel = (cat: string) => t(`expenses.categories.${cat}`, cat);

  const fetchExpenses = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getExpenses({ from: dateFrom, to: dateTo });
      setExpenses(data);
    } catch (err) {
      console.error('Failed to fetch expenses:', err);
    } finally {
      setLoading(false);
    }
  }, [dateFrom, dateTo]);

  useEffect(() => {
    fetchExpenses();
  }, [fetchExpenses]);

  const handleSave = async (data: Partial<Expense>) => {
    setSaving(true);
    try {
      if (editingExpense) {
        await updateExpense(editingExpense.id, data);
      } else {
        await createExpense({ ...data, inventory_matches: pendingInventoryMatches });
      }
      setShowForm(false);
      setEditingExpense(null);
      setScanInitialData(undefined);
      setPendingInventoryMatches(undefined);
      fetchExpenses();
    } catch (err) {
      console.error('Failed to save expense:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm(t('expenses.deleteConfirm'))) return;
    try {
      await deleteExpense(id);
      setExpandedId(null);
      fetchExpenses();
    } catch (err) {
      console.error('Failed to delete expense:', err);
    }
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const blob = await exportExpenses({ from: dateFrom, to: dateTo });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `expenses-${dateFrom}-${dateTo}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Failed to export:', err);
    } finally {
      setExporting(false);
    }
  };

  const handleScanComplete = (data: Partial<Expense> & { receipt_image_url?: string; inventory_matches?: InventoryMatch[] }) => {
    setShowScan(false);
    const { inventory_matches, ...expenseData } = data;
    setScanInitialData(expenseData);
    setPendingInventoryMatches(inventory_matches);
    setEditingExpense(null);
    setShowForm(true);
  };

  // Summary calculations
  const totalExpenses = expenses.reduce((sum, e) => sum + Number(e.amount) + Number(e.tax_amount || 0), 0);
  const expenseCount = expenses.length;
  const categoryBreakdown = expenses.reduce<Record<string, number>>((acc, e) => {
    acc[e.category] = (acc[e.category] || 0) + Number(e.amount) + Number(e.tax_amount || 0);
    return acc;
  }, {});
  const receiptCount = expenses.filter(e => e.receipt_image_url).length;

  return (
    <div className="min-h-screen bg-neutral-950 text-white">
      {/* Header */}
      <div className="bg-neutral-900 border-b border-neutral-800 px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link to="/admin" className="p-2 text-neutral-400 hover:text-white transition-colors">
              <ArrowLeft size={24} />
            </Link>
            <div>
              <h1 className="text-2xl font-bold">{t('expenses.title')}</h1>
              <p className="text-sm text-neutral-500">{t('expenses.subtitle')}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowScan(true)}
              className="flex items-center gap-2 px-4 py-2 bg-neutral-800 text-white rounded-lg border border-neutral-700 hover:bg-neutral-700 transition-colors text-sm font-medium"
            >
              <Camera size={16} />
              <span className="hidden sm:inline">{t('expenses.scanReceipt')}</span>
            </button>
            <button
              onClick={() => {
                setEditingExpense(null);
                setScanInitialData(undefined);
                setPendingInventoryMatches(undefined);
                setShowForm(true);
              }}
              className="flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors text-sm font-medium"
            >
              <Plus size={16} />
              <span className="hidden sm:inline">{t('expenses.addExpense')}</span>
            </button>
          </div>
        </div>
      </div>

      <div className="p-6 space-y-6">
        {/* Date Range + Export */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <CalendarDays size={16} className="text-neutral-500" />
            <input
              type="date"
              value={dateFrom}
              onChange={e => setDateFrom(e.target.value)}
              className="bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-1.5 text-white text-sm focus:border-brand-500 focus:outline-none"
            />
            <span className="text-neutral-500">{t('expenses.to')}</span>
            <input
              type="date"
              value={dateTo}
              onChange={e => setDateTo(e.target.value)}
              className="bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-1.5 text-white text-sm focus:border-brand-500 focus:outline-none"
            />
          </div>
          <button
            onClick={handleExport}
            disabled={exporting || expenses.length === 0}
            className="flex items-center gap-2 px-3 py-1.5 bg-neutral-800 text-white rounded-lg border border-neutral-700 hover:bg-neutral-700 transition-colors text-sm disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {exporting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
            {t('expenses.exportCsv')}
          </button>
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-neutral-900 rounded-lg border border-neutral-800 p-4">
            <div className="flex items-center gap-2 mb-1">
              <DollarSign size={16} className="text-brand-500" />
              <span className="text-sm text-neutral-400">{t('expenses.total')}</span>
            </div>
            <p className="text-2xl font-bold">{formatPrice(totalExpenses)}</p>
            <p className="text-xs text-neutral-500 mt-1">{expenseCount} expense{expenseCount !== 1 ? 's' : ''}</p>
          </div>

          <div className="bg-neutral-900 rounded-lg border border-neutral-800 p-4">
            <div className="flex items-center gap-2 mb-1">
              <Image size={16} className="text-brand-500" />
              <span className="text-sm text-neutral-400">{t('expenses.receipts')}</span>
            </div>
            <p className="text-2xl font-bold">{receiptCount}</p>
            <p className="text-xs text-neutral-500 mt-1">{t('expenses.ofHavePhotos', { count: expenseCount })}</p>
          </div>

          {Object.entries(categoryBreakdown)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 2)
            .map(([cat, total]) => (
              <div key={cat} className="bg-neutral-900 rounded-lg border border-neutral-800 p-4">
                <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium mb-1 ${CATEGORY_COLORS[cat] || CATEGORY_COLORS.other}`}>
                  {getCategoryLabel(cat)}
                </span>
                <p className="text-2xl font-bold">{formatPrice(total)}</p>
                <p className="text-xs text-neutral-500 mt-1">
                  {t('expenses.percentOfTotal', { percent: totalExpenses > 0 ? Math.round((total / totalExpenses) * 100) : 0 })}
                </p>
              </div>
            ))}
        </div>

        {/* Expense List */}
        <div className="bg-neutral-900 rounded-lg border border-neutral-800 overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-neutral-400">
              <Loader2 size={24} className="animate-spin mr-2" />
              {t('expenses.loadingExpenses')}
            </div>
          ) : expenses.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-neutral-400">
              <Receipt size={48} className="mb-4 opacity-50" />
              <p className="text-lg font-medium mb-1">{t('expenses.noExpensesYet')}</p>
              <p className="text-sm mb-6">{t('expenses.noExpensesHint')}</p>
              <div className="flex gap-3">
                <button
                  onClick={() => setShowScan(true)}
                  className="flex items-center gap-2 px-4 py-2 bg-neutral-800 rounded-lg border border-neutral-700 hover:bg-neutral-700 transition-colors text-sm text-white"
                >
                  <Camera size={16} />
                  {t('expenses.scanReceipt')}
                </button>
                <button
                  onClick={() => { setEditingExpense(null); setScanInitialData(undefined); setPendingInventoryMatches(undefined); setShowForm(true); }}
                  className="flex items-center gap-2 px-4 py-2 bg-brand-600 rounded-lg hover:bg-brand-700 transition-colors text-sm text-white"
                >
                  <Plus size={16} />
                  {t('expenses.addExpense')}
                </button>
              </div>
            </div>
          ) : (
            <div className="divide-y divide-neutral-800/50">
              {expenses.map(expense => {
                const isExpanded = expandedId === expense.id;
                const total = Number(expense.amount) + Number(expense.tax_amount || 0);
                return (
                  <div key={expense.id}>
                    {/* Row — tap to expand */}
                    <button
                      onClick={() => setExpandedId(isExpanded ? null : expense.id)}
                      className="w-full flex items-center gap-3 px-4 py-3 hover:bg-neutral-800/30 transition-colors text-left"
                    >
                      {/* Receipt thumbnail or category icon */}
                      {expense.receipt_image_url ? (
                        <div className="w-10 h-10 rounded-lg overflow-hidden bg-neutral-800 shrink-0 border border-neutral-700">
                          <img
                            src={expense.receipt_image_url}
                            alt=""
                            className="w-full h-full object-cover"
                          />
                        </div>
                      ) : (
                        <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${CATEGORY_COLORS[expense.category]?.replace('text-', 'bg-').split(' ')[0] || 'bg-neutral-800'}`}>
                          <Receipt size={18} className={CATEGORY_COLORS[expense.category]?.split(' ')[1] || 'text-neutral-400'} />
                        </div>
                      )}

                      {/* Main info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-white truncate">
                            {expense.vendor || getCategoryLabel(expense.category)}
                            {expense.payee && <span className="text-neutral-400 font-normal"> — {expense.payee}</span>}
                          </span>
                          {expense.receipt_image_url && (
                            <Image size={12} className="text-brand-400 shrink-0" />
                          )}
                          {(expense.receipt_data as any)?.inventory_matches?.length > 0 && (
                            <Package size={12} className="text-green-400 shrink-0" />
                          )}
                        </div>
                        <div className="flex items-center gap-2 text-xs text-neutral-500">
                          <span>{formatDate(typeof expense.expense_date === 'string' ? expense.expense_date.slice(0, 10) : expense.expense_date)}</span>
                          <span className={`px-1.5 py-0.5 rounded-full ${CATEGORY_COLORS[expense.category] || CATEGORY_COLORS.other}`}>
                            {getCategoryLabel(expense.category)}
                          </span>
                          {expense.payment_method && (
                            <span className="capitalize">{expense.payment_method}</span>
                          )}
                        </div>
                      </div>

                      {/* Amount + expand */}
                      <div className="text-right shrink-0 flex items-center gap-2">
                        <div>
                          <p className="font-bold text-white">{formatPrice(total)}</p>
                          {Number(expense.tax_amount || 0) > 0 && (
                            <p className="text-xs text-neutral-500">tax {formatPrice(Number(expense.tax_amount))}</p>
                          )}
                        </div>
                        {isExpanded ? (
                          <ChevronUp size={16} className="text-neutral-500" />
                        ) : (
                          <ChevronDown size={16} className="text-neutral-500" />
                        )}
                      </div>
                    </button>

                    {/* Expanded detail */}
                    {isExpanded && (
                      <ExpenseDetail
                        expense={expense}
                        onEdit={() => {
                          setEditingExpense(expense);
                          setScanInitialData(undefined);
                          setShowForm(true);
                        }}
                        onDelete={() => handleDelete(expense.id)}
                        onViewReceipt={setViewingReceipt}
                        t={t}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Modals */}
      {showForm && (
        <ExpenseFormModal
          expense={editingExpense}
          initialData={scanInitialData}
          onSave={handleSave}
          onClose={() => {
            setShowForm(false);
            setEditingExpense(null);
            setScanInitialData(undefined);
            setPendingInventoryMatches(undefined);
          }}
          saving={saving}
        />
      )}

      {showScan && (
        <ReceiptScanModal
          onParsed={handleScanComplete}
          onClose={() => setShowScan(false)}
        />
      )}

      {viewingReceipt && (
        <ReceiptViewer
          url={viewingReceipt}
          onClose={() => setViewingReceipt(null)}
        />
      )}
    </div>
  );
};

export default ExpensesScreen;
