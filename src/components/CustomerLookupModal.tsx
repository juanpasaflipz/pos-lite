import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UserPlus, Search, X, Gift, Phone } from 'lucide-react';
import type { LoyaltyCustomer } from '../types';
import { lookupLoyaltyCustomer, createLoyaltyCustomer } from '../api';
import { formatPhone } from '../utils/phone';

interface Props {
  onCustomerLinked: (customer: LoyaltyCustomer) => void;
  onClose: () => void;
}

type Mode = 'existing' | 'new';
type Phase = 'search' | 'found' | 'register';
type Country = 'MX' | 'US';

const COUNTRIES: Array<{ code: Country; label: string; dial: string }> = [
  { code: 'MX', label: '🇲🇽', dial: '+52' },
  { code: 'US', label: '🇺🇸', dial: '+1' },
];

export default function CustomerLookupModal({ onCustomerLinked, onClose }: Props) {
  const { t } = useTranslation('pos');
  const [mode, setMode] = useState<Mode>('existing');
  const [phase, setPhase] = useState<Phase>('search');
  const [country, setCountry] = useState<Country>('MX');
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [referralCode, setReferralCode] = useState('');
  const [smsOptIn, setSmsOptIn] = useState(true);
  const [foundCustomer, setFoundCustomer] = useState<LoyaltyCustomer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const digits = phone.replace(/\D/g, '');
  const phoneValid = digits.length >= 10;

  const switchMode = (next: Mode) => {
    if (next === mode) return;
    setMode(next);
    setError(null);
    setFoundCustomer(null);
    setPhase(next === 'new' ? 'register' : 'search');
  };

  const handleSearch = async () => {
    if (!phoneValid || busy) {
      if (!phoneValid) setError(t('customerLookup.enterDigits'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const customer = await lookupLoyaltyCustomer(digits, country);
      setFoundCustomer(customer);
      setPhase('found');
    } catch (err: any) {
      const msg = err?.message ?? '';
      if (/not found/i.test(msg) || /\b404\b/.test(msg)) {
        // Auto-flip to new-customer flow so cashier can register in one step.
        setMode('new');
        setPhase('register');
      } else {
        setError(msg || t('customerLookup.registrationFailed'));
      }
    } finally {
      setBusy(false);
    }
  };

  const handleRegister = async () => {
    if (busy) return;
    if (!phoneValid) {
      setError(t('customerLookup.enterDigits'));
      return;
    }
    if (!name.trim()) {
      setError(t('customerLookup.nameRequired'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const customer = await createLoyaltyCustomer({
        phone: digits,
        name: name.trim(),
        referral_code_used: referralCode.trim() || undefined,
        sms_opt_in: smsOptIn,
        country_code: country,
      });
      onCustomerLinked(customer);
    } catch (err: any) {
      setError(err?.message || t('customerLookup.registrationFailed'));
    } finally {
      setBusy(false);
    }
  };

  const handleLink = () => {
    if (foundCustomer) onCustomerLinked(foundCustomer);
  };

  const activeCountry = COUNTRIES.find((c) => c.code === country)!;

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-neutral-900 rounded-2xl shadow-2xl w-full max-w-md max-h-[90vh] overflow-y-auto border border-neutral-800">
        <div className="bg-brand-600 text-white p-6 rounded-t-2xl flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Gift size={24} />
            <h2 className="text-xl font-bold">{t('customerLookup.loyaltyProgram')}</h2>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-brand-700 rounded-lg min-w-[40px] min-h-[40px] flex items-center justify-center"
            aria-label="Close"
          >
            <X size={20} />
          </button>
        </div>

        <div className="p-6 space-y-4">
          {/* Mode toggle: Existing / New */}
          <div className="grid grid-cols-2 gap-1 p-1 bg-neutral-800 rounded-lg">
            <button
              onClick={() => switchMode('existing')}
              className={`py-2 text-sm font-bold rounded-md transition-colors min-h-[40px] ${
                mode === 'existing' ? 'bg-brand-600 text-white' : 'text-neutral-300 hover:text-white'
              }`}
            >
              {t('customerLookup.modeExisting')}
            </button>
            <button
              onClick={() => switchMode('new')}
              className={`py-2 text-sm font-bold rounded-md transition-colors min-h-[40px] ${
                mode === 'new' ? 'bg-brand-600 text-white' : 'text-neutral-300 hover:text-white'
              }`}
            >
              {t('customerLookup.modeNew')}
            </button>
          </div>

          <div>
            <label className="block text-sm font-semibold text-neutral-300 mb-2">
              {t('customerLookup.phoneNumber')}
            </label>
            <div className="flex gap-2">
              {/* Country selector */}
              <div className="relative">
                <select
                  value={country}
                  onChange={(e) => setCountry(e.target.value as Country)}
                  disabled={busy}
                  className="appearance-none h-full pl-3 pr-7 py-3 bg-neutral-800 border border-neutral-700 rounded-lg text-white text-sm font-mono focus:outline-none focus:border-brand-500 min-h-[44px]"
                  aria-label="Country code"
                >
                  {COUNTRIES.map((c) => (
                    <option key={c.code} value={c.code}>{c.label} {c.dial}</option>
                  ))}
                </select>
              </div>
              <div className="relative flex-1">
                <Phone size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500" />
                <input
                  type="tel"
                  inputMode="tel"
                  autoFocus
                  value={phone}
                  onChange={(e) => {
                    setPhone(e.target.value);
                    setError(null);
                    if (mode === 'existing' && phase !== 'search') {
                      setPhase('search');
                      setFoundCustomer(null);
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return;
                    if (mode === 'existing' && phase === 'search') handleSearch();
                    else if (mode === 'new' && name.trim()) handleRegister();
                  }}
                  placeholder={t('customerLookup.enterPhone')}
                  className="w-full pl-10 pr-3 py-3 bg-neutral-800 border border-neutral-700 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:border-brand-500 min-h-[44px]"
                  disabled={busy}
                />
              </div>
            </div>
            <p className="text-xs text-neutral-500 mt-1 font-mono">{activeCountry.dial}</p>
          </div>

          {mode === 'existing' && phase === 'search' && (
            <button
              onClick={handleSearch}
              disabled={!phoneValid || busy}
              className="w-full flex items-center justify-center gap-2 bg-brand-600 hover:bg-brand-700 disabled:bg-neutral-700 disabled:text-neutral-500 text-white font-bold py-3 rounded-lg min-h-[44px] transition-colors"
            >
              <Search size={18} />
              {busy ? t('customerLookup.searching') : t('customerLookup.searchCustomer')}
            </button>
          )}

          {mode === 'existing' && phase === 'found' && foundCustomer && (
            <div className="space-y-3">
              <div className="bg-neutral-800 border border-neutral-700 rounded-lg p-4 space-y-2">
                <div className="flex items-center gap-2 text-cockpit-in-text">
                  <Gift size={16} />
                  <span className="text-sm font-semibold">{t('customerLookup.customerFound')}</span>
                </div>
                <p className="text-white text-lg font-bold">{foundCustomer.name}</p>
                <p className="text-neutral-400 text-sm font-mono">
                  {formatPhone(foundCustomer.phone, foundCustomer.country_code)}
                </p>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <p className="text-neutral-500">{t('customerLookup.orders')}</p>
                    <p className="text-white font-semibold">{foundCustomer.orders_count}</p>
                  </div>
                  <div>
                    <p className="text-neutral-500">{t('customerLookup.totalStamps')}</p>
                    <p className="text-white font-semibold">{foundCustomer.stamps_earned}</p>
                  </div>
                </div>
                {foundCustomer.activeCard && (
                  <div className="pt-2 border-t border-neutral-700">
                    <p className="text-sm text-neutral-300">
                      {t('customerLookup.stampCard', {
                        earned: foundCustomer.activeCard.stamps_earned,
                        required: foundCustomer.activeCard.stamps_required,
                      })}
                    </p>
                    {foundCustomer.activeCard.completed === 1 && (
                      <p className="text-sm text-cockpit-in-text font-semibold mt-1">
                        {t('customerLookup.rewardReady')}
                      </p>
                    )}
                  </div>
                )}
              </div>
              <button
                onClick={handleLink}
                className="w-full flex items-center justify-center gap-2 bg-brand-600 hover:bg-brand-700 text-white font-bold py-3 rounded-lg min-h-[44px] transition-colors"
              >
                <UserPlus size={18} />
                {t('customerLookup.linkCustomer')}
              </button>
            </div>
          )}

          {mode === 'new' && (
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-semibold text-neutral-300 mb-2">
                  {t('customerLookup.customerName')}
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    setError(null);
                  }}
                  placeholder={t('customerLookup.fullName')}
                  className="w-full px-3 py-3 bg-neutral-800 border border-neutral-700 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:border-brand-500 min-h-[44px]"
                  disabled={busy}
                />
              </div>
              <div>
                <label className="block text-sm font-semibold text-neutral-300 mb-2">
                  {t('customerLookup.referralCode')}
                </label>
                <input
                  type="text"
                  value={referralCode}
                  onChange={(e) => setReferralCode(e.target.value.toUpperCase())}
                  placeholder={t('customerLookup.referralPlaceholder')}
                  className="w-full px-3 py-3 bg-neutral-800 border border-neutral-700 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:border-brand-500 min-h-[44px]"
                  disabled={busy}
                />
              </div>
              <label className="flex items-center gap-3 cursor-pointer py-2 min-h-[44px]">
                <input
                  type="checkbox"
                  checked={smsOptIn}
                  onChange={(e) => setSmsOptIn(e.target.checked)}
                  className="w-5 h-5 accent-brand-600"
                  disabled={busy}
                />
                <span className="text-sm text-neutral-300">{t('customerLookup.receiveSms')}</span>
              </label>
              <button
                onClick={handleRegister}
                disabled={busy || !name.trim() || !phoneValid}
                className="w-full flex items-center justify-center gap-2 bg-brand-600 hover:bg-brand-700 disabled:bg-neutral-700 disabled:text-neutral-500 text-white font-bold py-3 rounded-lg min-h-[44px] transition-colors"
              >
                <UserPlus size={18} />
                {busy ? t('customerLookup.registering') : t('customerLookup.registerAndLink')}
              </button>
            </div>
          )}

          {error && (
            <p className="text-sm text-brand-400 text-center">{error}</p>
          )}
        </div>
      </div>
    </div>
  );
}
