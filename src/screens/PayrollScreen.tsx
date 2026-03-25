import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import {
  ArrowLeft,
  Plus,
  Download,
  Pencil,
  Trash2,
  Settings,
  DollarSign,
  Users,
  Loader2,
  X,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import {
  getPayrollPayments,
  getPayrollSummary,
  getPayrollEmployees,
  createPayrollPayment,
  updatePayrollPayment,
  deletePayrollPayment,
  updateEmployeeWage,
  exportPayroll,
} from '../api';
import type { PayrollPayment, PayrollSummary, PayrollEmployeeWage } from '../types';
import { formatPrice } from '../utils/currency';

function getMonthRange() {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  const to = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);
  return { from, to };
}

function formatDate(d: string) {
  if (!d) return '';
  const date = new Date(d + 'T12:00:00');
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/* ==================== Payment Modal ==================== */

interface PaymentModalProps {
  payment: Partial<PayrollPayment> | null;
  employees: PayrollEmployeeWage[];
  onSave: (data: Partial<PayrollPayment>) => void;
  onClose: () => void;
  t: (key: string) => string;
}

const PaymentModal: React.FC<PaymentModalProps> = ({ payment, employees, onSave, onClose, t }) => {
  const isEdit = !!payment?.id;
  const [form, setForm] = useState<Record<string, string | number | null>>({
    employee_id: payment?.employee_id || '',
    pay_period_start: payment?.pay_period_start || '',
    pay_period_end: payment?.pay_period_end || '',
    hours_worked: payment?.hours_worked ?? '',
    gross_amount: payment?.gross_amount ?? '',
    deductions: payment?.deductions ?? 0,
    bonuses: payment?.bonuses ?? 0,
    net_amount: payment?.net_amount ?? '',
    payment_method: payment?.payment_method || 'cash',
    payment_date: payment?.payment_date || new Date().toISOString().slice(0, 10),
    notes: payment?.notes || '',
  });

  const selectedEmployee = employees.find(e => e.id === Number(form.employee_id));

  // Auto-calc gross for hourly employees
  useEffect(() => {
    if (selectedEmployee?.wage_type === 'hourly' && form.hours_worked && selectedEmployee.wage_rate > 0) {
      const gross = Number(form.hours_worked) * selectedEmployee.wage_rate;
      setForm(f => ({ ...f, gross_amount: Math.round(gross * 100) / 100 }));
    }
  }, [form.hours_worked, selectedEmployee]);

  // Auto-calc net
  useEffect(() => {
    const gross = Number(form.gross_amount) || 0;
    const ded = Number(form.deductions) || 0;
    const bon = Number(form.bonuses) || 0;
    setForm(f => ({ ...f, net_amount: Math.round((gross - ded + bon) * 100) / 100 }));
  }, [form.gross_amount, form.deductions, form.bonuses]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave({
      ...form,
      employee_id: Number(form.employee_id),
      hours_worked: form.hours_worked ? Number(form.hours_worked) : null,
      gross_amount: Number(form.gross_amount),
      deductions: Number(form.deductions),
      bonuses: Number(form.bonuses),
      net_amount: Number(form.net_amount),
    } as Partial<PayrollPayment>);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div className="bg-neutral-900 rounded-xl border border-neutral-700 w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b border-neutral-800">
          <h2 className="text-lg font-bold text-white">{isEdit ? t('payroll.editPayment') : t('payroll.addPayment')}</h2>
          <button onClick={onClose} className="p-1 hover:bg-neutral-800 rounded-lg"><X size={20} className="text-neutral-400" /></button>
        </div>
        <form onSubmit={handleSubmit} className="p-4 space-y-3">
          <div>
            <label className="block text-xs text-neutral-400 mb-1">{t('payroll.employee')}</label>
            <select
              value={form.employee_id}
              onChange={e => setForm(f => ({ ...f, employee_id: e.target.value }))}
              required
              className="w-full px-3 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-white text-sm"
            >
              <option value="">{t('payroll.selectEmployee')}</option>
              {employees.map(e => (
                <option key={e.id} value={e.id}>{e.name} ({e.role})</option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-neutral-400 mb-1">{t('payroll.periodStart')}</label>
              <input type="date" value={form.pay_period_start} onChange={e => setForm(f => ({ ...f, pay_period_start: e.target.value }))} required className="w-full px-3 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-white text-sm" />
            </div>
            <div>
              <label className="block text-xs text-neutral-400 mb-1">{t('payroll.periodEnd')}</label>
              <input type="date" value={form.pay_period_end} onChange={e => setForm(f => ({ ...f, pay_period_end: e.target.value }))} required className="w-full px-3 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-white text-sm" />
            </div>
          </div>

          <div>
            <label className="block text-xs text-neutral-400 mb-1">{t('payroll.hoursWorked')}</label>
            <input type="number" step="0.5" min="0" value={form.hours_worked} onChange={e => setForm(f => ({ ...f, hours_worked: e.target.value }))} className="w-full px-3 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-white text-sm" placeholder="0" />
            {selectedEmployee?.wage_type === 'hourly' && selectedEmployee.wage_rate > 0 && (
              <p className="text-xs text-neutral-500 mt-1">{t('payroll.autoCalcHint')} ({formatPrice(selectedEmployee.wage_rate)}/hr)</p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-neutral-400 mb-1">{t('payroll.grossAmount')}</label>
              <input type="number" step="0.01" min="0" value={form.gross_amount} onChange={e => setForm(f => ({ ...f, gross_amount: e.target.value }))} required className="w-full px-3 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-white text-sm" />
            </div>
            <div>
              <label className="block text-xs text-neutral-400 mb-1">{t('payroll.deductions')}</label>
              <input type="number" step="0.01" min="0" value={form.deductions} onChange={e => setForm(f => ({ ...f, deductions: e.target.value }))} className="w-full px-3 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-white text-sm" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-neutral-400 mb-1">{t('payroll.bonuses')}</label>
              <input type="number" step="0.01" min="0" value={form.bonuses} onChange={e => setForm(f => ({ ...f, bonuses: e.target.value }))} className="w-full px-3 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-white text-sm" />
            </div>
            <div>
              <label className="block text-xs text-neutral-400 mb-1">{t('payroll.netAmount')}</label>
              <input type="number" step="0.01" value={form.net_amount} readOnly className="w-full px-3 py-2 bg-neutral-800/50 border border-neutral-700 rounded-lg text-neutral-300 text-sm" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-neutral-400 mb-1">{t('payroll.paymentMethod')}</label>
              <select value={form.payment_method} onChange={e => setForm(f => ({ ...f, payment_method: e.target.value }))} className="w-full px-3 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-white text-sm">
                <option value="cash">{t('payroll.paymentMethods.cash')}</option>
                <option value="transfer">{t('payroll.paymentMethods.transfer')}</option>
                <option value="check">{t('payroll.paymentMethods.check')}</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-neutral-400 mb-1">{t('payroll.paymentDate')}</label>
              <input type="date" value={form.payment_date} onChange={e => setForm(f => ({ ...f, payment_date: e.target.value }))} required className="w-full px-3 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-white text-sm" />
            </div>
          </div>

          <div>
            <label className="block text-xs text-neutral-400 mb-1">{t('payroll.notes')}</label>
            <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={2} placeholder={t('payroll.notesPlaceholder')} className="w-full px-3 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-white text-sm resize-none" />
          </div>

          <button type="submit" className="w-full py-2.5 bg-brand-600 hover:bg-brand-500 text-white rounded-lg font-medium transition-colors">
            {isEdit ? t('payroll.editPayment') : t('payroll.addPayment')}
          </button>
        </form>
      </div>
    </div>
  );
};

/* ==================== Wage Config Modal ==================== */

interface WageConfigModalProps {
  employees: PayrollEmployeeWage[];
  onSave: (id: number, data: Partial<PayrollEmployeeWage>) => Promise<void>;
  onClose: () => void;
  t: (key: string) => string;
}

const WageConfigModal: React.FC<WageConfigModalProps> = ({ employees, onSave, onClose, t }) => {
  const [edits, setEdits] = useState<Record<number, Partial<PayrollEmployeeWage>>>({});
  const [saving, setSaving] = useState(false);

  const getVal = (emp: PayrollEmployeeWage, field: keyof PayrollEmployeeWage) => {
    return edits[emp.id]?.[field] ?? emp[field];
  };

  const setVal = (id: number, field: string, value: string | number | null) => {
    setEdits(prev => ({ ...prev, [id]: { ...prev[id], [field]: value } }));
  };

  const handleSaveAll = async () => {
    setSaving(true);
    try {
      for (const [id, data] of Object.entries(edits)) {
        if (Object.keys(data).length > 0) {
          await onSave(Number(id), data);
        }
      }
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div className="bg-neutral-900 rounded-xl border border-neutral-700 w-full max-w-2xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b border-neutral-800">
          <h2 className="text-lg font-bold text-white">{t('payroll.wageConfig')}</h2>
          <button onClick={onClose} className="p-1 hover:bg-neutral-800 rounded-lg"><X size={20} className="text-neutral-400" /></button>
        </div>
        <div className="p-4 space-y-3">
          {employees.map(emp => (
            <div key={emp.id} className="bg-neutral-800 rounded-lg p-3 space-y-2">
              <div className="text-white font-medium text-sm">{emp.name} <span className="text-neutral-500 text-xs">({emp.role})</span></div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <div>
                  <label className="block text-xs text-neutral-500 mb-0.5">{t('payroll.wageType')}</label>
                  <select
                    value={getVal(emp, 'wage_type') as string}
                    onChange={e => setVal(emp.id, 'wage_type', e.target.value)}
                    className="w-full px-2 py-1.5 bg-neutral-700 border border-neutral-600 rounded text-white text-xs"
                  >
                    <option value="hourly">{t('payroll.wageTypes.hourly')}</option>
                    <option value="salary">{t('payroll.wageTypes.salary')}</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-neutral-500 mb-0.5">{t('payroll.wageRate')}</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={getVal(emp, 'wage_rate') as number}
                    onChange={e => setVal(emp.id, 'wage_rate', Number(e.target.value))}
                    className="w-full px-2 py-1.5 bg-neutral-700 border border-neutral-600 rounded text-white text-xs"
                  />
                </div>
                <div>
                  <label className="block text-xs text-neutral-500 mb-0.5">{t('payroll.payFrequency')}</label>
                  <select
                    value={getVal(emp, 'pay_frequency') as string}
                    onChange={e => setVal(emp.id, 'pay_frequency', e.target.value)}
                    className="w-full px-2 py-1.5 bg-neutral-700 border border-neutral-600 rounded text-white text-xs"
                  >
                    <option value="weekly">{t('payroll.payFrequencies.weekly')}</option>
                    <option value="biweekly">{t('payroll.payFrequencies.biweekly')}</option>
                    <option value="monthly">{t('payroll.payFrequencies.monthly')}</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-neutral-500 mb-0.5">{t('payroll.hireDate')}</label>
                  <input
                    type="date"
                    value={(getVal(emp, 'hire_date') as string) || ''}
                    onChange={e => setVal(emp.id, 'hire_date', e.target.value || null)}
                    className="w-full px-2 py-1.5 bg-neutral-700 border border-neutral-600 rounded text-white text-xs"
                  />
                </div>
              </div>
            </div>
          ))}
          <button
            onClick={handleSaveAll}
            disabled={saving || Object.keys(edits).length === 0}
            className="w-full py-2.5 bg-brand-600 hover:bg-brand-500 disabled:opacity-50 text-white rounded-lg font-medium transition-colors flex items-center justify-center gap-2"
          >
            {saving && <Loader2 size={16} className="animate-spin" />}
            {t('payroll.wageConfig')}
          </button>
        </div>
      </div>
    </div>
  );
};

/* ==================== Main Screen ==================== */

export default function PayrollScreen() {
  const { t } = useTranslation('admin');
  const [payments, setPayments] = useState<PayrollPayment[]>([]);
  const [summary, setSummary] = useState<PayrollSummary | null>(null);
  const [employees, setEmployees] = useState<PayrollEmployeeWage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [dateRange, setDateRange] = useState(getMonthRange);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [editingPayment, setEditingPayment] = useState<Partial<PayrollPayment> | null>(null);
  const [showWageModal, setShowWageModal] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [paymentsData, summaryData, employeesData] = await Promise.all([
        getPayrollPayments({ from: dateRange.from, to: dateRange.to }),
        getPayrollSummary({ from: dateRange.from, to: dateRange.to }),
        getPayrollEmployees(),
      ]);
      setPayments(paymentsData);
      setSummary(summaryData);
      setEmployees(employeesData);
    } catch (err: any) {
      setError(err.message || t('payroll.failedFetch'));
    } finally {
      setLoading(false);
    }
  }, [dateRange, t]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleSavePayment = async (data: Partial<PayrollPayment>) => {
    try {
      if (editingPayment?.id) {
        await updatePayrollPayment(editingPayment.id, data);
      } else {
        await createPayrollPayment(data);
      }
      setShowPaymentModal(false);
      setEditingPayment(null);
      fetchData();
    } catch (err: any) {
      setError(err.message || t('payroll.failedCreate'));
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm(t('payroll.deleteConfirm'))) return;
    try {
      await deletePayrollPayment(id);
      fetchData();
    } catch (err: any) {
      setError(err.message || t('payroll.failedDelete'));
    }
  };

  const handleWageSave = async (id: number, data: Partial<PayrollEmployeeWage>) => {
    await updateEmployeeWage(id, data);
  };

  const handleExport = async () => {
    try {
      const blob = await exportPayroll({ from: dateRange.from, to: dateRange.to });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `payroll-${dateRange.from}-${dateRange.to}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setError('Export failed');
    }
  };

  const summaryCards = [
    { label: t('payroll.totalGross'), value: formatPrice(summary?.total_gross || 0), icon: <DollarSign size={18} />, color: 'text-green-400' },
    { label: t('payroll.totalDeductions'), value: formatPrice(summary?.total_deductions || 0), icon: <DollarSign size={18} />, color: 'text-red-400' },
    { label: t('payroll.totalNet'), value: formatPrice(summary?.total_net || 0), icon: <DollarSign size={18} />, color: 'text-brand-400' },
    { label: t('payroll.employeesPaid'), value: String(summary?.employees_paid || 0), icon: <Users size={18} />, color: 'text-blue-400' },
  ];

  return (
    <div className="min-h-screen bg-neutral-950">
      {/* Header */}
      <div className="bg-neutral-900 text-white p-4 sm:p-6 border-b border-neutral-800">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <Link to="/admin" className="p-2 hover:bg-neutral-800 rounded-lg transition-colors">
              <ArrowLeft size={20} />
            </Link>
            <div>
              <h1 className="text-xl sm:text-2xl font-black tracking-tight">{t('payroll.title')}</h1>
              <p className="text-neutral-400 text-xs sm:text-sm">{t('payroll.subtitle')}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button onClick={() => setShowWageModal(true)} className="flex items-center gap-1.5 px-3 py-2 bg-neutral-800 hover:bg-neutral-700 rounded-lg text-sm transition-colors">
              <Settings size={16} /> {t('payroll.configureWages')}
            </button>
            <button onClick={() => { setEditingPayment(null); setShowPaymentModal(true); }} className="flex items-center gap-1.5 px-3 py-2 bg-brand-600 hover:bg-brand-500 rounded-lg text-sm font-medium transition-colors">
              <Plus size={16} /> {t('payroll.addPayment')}
            </button>
            <button onClick={handleExport} className="flex items-center gap-1.5 px-3 py-2 bg-neutral-800 hover:bg-neutral-700 rounded-lg text-sm transition-colors">
              <Download size={16} /> {t('payroll.exportCsv')}
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto p-4 sm:p-6 space-y-5">
        {error && (
          <div className="bg-red-500/10 border border-red-500/30 text-red-400 px-4 py-2 rounded-lg text-sm">{error}</div>
        )}

        {/* Summary Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {summaryCards.map(card => (
            <div key={card.label} className="bg-neutral-900 border border-neutral-800 rounded-xl p-4">
              <div className={`${card.color} mb-1`}>{card.icon}</div>
              <div className="text-white text-lg sm:text-xl font-bold">{card.value}</div>
              <div className="text-neutral-500 text-xs">{card.label}</div>
            </div>
          ))}
        </div>

        {/* Date Filters */}
        <div className="flex items-center gap-3 flex-wrap">
          <input
            type="date"
            value={dateRange.from}
            onChange={e => setDateRange(r => ({ ...r, from: e.target.value }))}
            className="px-3 py-2 bg-neutral-900 border border-neutral-700 rounded-lg text-white text-sm"
          />
          <span className="text-neutral-500 text-sm">{t('payroll.to')}</span>
          <input
            type="date"
            value={dateRange.to}
            onChange={e => setDateRange(r => ({ ...r, to: e.target.value }))}
            className="px-3 py-2 bg-neutral-900 border border-neutral-700 rounded-lg text-white text-sm"
          />
        </div>

        {/* Payments Table */}
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 size={28} className="animate-spin text-brand-500" />
          </div>
        ) : payments.length === 0 ? (
          <div className="text-center py-16">
            <DollarSign size={40} className="mx-auto text-neutral-700 mb-3" />
            <p className="text-neutral-400 font-medium">{t('payroll.noPayments')}</p>
            <p className="text-neutral-600 text-sm mt-1">{t('payroll.noPaymentsHint')}</p>
          </div>
        ) : (
          <div className="space-y-2">
            {/* Table header - desktop */}
            <div className="hidden sm:grid grid-cols-[1.5fr_1fr_0.7fr_0.8fr_0.8fr_0.8fr_0.6fr_auto] gap-3 px-4 text-xs text-neutral-500 uppercase tracking-wider">
              <div>{t('payroll.employee')}</div>
              <div>{t('payroll.period')}</div>
              <div>{t('payroll.hours')}</div>
              <div>{t('payroll.gross')}</div>
              <div>{t('payroll.deductions')}</div>
              <div>{t('payroll.net')}</div>
              <div>{t('payroll.method')}</div>
              <div></div>
            </div>

            {payments.map(p => (
              <div key={p.id} className="bg-neutral-900 border border-neutral-800 rounded-lg overflow-hidden">
                <div
                  className="flex sm:grid sm:grid-cols-[1.5fr_1fr_0.7fr_0.8fr_0.8fr_0.8fr_0.6fr_auto] gap-3 px-4 py-3 items-center cursor-pointer hover:bg-neutral-800/50 transition-colors"
                  onClick={() => setExpandedId(expandedId === p.id ? null : p.id)}
                >
                  <div className="flex-1 sm:flex-none">
                    <div className="text-white text-sm font-medium">{p.employee_name || `#${p.employee_id}`}</div>
                    <div className="text-neutral-500 text-xs sm:hidden">
                      {formatDate(p.pay_period_start)} - {formatDate(p.pay_period_end)}
                    </div>
                  </div>
                  <div className="hidden sm:block text-neutral-300 text-sm">{formatDate(p.pay_period_start)} - {formatDate(p.pay_period_end)}</div>
                  <div className="hidden sm:block text-neutral-300 text-sm">{p.hours_worked ?? '-'}</div>
                  <div className="hidden sm:block text-neutral-300 text-sm">{formatPrice(p.gross_amount)}</div>
                  <div className="hidden sm:block text-red-400 text-sm">{p.deductions > 0 ? `-${formatPrice(p.deductions)}` : '-'}</div>
                  <div className="text-white text-sm font-medium">{formatPrice(p.net_amount)}</div>
                  <div className="hidden sm:block text-neutral-400 text-xs capitalize">{t(`payroll.paymentMethods.${p.payment_method}`)}</div>
                  <div className="flex items-center gap-1">
                    {expandedId === p.id ? <ChevronUp size={16} className="text-neutral-500" /> : <ChevronDown size={16} className="text-neutral-500" />}
                  </div>
                </div>

                {expandedId === p.id && (
                  <div className="px-4 pb-3 border-t border-neutral-800 pt-3 space-y-2">
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                      <div>
                        <span className="text-neutral-500">{t('payroll.paymentDate')}:</span>
                        <span className="text-neutral-300 ml-1">{formatDate(p.payment_date)}</span>
                      </div>
                      <div>
                        <span className="text-neutral-500">{t('payroll.bonuses')}:</span>
                        <span className="text-green-400 ml-1">{p.bonuses > 0 ? `+${formatPrice(p.bonuses)}` : '-'}</span>
                      </div>
                      <div>
                        <span className="text-neutral-500">{t('payroll.gross')}:</span>
                        <span className="text-neutral-300 ml-1">{formatPrice(p.gross_amount)}</span>
                      </div>
                      {p.notes && (
                        <div className="col-span-2 sm:col-span-1">
                          <span className="text-neutral-500">{t('payroll.notes')}:</span>
                          <span className="text-neutral-300 ml-1">{p.notes}</span>
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-2 pt-1">
                      <button
                        onClick={(e) => { e.stopPropagation(); setEditingPayment(p); setShowPaymentModal(true); }}
                        className="flex items-center gap-1 px-2.5 py-1.5 bg-neutral-800 hover:bg-neutral-700 rounded-lg text-xs text-neutral-300 transition-colors"
                      >
                        <Pencil size={12} /> {t('payroll.editPayment')}
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDelete(p.id); }}
                        className="flex items-center gap-1 px-2.5 py-1.5 bg-red-500/10 hover:bg-red-500/20 rounded-lg text-xs text-red-400 transition-colors"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Modals */}
      {showPaymentModal && (
        <PaymentModal
          payment={editingPayment}
          employees={employees}
          onSave={handleSavePayment}
          onClose={() => { setShowPaymentModal(false); setEditingPayment(null); }}
          t={t}
        />
      )}

      {showWageModal && (
        <WageConfigModal
          employees={employees}
          onSave={handleWageSave}
          onClose={() => { setShowWageModal(false); fetchData(); }}
          t={t}
        />
      )}
    </div>
  );
}
