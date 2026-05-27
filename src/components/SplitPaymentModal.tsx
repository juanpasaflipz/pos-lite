import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatPrice } from '../utils/currency';
import { CartItem } from '../types';
import {
  SplitRow,
  splitChargeCard,
  splitCancelCard,
  splitRecordCash,
  getSplitStatus,
  splitFinalize,
} from '../api';

interface SplitPaymentModalProps {
  orderTotal: number;
  items: CartItem[];
  isMpConnected: boolean;
  onStart: (
    splits: Array<{ payment_method: 'card' | 'cash'; amount: number; tip: number }>,
  ) => Promise<{ orderId: number; splits: SplitRow[] }>;
  onComplete: (orderId: number, totalTip: number) => void;
  onClose: () => void;
}

type SplitMode = 'even' | 'by_item' | 'custom';
type Phase = 'setup' | 'collecting' | 'finalizing';

interface DraftSplit {
  amount: number;
  method: 'card' | 'cash';
  tip: number;
}

export default function SplitPaymentModal({
  orderTotal,
  items,
  isMpConnected,
  onStart,
  onComplete,
  onClose,
}: SplitPaymentModalProps) {
  const { t } = useTranslation('pos');

  // Setup phase state ----
  const [phase, setPhase] = useState<Phase>('setup');
  const [mode, setMode] = useState<SplitMode | null>(null);
  const [numPeople, setNumPeople] = useState(2);
  const [drafts, setDrafts] = useState<DraftSplit[]>([]);
  const [itemAssignments, setItemAssignments] = useState<Record<string, number>>({});

  // Collection phase state ----
  const [orderId, setOrderId] = useState<number | null>(null);
  const [splitRows, setSplitRows] = useState<SplitRow[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [startError, setStartError] = useState('');
  const [isStarting, setIsStarting] = useState(false);

  // Card split state ----
  const [terminalSent, setTerminalSent] = useState(false);
  const [terminalError, setTerminalError] = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Cash split state ----
  const [cashReceived, setCashReceived] = useState('');
  const [cashError, setCashError] = useState('');
  const [isRecordingCash, setIsRecordingCash] = useState(false);

  // Finalize state ----
  const [isFinalizing, setIsFinalizing] = useState(false);
  const [finalizeError, setFinalizeError] = useState('');

  // Cancel state ----
  const [showAbandonConfirm, setShowAbandonConfirm] = useState(false);

  // ---------- Setup helpers ----------

  const initEvenSplits = (count: number) => {
    const per = Math.floor((orderTotal / count) * 100) / 100;
    const remainder = Math.round((orderTotal - per * count) * 100) / 100;
    const next: DraftSplit[] = Array.from({ length: count }, (_, i) => ({
      amount: i === 0 ? per + remainder : per,
      method: 'card',
      tip: 0,
    }));
    setDrafts(next);
  };

  const handleSelectMode = (selected: SplitMode) => {
    setMode(selected);
    if (selected === 'even') {
      initEvenSplits(numPeople);
    } else {
      setDrafts([
        { amount: 0, method: 'card', tip: 0 },
        { amount: 0, method: 'card', tip: 0 },
      ]);
      setItemAssignments({});
    }
  };

  const updateDraftMethod = (idx: number, method: 'card' | 'cash') => {
    setDrafts((prev) => prev.map((s, i) => (i === idx ? { ...s, method } : s)));
  };

  const updateCustomAmount = (idx: number, amount: number) => {
    setDrafts((prev) => prev.map((s, i) => (i === idx ? { ...s, amount } : s)));
  };

  const assignItemToSplit = (cartId: string, splitIndex: number) => {
    const nextAssignments = { ...itemAssignments, [cartId]: splitIndex };
    setItemAssignments(nextAssignments);
    const newAmounts = drafts.map(() => 0);
    items.forEach((item) => {
      const idx = nextAssignments[item.cart_id] ?? 0;
      newAmounts[idx] = (newAmounts[idx] || 0) + item.unit_price * item.quantity;
    });
    setDrafts((prev) => prev.map((s, i) => ({ ...s, amount: Math.round(newAmounts[i] * 100) / 100 })));
  };

  // Resize the by_item people list. Items assigned to a removed person fall
  // back to Person 1 so no item is left orphaned.
  const setByItemPeople = (count: number) => {
    const clamped = Math.max(2, Math.min(10, count));
    if (clamped === drafts.length) return;
    let nextAssignments = itemAssignments;
    if (clamped < drafts.length) {
      nextAssignments = Object.fromEntries(
        Object.entries(itemAssignments).map(([k, v]) => [k, v >= clamped ? 0 : v]),
      );
      setItemAssignments(nextAssignments);
    }
    const sums = Array.from({ length: clamped }, () => 0);
    items.forEach((item) => {
      const idx = nextAssignments[item.cart_id] ?? 0;
      sums[idx] += item.unit_price * item.quantity;
    });
    setDrafts((prev) => {
      const base: DraftSplit[] = Array.from({ length: clamped }, (_, i) => ({
        amount: Math.round(sums[i] * 100) / 100,
        method: prev[i]?.method ?? 'card',
        tip: prev[i]?.tip ?? 0,
      }));
      return base;
    });
  };

  const totalAssigned = drafts.reduce((sum, s) => sum + s.amount, 0);
  const isBalanced = Math.abs(totalAssigned - orderTotal) < 0.02;
  const hasCardSplits = drafts.some((d) => d.method === 'card');
  const cardSplitsBlocked = hasCardSplits && !isMpConnected;

  // ---------- Phase transition: start collection ----------

  const handleStart = async () => {
    setStartError('');
    if (drafts.length === 0) return;
    if (!isBalanced && mode !== 'even') return;
    if (cardSplitsBlocked) {
      setStartError(t('splitPayment.errors.mpNotConnected'));
      return;
    }
    setIsStarting(true);
    try {
      const payload = drafts.map((d) => ({ payment_method: d.method, amount: d.amount, tip: d.tip }));
      const result = await onStart(payload);
      setOrderId(result.orderId);
      setSplitRows(result.splits);
      setActiveIndex(0);
      setPhase('collecting');
    } catch (err) {
      setStartError(err instanceof Error ? err.message : 'Failed to start split payment');
    } finally {
      setIsStarting(false);
    }
  };

  // ---------- Collection: card terminal ----------

  const activeSplit = phase === 'collecting' ? splitRows[activeIndex] : null;
  const requiredForActive = activeSplit
    ? Number(activeSplit.amount) + (Number(activeSplit.tip) || 0)
    : 0;

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  useEffect(() => () => stopPolling(), []);

  // Reset per-split state whenever the active split changes
  useEffect(() => {
    stopPolling();
    setTerminalSent(false);
    setTerminalError('');
    setCashReceived('');
    setCashError('');
  }, [activeIndex, phase]);

  const startTerminalPolling = (oid: number, splitId: number) => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const status = await getSplitStatus(oid);
        const updated = status.splits.find((s) => s.id === splitId);
        if (!updated) return;
        setSplitRows(status.splits);
        if (updated.status === 'paid') {
          stopPolling();
          setTerminalSent(false);
          advanceOrFinalize(status.splits);
        } else if (updated.status === 'failed') {
          stopPolling();
          setTerminalSent(false);
          setTerminalError(t('splitPayment.errors.terminalDeclined'));
        }
      } catch {
        // Keep polling on network blips
      }
    }, 2000);
  };

  const sendToTerminal = async () => {
    if (!activeSplit || !orderId) return;
    setTerminalError('');
    setTerminalSent(true);
    try {
      await splitChargeCard(activeSplit.id);
      startTerminalPolling(orderId, activeSplit.id);
    } catch (err) {
      setTerminalSent(false);
      setTerminalError(err instanceof Error ? err.message : t('splitPayment.errors.terminalSendFailed'));
    }
  };

  const cancelTerminal = async () => {
    if (!activeSplit) return;
    stopPolling();
    try {
      await splitCancelCard(activeSplit.id);
    } catch {
      // Best effort
    }
    setTerminalSent(false);
    setTerminalError('');
    // Reload state from server
    if (orderId) {
      try {
        const status = await getSplitStatus(orderId);
        setSplitRows(status.splits);
      } catch {}
    }
  };

  // ---------- Collection: cash ----------

  const cashReceivedNum = parseFloat(cashReceived) || 0;
  const cashChangeDue = Math.max(0, Math.round((cashReceivedNum - requiredForActive) * 100) / 100);
  const cashShortBy = Math.max(0, Math.round((requiredForActive - cashReceivedNum) * 100) / 100);

  const recordCash = async () => {
    if (!activeSplit) return;
    if (cashReceivedNum + 0.005 < requiredForActive) {
      setCashError(t('splitPayment.errors.cashShort', { short: formatPrice(cashShortBy) }));
      return;
    }
    setCashError('');
    setIsRecordingCash(true);
    try {
      await splitRecordCash(activeSplit.id, cashReceivedNum);
      // Update local state
      const nextRows = splitRows.map((s) => (s.id === activeSplit.id ? { ...s, status: 'paid' as const } : s));
      setSplitRows(nextRows);
      advanceOrFinalize(nextRows);
    } catch (err) {
      setCashError(err instanceof Error ? err.message : t('splitPayment.errors.cashRecordFailed'));
    } finally {
      setIsRecordingCash(false);
    }
  };

  // ---------- Advance ----------

  const advanceOrFinalize = (rows: SplitRow[]) => {
    const nextUnpaidIdx = rows.findIndex((s) => s.status !== 'paid');
    if (nextUnpaidIdx === -1) {
      finalize(rows);
    } else {
      setActiveIndex(nextUnpaidIdx);
    }
  };

  const finalize = async (rows: SplitRow[]) => {
    if (!orderId) return;
    setPhase('finalizing');
    setFinalizeError('');
    setIsFinalizing(true);
    try {
      const result = await splitFinalize(orderId);
      onComplete(orderId, result.tip);
    } catch (err) {
      setFinalizeError(err instanceof Error ? err.message : t('splitPayment.errors.finalizeFailed'));
      // Drop back to collection so user can retry
      setPhase('collecting');
      setSplitRows(rows);
    } finally {
      setIsFinalizing(false);
    }
  };

  // ---------- Abandon mid-flow ----------

  const paidSplitsCount = splitRows.filter((s) => s.status === 'paid').length;

  const handleAbandon = async () => {
    stopPolling();
    if (activeSplit && activeSplit.status === 'pending_terminal') {
      try {
        await splitCancelCard(activeSplit.id);
      } catch {
        // Best effort
      }
    }
    onClose();
  };

  const handleCloseAttempt = () => {
    if (phase === 'setup') {
      onClose();
      return;
    }
    if (paidSplitsCount === 0 && (!activeSplit || activeSplit.status !== 'pending_terminal')) {
      handleAbandon();
      return;
    }
    setShowAbandonConfirm(true);
  };

  // ---------- Render ----------

  const renderSetup = () => {
    if (!mode) {
      return (
        <div className="space-y-3">
          <p className="text-white font-semibold mb-4">{t('splitPayment.howToSplit')}</p>
          <button
            onClick={() => handleSelectMode('even')}
            className="w-full p-4 bg-neutral-800 border border-neutral-700 rounded-lg hover:border-brand-600 transition-all text-left"
          >
            <h3 className="text-lg font-bold text-white">{t('splitPayment.splitEvenly')}</h3>
            <p className="text-sm text-neutral-400">{t('splitPayment.splitEvenlyDesc')}</p>
          </button>
          <button
            onClick={() => handleSelectMode('by_item')}
            className="w-full p-4 bg-neutral-800 border border-neutral-700 rounded-lg hover:border-brand-600 transition-all text-left"
          >
            <h3 className="text-lg font-bold text-white">{t('splitPayment.splitByItem')}</h3>
            <p className="text-sm text-neutral-400">{t('splitPayment.splitByItemDesc')}</p>
          </button>
          <button
            onClick={() => handleSelectMode('custom')}
            className="w-full p-4 bg-neutral-800 border border-neutral-700 rounded-lg hover:border-brand-600 transition-all text-left"
          >
            <h3 className="text-lg font-bold text-white">{t('splitPayment.customAmount')}</h3>
            <p className="text-sm text-neutral-400">{t('splitPayment.customAmountDesc')}</p>
          </button>
        </div>
      );
    }
    if (mode === 'even') {
      return (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <p className="text-white font-semibold">{t('splitPayment.numberOfPeople')}</p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  const n = Math.max(2, numPeople - 1);
                  setNumPeople(n);
                  initEvenSplits(n);
                }}
                className="w-10 h-10 bg-neutral-700 text-white font-bold rounded-lg"
              >
                −
              </button>
              <span className="w-10 text-center font-bold text-white text-xl">{numPeople}</span>
              <button
                onClick={() => {
                  const n = Math.min(10, numPeople + 1);
                  setNumPeople(n);
                  initEvenSplits(n);
                }}
                className="w-10 h-10 bg-neutral-700 text-white font-bold rounded-lg"
              >
                +
              </button>
            </div>
          </div>
          {drafts.map((split, i) => (
            <div key={i} className="bg-neutral-800 rounded-lg p-3 border border-neutral-700">
              <div className="flex items-center justify-between mb-2">
                <p className="font-bold text-white">{t('splitPayment.person', { number: i + 1 })}</p>
                <p className="font-bold text-brand-500">{formatPrice(split.amount)}</p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => updateDraftMethod(i, 'card')}
                  className={`flex-1 py-2 rounded-lg text-sm font-bold ${split.method === 'card' ? 'bg-brand-600 text-white' : 'bg-neutral-700 text-neutral-400'}`}
                >
                  {t('splitPayment.card')}
                </button>
                <button
                  onClick={() => updateDraftMethod(i, 'cash')}
                  className={`flex-1 py-2 rounded-lg text-sm font-bold ${split.method === 'cash' ? 'bg-cockpit-green text-white' : 'bg-neutral-700 text-neutral-400'}`}
                >
                  {t('splitPayment.cash')}
                </button>
              </div>
            </div>
          ))}
        </div>
      );
    }
    if (mode === 'custom') {
      return (
        <div className="space-y-4">
          <div className="flex items-center justify-between mb-2">
            <p className="text-white font-semibold">{t('splitPayment.customSplits')}</p>
            <button
              onClick={() => setDrafts((prev) => [...prev, { amount: 0, method: 'card', tip: 0 }])}
              className="text-sm text-brand-400 font-bold"
            >
              {t('splitPayment.addSplit')}
            </button>
          </div>
          {drafts.map((split, i) => (
            <div key={i} className="bg-neutral-800 rounded-lg p-3 border border-neutral-700 space-y-2">
              <div className="flex items-center justify-between">
                <p className="font-bold text-white">{t('splitPayment.split', { number: i + 1 })}</p>
                {drafts.length > 2 && (
                  <button
                    onClick={() => setDrafts((prev) => prev.filter((_, idx) => idx !== i))}
                    className="text-brand-500 text-sm font-bold"
                  >
                    {t('splitPayment.remove')}
                  </button>
                )}
              </div>
              <input
                type="number"
                value={split.amount || ''}
                onChange={(e) => updateCustomAmount(i, parseFloat(e.target.value) || 0)}
                placeholder={t('splitPayment.amountPlaceholder')}
                className="w-full bg-neutral-700 border border-neutral-600 rounded-lg p-2 text-white text-center font-bold focus:outline-none focus:border-brand-600"
              />
              <div className="flex gap-2">
                <button
                  onClick={() => updateDraftMethod(i, 'card')}
                  className={`flex-1 py-2 rounded-lg text-sm font-bold ${split.method === 'card' ? 'bg-brand-600 text-white' : 'bg-neutral-700 text-neutral-400'}`}
                >
                  {t('splitPayment.card')}
                </button>
                <button
                  onClick={() => updateDraftMethod(i, 'cash')}
                  className={`flex-1 py-2 rounded-lg text-sm font-bold ${split.method === 'cash' ? 'bg-cockpit-green text-white' : 'bg-neutral-700 text-neutral-400'}`}
                >
                  {t('splitPayment.cash')}
                </button>
              </div>
            </div>
          ))}
          <div className="bg-neutral-800 p-3 rounded-lg text-center">
            <p className={`font-bold ${isBalanced ? 'text-cockpit-in-text' : 'text-brand-400'}`}>
              {t('splitPayment.assigned', { assigned: formatPrice(totalAssigned), total: formatPrice(orderTotal) })}
              {!isBalanced && ` (${formatPrice(Math.abs(orderTotal - totalAssigned))} ${totalAssigned > orderTotal ? t('splitPayment.over') : t('splitPayment.remaining')})`}
            </p>
          </div>
        </div>
      );
    }
    // by_item
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <p className="text-white font-semibold">{t('splitPayment.assignItems')}</p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setByItemPeople(drafts.length - 1)}
              disabled={drafts.length <= 2}
              className="w-10 h-10 bg-neutral-700 text-white font-bold rounded-lg disabled:opacity-40"
              aria-label={t('splitPayment.remove')}
            >
              −
            </button>
            <span className="min-w-[2.5rem] text-center font-bold text-white text-xl tabular-nums">
              {drafts.length}
            </span>
            <button
              onClick={() => setByItemPeople(drafts.length + 1)}
              disabled={drafts.length >= 10}
              className="w-10 h-10 bg-neutral-700 text-white font-bold rounded-lg disabled:opacity-40"
              aria-label={t('splitPayment.addSplit')}
            >
              +
            </button>
          </div>
        </div>
        {items.map((item) => (
          <div key={item.cart_id} className="bg-neutral-800 rounded-lg p-3 border border-neutral-700">
            <div className="flex items-center justify-between mb-2">
              <div>
                <p className="font-bold text-white">{item.item_name}</p>
                <p className="text-sm text-neutral-400">{item.quantity}x {formatPrice(item.unit_price)}</p>
              </div>
              <p className="font-bold text-white">{formatPrice(item.unit_price * item.quantity)}</p>
            </div>
            <div className="flex gap-2 flex-wrap">
              {drafts.map((_, i) => (
                <button
                  key={i}
                  onClick={() => assignItemToSplit(item.cart_id, i)}
                  className={`flex-1 min-w-[80px] py-1.5 rounded text-sm font-bold min-h-[40px] ${
                    (itemAssignments[item.cart_id] ?? 0) === i
                      ? 'bg-brand-600 text-white'
                      : 'bg-neutral-700 text-neutral-400'
                  }`}
                >
                  {t('splitPayment.person', { number: i + 1 })}
                </button>
              ))}
            </div>
          </div>
        ))}
        <div className="space-y-2">
          {drafts.map((split, i) => (
            <div key={i} className="flex items-center justify-between bg-neutral-800 p-2 rounded-lg">
              <span className="text-white font-bold">{t('splitPayment.person', { number: i + 1 })}: {formatPrice(split.amount)}</span>
              <div className="flex gap-1">
                <button
                  onClick={() => updateDraftMethod(i, 'card')}
                  className={`px-2 py-1 rounded text-xs font-bold ${split.method === 'card' ? 'bg-brand-600 text-white' : 'bg-neutral-700 text-neutral-400'}`}
                >
                  {t('splitPayment.card')}
                </button>
                <button
                  onClick={() => updateDraftMethod(i, 'cash')}
                  className={`px-2 py-1 rounded text-xs font-bold ${split.method === 'cash' ? 'bg-cockpit-green text-white' : 'bg-neutral-700 text-neutral-400'}`}
                >
                  {t('splitPayment.cash')}
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const renderCollecting = () => {
    if (!activeSplit) return null;
    const isCard = activeSplit.payment_method === 'card';
    const isPaid = activeSplit.status === 'paid';
    return (
      <div className="space-y-4">
        {/* Per-split progress strip */}
        <div className="flex gap-2">
          {splitRows.map((s, i) => (
            <div
              key={s.id}
              className={`flex-1 h-2 rounded-full ${
                s.status === 'paid'
                  ? 'bg-cockpit-green'
                  : s.status === 'failed'
                  ? 'bg-cockpit-red'
                  : i === activeIndex
                  ? 'bg-brand-500'
                  : 'bg-neutral-700'
              }`}
            />
          ))}
        </div>

        <div className="bg-neutral-800 rounded-lg p-4 border border-neutral-700">
          <div className="flex items-center justify-between mb-3">
            <p className="font-bold text-white text-lg">
              {t('splitPayment.collectingFrom', { number: activeIndex + 1, total: splitRows.length })}
            </p>
            <p className="font-bold text-brand-500 text-xl">{formatPrice(requiredForActive)}</p>
          </div>
          <p className="text-sm text-neutral-400">
            {isCard ? t('splitPayment.method.card') : t('splitPayment.method.cash')}
          </p>
        </div>

        {isCard && !isPaid && (
          <div className="space-y-3">
            {!terminalSent && !activeSplit.payment_intent_id && (
              <button
                onClick={sendToTerminal}
                className="w-full py-4 bg-[#009ee3] text-white text-lg font-bold rounded-lg hover:bg-[#0089c4] transition-all"
              >
                {t('splitPayment.sendToTerminal')}
              </button>
            )}
            {(terminalSent || activeSplit.status === 'pending_terminal') && (
              <div className="bg-[#009ee3]/10 border border-[#009ee3]/30 rounded-lg p-5 text-center space-y-3">
                <div className="flex items-center justify-center gap-2">
                  <div className="w-3 h-3 bg-[#009ee3] rounded-full animate-pulse" />
                  <p className="text-white font-bold">{t('splitPayment.terminalWaiting')}</p>
                </div>
                <p className="text-sm text-neutral-300">{t('splitPayment.terminalInstructions')}</p>
                <button
                  onClick={cancelTerminal}
                  className="text-sm text-neutral-400 underline"
                >
                  {t('splitPayment.cancelTerminal')}
                </button>
              </div>
            )}
            {terminalError && (
              <div className="bg-cockpit-red/30 border border-cockpit-red/40 rounded-lg p-3 text-center">
                <p className="text-cockpit-out-text font-semibold mb-2">{terminalError}</p>
                <button
                  onClick={sendToTerminal}
                  className="text-sm text-white font-bold underline"
                >
                  {t('splitPayment.retry')}
                </button>
              </div>
            )}
          </div>
        )}

        {!isCard && !isPaid && (
          <div className="space-y-3">
            <div className="bg-neutral-800 p-4 rounded-lg space-y-3">
              <p className="text-lg font-semibold text-white">{t('splitPayment.amountReceived')}</p>
              <input
                type="number"
                value={cashReceived}
                onChange={(e) => setCashReceived(e.target.value)}
                placeholder={formatPrice(requiredForActive)}
                className="w-full bg-neutral-700 border border-neutral-600 rounded-lg p-3 text-2xl text-white text-center focus:outline-none focus:border-cockpit-green font-bold"
                autoFocus
              />
              <div className="grid grid-cols-4 gap-2">
                {[50, 100, 200, 500].map((amt) => (
                  <button
                    key={amt}
                    onClick={() => setCashReceived(String(amt))}
                    className="py-2 bg-neutral-600 text-white font-bold rounded-lg hover:bg-neutral-500 transition-all"
                  >
                    ${amt}
                  </button>
                ))}
                <button
                  onClick={() => setCashReceived(String(requiredForActive))}
                  className="col-span-4 py-2 bg-neutral-700 text-white font-bold rounded-lg hover:bg-neutral-600 transition-all"
                >
                  {t('splitPayment.exactAmount', { amount: formatPrice(requiredForActive) })}
                </button>
              </div>
              {cashReceivedNum > 0 && (
                <div className="text-center pt-2 border-t border-neutral-700">
                  <p className="text-neutral-400 text-sm">{t('splitPayment.changeDue')}</p>
                  <p className="text-2xl font-bold text-cockpit-in-text">{formatPrice(cashChangeDue)}</p>
                </div>
              )}
            </div>
            {cashError && (
              <p className="text-cockpit-out-text text-sm font-semibold text-center">{cashError}</p>
            )}
            <button
              onClick={recordCash}
              disabled={isRecordingCash || cashReceivedNum + 0.005 < requiredForActive}
              className="w-full py-4 bg-cockpit-green text-white text-lg font-bold rounded-lg hover:bg-cockpit-green/90 disabled:bg-neutral-700 disabled:text-neutral-500 transition-all"
            >
              {isRecordingCash ? t('splitPayment.recording') : t('splitPayment.markCashCollected')}
            </button>
          </div>
        )}
      </div>
    );
  };

  const renderFinalizing = () => (
    <div className="space-y-4 text-center py-8">
      {finalizeError ? (
        <>
          <p className="text-cockpit-out-text font-bold">{finalizeError}</p>
          <button
            onClick={() => orderId && finalize(splitRows)}
            className="px-6 py-3 bg-brand-600 text-white font-bold rounded-lg"
          >
            {t('splitPayment.retryFinalize')}
          </button>
        </>
      ) : (
        <>
          <div className="w-12 h-12 mx-auto border-4 border-brand-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-white font-bold text-lg">{t('splitPayment.finalizing')}</p>
        </>
      )}
    </div>
  );

  // ---------- Outer chrome ----------

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-neutral-900 rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-hidden border border-neutral-800 flex flex-col">
        <div className="bg-brand-600 text-white p-5 flex-shrink-0">
          <h2 className="text-2xl font-bold">{t('splitPayment.title')}</h2>
          <p className="text-brand-200">{t('splitPayment.total', { amount: formatPrice(orderTotal) })}</p>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {phase === 'setup' && renderSetup()}
          {phase === 'collecting' && renderCollecting()}
          {phase === 'finalizing' && renderFinalizing()}
        </div>

        <div className="border-t border-neutral-800 p-4 flex-shrink-0 space-y-2">
          {phase === 'setup' && mode && (
            <>
              {cardSplitsBlocked && (
                <p className="text-cockpit-out-text text-sm font-semibold text-center mb-2">
                  {t('splitPayment.errors.mpNotConnected')}
                </p>
              )}
              {startError && (
                <p className="text-cockpit-out-text text-sm font-semibold text-center mb-2">{startError}</p>
              )}
              <button
                onClick={handleStart}
                disabled={
                  isStarting ||
                  cardSplitsBlocked ||
                  (mode !== 'even' && !isBalanced) ||
                  drafts.some((d) => d.amount <= 0)
                }
                className="w-full py-4 bg-brand-600 text-white text-lg font-bold rounded-lg hover:bg-brand-700 disabled:bg-neutral-700 disabled:text-neutral-500 transition-all"
              >
                {isStarting
                  ? t('splitPayment.processing')
                  : t('splitPayment.processPayments', { count: drafts.length })}
              </button>
            </>
          )}
          <button
            onClick={phase === 'setup' ? (mode ? () => setMode(null) : onClose) : handleCloseAttempt}
            disabled={isFinalizing}
            className="w-full py-3 bg-neutral-800 text-neutral-400 font-bold rounded-lg hover:bg-neutral-700 transition-all disabled:opacity-50"
          >
            {phase === 'setup' ? (mode ? t('splitPayment.back') : t('common:buttons.cancel')) : t('splitPayment.abandon')}
          </button>
        </div>

        {/* Abandon confirmation overlay */}
        {showAbandonConfirm && (
          <div className="absolute inset-0 bg-black/80 flex items-center justify-center z-10 p-6">
            <div className="bg-neutral-900 rounded-xl p-6 max-w-sm space-y-4 border border-neutral-700">
              <h3 className="text-white font-bold text-lg">{t('splitPayment.abandonConfirmTitle')}</h3>
              <p className="text-neutral-300 text-sm">
                {paidSplitsCount > 0
                  ? t('splitPayment.abandonWithPaidWarning', { count: paidSplitsCount })
                  : t('splitPayment.abandonConfirmBody')}
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setShowAbandonConfirm(false)}
                  className="flex-1 py-3 bg-neutral-700 text-white font-bold rounded-lg"
                >
                  {t('splitPayment.keepGoing')}
                </button>
                <button
                  onClick={handleAbandon}
                  className="flex-1 py-3 bg-cockpit-red text-white font-bold rounded-lg"
                >
                  {t('splitPayment.abandon')}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
