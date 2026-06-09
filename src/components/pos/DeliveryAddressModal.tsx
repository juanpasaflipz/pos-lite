import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Truck, Loader2 } from 'lucide-react';
import { quoteUberDirect } from '../../api';
import { formatPrice } from '../../utils/currency';

export interface DeliveryDraft {
  customerName: string;
  phone: string;
  address: string;
  notes: string | null;
  quoteId: string;
  fee: number;
  etaMin: number;
}

interface Props {
  isOpen: boolean;
  initial: DeliveryDraft | null;
  manifestTotalValue: number;
  onClose: () => void;
  onSave: (draft: DeliveryDraft) => void;
}

function toE164(raw: string): string {
  const trimmed = raw.trim();
  if (/^\+/.test(trimmed)) return trimmed;
  const digits = trimmed.replace(/\D/g, '');
  return digits ? `+52${digits}` : '';
}

export default function DeliveryAddressModal({ isOpen, initial, manifestTotalValue, onClose, onSave }: Props) {
  const { t } = useTranslation('pos');
  const [customerName, setCustomerName] = useState(initial?.customerName || '');
  const [phone, setPhone] = useState(initial?.phone || '');
  const [address, setAddress] = useState(initial?.address || '');
  const [notes, setNotes] = useState(initial?.notes || '');
  const [quote, setQuote] = useState<{ quoteId: string; fee: number; etaMin: number } | null>(
    initial ? { quoteId: initial.quoteId, fee: initial.fee, etaMin: initial.etaMin } : null,
  );
  const [quoting, setQuoting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const phoneE164 = toE164(phone);
  const canQuote =
    customerName.trim().length >= 2 &&
    phoneE164.length >= 11 &&
    address.trim().length >= 8 &&
    !quoting;

  const fetchQuote = async () => {
    if (!canQuote) return;
    setQuoting(true);
    setError(null);
    try {
      const result = await quoteUberDirect({
        dropoff_address: address.trim(),
        dropoff_phone_number: phoneE164,
        manifest_total_value: Math.round(manifestTotalValue * 100),
      });
      const etaMin = result.dropoff_eta
        ? Math.max(1, Math.round((new Date(result.dropoff_eta).getTime() - Date.now()) / 60_000))
        : Math.round((result.duration || 0));
      setQuote({ quoteId: result.id, fee: result.fee / 100, etaMin });
    } catch (err) {
      setError(err instanceof Error ? err.message : t('delivery.quoteFailed'));
      setQuote(null);
    } finally {
      setQuoting(false);
    }
  };

  const save = () => {
    if (!quote) return;
    onSave({
      customerName: customerName.trim(),
      phone: phoneE164,
      address: address.trim(),
      notes: notes.trim() || null,
      quoteId: quote.quoteId,
      fee: quote.fee,
      etaMin: quote.etaMin,
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="bg-neutral-900 border border-neutral-800 rounded-2xl w-full max-w-xl shadow-2xl">
        <div className="flex items-center justify-between p-5 border-b border-neutral-800">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-cockpit-green/20 flex items-center justify-center">
              <Truck size={18} className="text-cockpit-in-text" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-white">{t('delivery.modalTitle')}</h2>
              <p className="text-xs text-neutral-400">{t('delivery.modalSubtitle')}</p>
            </div>
          </div>
          <button onClick={onClose} className="text-neutral-500 hover:text-neutral-300 p-1">
            <X size={20} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-bold text-neutral-400 uppercase tracking-wider mb-1">
                {t('delivery.customerName')}
              </label>
              <input
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                placeholder="Juan Pérez"
                maxLength={40}
                className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-white text-sm font-medium focus:outline-none focus:border-cockpit-green"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-neutral-400 uppercase tracking-wider mb-1">
                {t('delivery.phone')}
              </label>
              <input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="55 1234 5678"
                inputMode="tel"
                maxLength={20}
                className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-white text-sm font-medium focus:outline-none focus:border-cockpit-green"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold text-neutral-400 uppercase tracking-wider mb-1">
              {t('delivery.address')}
            </label>
            <textarea
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder={t('delivery.addressPlaceholder')}
              rows={2}
              maxLength={300}
              className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-white text-sm font-medium focus:outline-none focus:border-cockpit-green resize-none"
            />
          </div>

          <div>
            <label className="block text-xs font-bold text-neutral-400 uppercase tracking-wider mb-1">
              {t('delivery.notes')}
            </label>
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={t('delivery.notesPlaceholder')}
              maxLength={200}
              className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-white text-sm font-medium focus:outline-none focus:border-cockpit-green"
            />
          </div>

          <button
            onClick={fetchQuote}
            disabled={!canQuote}
            className="w-full py-3 rounded-lg bg-cockpit-green text-white text-sm font-bold disabled:bg-neutral-800 disabled:text-neutral-500 transition-colors inline-flex items-center justify-center gap-2"
          >
            {quoting && <Loader2 size={16} className="animate-spin" />}
            {quoting ? t('delivery.quoting') : quote ? t('delivery.requote') : t('delivery.getQuote')}
          </button>

          {error && (
            <div className="bg-cockpit-red/20 border border-cockpit-red/50 rounded-lg p-3">
              <p className="text-cockpit-out-text text-sm">{error}</p>
            </div>
          )}

          {quote && !error && (
            <div className="bg-cockpit-green/15 border border-cockpit-green/40 rounded-lg p-4 grid grid-cols-2 gap-3">
              <div>
                <p className="text-xs text-neutral-400 font-bold uppercase">{t('delivery.fee')}</p>
                <p className="text-2xl font-black text-cockpit-in-text">{formatPrice(quote.fee)}</p>
              </div>
              <div>
                <p className="text-xs text-neutral-400 font-bold uppercase">{t('delivery.eta')}</p>
                <p className="text-2xl font-black">{quote.etaMin} min</p>
              </div>
            </div>
          )}

          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={save}
              disabled={!quote}
              className="flex-1 py-3 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:bg-neutral-800 disabled:text-neutral-500 text-white text-sm font-bold transition-colors"
            >
              {t('delivery.confirm')}
            </button>
            <button
              onClick={onClose}
              className="px-4 py-3 text-neutral-400 text-sm font-medium hover:text-white transition-colors"
            >
              {t('delivery.cancel')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
