import React, { useState } from 'react';
import { ArrowLeft, Truck, Loader2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useKioskBinding } from '../context/KioskBindingContext';
import { useKioskCart } from '../context/KioskCartContext';
import { useIdleTimer } from '../hooks/useIdleTimer';
import { quoteKioskDelivery } from '../lib/kioskApi';

const money = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });

const KioskDeliveryAddressScreen: React.FC = () => {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { tenantId, kioskToken } = useKioskBinding();
  const { setDelivery, delivery, setCallName } = useKioskCart();

  const [name, setName] = useState(delivery?.recipientName || '');
  const [phone, setPhone] = useState(delivery?.phone || '');
  const [address, setAddress] = useState(delivery?.address || '');
  const [notes, setNotes] = useState(delivery?.notes || '');
  const [quote, setQuote] = useState<{ fee: number; etaMin: number; quoteId: string } | null>(
    delivery?.quoteId
      ? {
          fee: delivery.quoteFee || 0,
          etaMin: delivery.quoteEtaIso
            ? Math.max(1, Math.round((new Date(delivery.quoteEtaIso).getTime() - Date.now()) / 60_000))
            : 0,
          quoteId: delivery.quoteId,
        }
      : null,
  );
  const [quoting, setQuoting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useIdleTimer(() => navigate('/'), 150_000);

  const canQuote = name.trim().length >= 2 && phone.trim().length >= 8 && address.trim().length >= 8;

  const fetchQuote = async () => {
    if (!tenantId || !kioskToken || !canQuote || quoting) return;
    setQuoting(true);
    setError(null);
    try {
      // Default Mexico phone normalization: prepend +52 if user typed bare digits.
      const phoneE164 = /^\+/.test(phone.trim())
        ? phone.trim()
        : `+52${phone.trim().replace(/\D/g, '')}`;

      const result = await quoteKioskDelivery(
        { tenantId, kioskToken },
        { dropoff_address: address.trim(), dropoff_phone_number: phoneE164 },
      );
      const etaMin = result.dropoff_eta
        ? Math.max(1, Math.round((new Date(result.dropoff_eta).getTime() - Date.now()) / 60_000))
        : result.duration_min;
      setQuote({ fee: result.fee, etaMin, quoteId: result.quote_id });
    } catch (err) {
      setError(err instanceof Error ? err.message : t('delivery.quoteFailed'));
      setQuote(null);
    } finally {
      setQuoting(false);
    }
  };

  const continueToMenu = () => {
    if (!quote) return;
    const phoneE164 = /^\+/.test(phone.trim())
      ? phone.trim()
      : `+52${phone.trim().replace(/\D/g, '')}`;
    setDelivery({
      address: address.trim(),
      phone: phoneE164,
      recipientName: name.trim(),
      notes: notes.trim() || null,
      quoteId: quote.quoteId,
      quoteFee: quote.fee,
      quoteEtaIso: new Date(Date.now() + quote.etaMin * 60_000).toISOString(),
    });
    setCallName(name.trim());
    navigate('/menu');
  };

  return (
    <div className="h-full w-full bg-neutral-950 text-white flex flex-col">
      <header className="px-6 py-4 border-b border-neutral-800 grid grid-cols-[auto_1fr_auto] items-center gap-4">
        <button
          onClick={() => navigate('/fulfillment')}
          className="h-16 px-5 rounded-lg bg-neutral-800 active:bg-neutral-700 text-lg font-bold touch-manipulation inline-flex items-center gap-2"
        >
          <ArrowLeft className="h-6 w-6" />
          {t('common.back')}
        </button>
        <h1 className="text-3xl xl:text-4xl font-black text-center leading-none inline-flex items-center justify-center gap-3">
          <Truck className="h-8 w-8" />
          {t('delivery.title')}
        </h1>
        <div />
      </header>

      <main className="flex-1 min-h-0 overflow-y-auto px-8 py-6 grid grid-cols-1 md:grid-cols-2 gap-8">
        <div className="space-y-5">
          <div>
            <label className="block text-lg font-bold text-neutral-400 mb-2">{t('common.yourName')}</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('delivery.namePlaceholder')}
              className="w-full h-16 px-5 rounded-lg bg-neutral-900 border border-neutral-800 text-2xl font-bold focus:outline-none focus:border-cockpit-green"
              autoCapitalize="words"
              maxLength={40}
            />
          </div>

          <div>
            <label className="block text-lg font-bold text-neutral-400 mb-2">{t('delivery.phone')}</label>
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder={t('delivery.phonePlaceholder')}
              inputMode="tel"
              className="w-full h-16 px-5 rounded-lg bg-neutral-900 border border-neutral-800 text-2xl font-bold focus:outline-none focus:border-cockpit-green"
              maxLength={20}
            />
            <p className="text-sm text-neutral-500 mt-1">{t('delivery.phoneHelp')}</p>
          </div>

          <div>
            <label className="block text-lg font-bold text-neutral-400 mb-2">{t('delivery.address')}</label>
            <textarea
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder={t('delivery.addressPlaceholder')}
              rows={3}
              className="w-full px-5 py-3 rounded-lg bg-neutral-900 border border-neutral-800 text-xl font-bold focus:outline-none focus:border-cockpit-green resize-none"
              maxLength={300}
            />
          </div>

          <div>
            <label className="block text-lg font-bold text-neutral-400 mb-2">{t('delivery.notes')}</label>
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={t('delivery.notesPlaceholder')}
              className="w-full h-16 px-5 rounded-lg bg-neutral-900 border border-neutral-800 text-xl font-bold focus:outline-none focus:border-cockpit-green"
              maxLength={200}
            />
          </div>
        </div>

        <div className="space-y-5">
          <button
            onClick={fetchQuote}
            disabled={!canQuote || quoting}
            className="w-full h-20 rounded-lg bg-cockpit-green active:bg-cockpit-green/80 disabled:bg-neutral-800 disabled:text-neutral-500 text-white text-2xl font-black inline-flex items-center justify-center gap-3 touch-manipulation"
          >
            {quoting ? <Loader2 className="h-7 w-7 animate-spin" /> : null}
            {quoting ? t('delivery.quoting') : (quote ? t('delivery.requote') : t('delivery.quote'))}
          </button>

          {error && (
            <div className="rounded-lg bg-cockpit-red/30 border border-cockpit-red/60 p-4">
              <p className="text-cockpit-out-text text-lg font-bold">{error}</p>
            </div>
          )}

          {quote && !error && (
            <div className="rounded-lg bg-cockpit-green/15 border border-cockpit-green/40 p-5 space-y-4">
              <div>
                <p className="text-sm text-neutral-400 font-bold uppercase">{t('delivery.fee')}</p>
                <p className="text-4xl font-black text-cockpit-in-text">{money.format(quote.fee)}</p>
              </div>
              <div>
                <p className="text-sm text-neutral-400 font-bold uppercase">{t('delivery.eta')}</p>
                <p className="text-3xl font-black">{t('delivery.etaMin', { min: quote.etaMin })}</p>
              </div>
              <p className="text-sm text-neutral-400">{t('delivery.uberNote')}</p>
            </div>
          )}

          <button
            onClick={continueToMenu}
            disabled={!quote}
            className="w-full h-20 rounded-lg bg-brand-600 active:bg-brand-700 disabled:bg-neutral-800 disabled:text-neutral-500 text-white text-2xl font-black touch-manipulation"
          >
            {t('delivery.continueToMenu')}
          </button>
        </div>
      </main>
    </div>
  );
};

export default KioskDeliveryAddressScreen;
