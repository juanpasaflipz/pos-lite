import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft, User, BarChart3, CreditCard, Settings, Lock,
  Check, AlertCircle, Crown, Smartphone, Wifi, WifiOff, X, Loader2,
  Landmark, Shield, FileText, Download, ShieldOff,
} from 'lucide-react';
import { getAccount, updateAccount, changePassword, createCheckoutSession, createPortalSession, getMpConnectUrl, getMpTerminals, setMpDefaultTerminal as apiSetMpDefaultTerminal, validatePromoCode, getBankConnections, getBankAccounts, syncBankConnection, deleteBankConnection, getFinancingConsent, deleteFinancingConsent, exportFinancingData, getFinancingConsentTerms, type BankConnection, type BankAccount } from '../api';
import { usePlan } from '../context/PlanContext';
import BankConnectionCard from '../components/banking/BankConnectionCard';
import ConnectBankButton from '../components/banking/ConnectBankButton';
import SecurityInfoModal from '../components/banking/SecurityInfoModal';

type PromoState = 'idle' | 'expanded' | 'loading' | 'valid' | 'invalid';

interface AccountData {
  id: string;
  name: string;
  email: string;
  plan: string;
  subscription_status: string | null;
  created_at: string;
  usage: {
    employees: { current: number; limit: number };
    menu_items: { current: number; limit: number };
  };
}

function PlanBadge({ plan }: { plan: string }) {
  const styles: Record<string, string> = {
    free: 'bg-neutral-700/50 text-neutral-400',
    pro: 'bg-teal-600/20 text-teal-400',
  };
  return (
    <span className={`px-2.5 py-1 text-xs font-semibold rounded-full uppercase ${styles[plan] || styles.free}`}>
      {plan}
    </span>
  );
}

function UsageBar({ label, current, limit, unlimitedText }: { label: string; current: number; limit: number; unlimitedText: string }) {
  const isUnlimited = !isFinite(limit);
  const pct = isUnlimited ? 0 : Math.min((current / limit) * 100, 100);
  // Usage tier mapped to cockpit zones: >90% = OUT (critical), >70% = ATTENTION (watch), else = IN (healthy).
  const color = pct > 90 ? '#C94B1B' : pct > 70 ? '#D9A021' : '#1F5B34';

  return (
    <div>
      <div className="flex justify-between text-sm mb-1.5">
        <span className="text-neutral-400">{label}</span>
        <span className="text-white font-medium">
          {current} / {isUnlimited ? unlimitedText : limit}
        </span>
      </div>
      {isUnlimited ? (
        <div className="w-full bg-neutral-800 rounded-full h-2.5">
          <div className="h-2.5 rounded-full bg-teal-600/30 w-full" />
        </div>
      ) : (
        <div className="w-full bg-neutral-800 rounded-full h-2.5">
          <div
            className="h-2.5 rounded-full transition-all"
            style={{ width: `${pct}%`, backgroundColor: color }}
          />
        </div>
      )}
    </div>
  );
}

export default function AccountScreen() {
  const { t } = useTranslation('common');
  const [account, setAccount] = useState<AccountData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Settings form
  const [editName, setEditName] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');

  // Password form
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [pwSaving, setPwSaving] = useState(false);
  const [pwMsg, setPwMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Billing
  const [billingLoading, setBillingLoading] = useState<string | null>(null);
  const [billingBanner, setBillingBanner] = useState<{ type: 'success' | 'info' | 'error'; text: string } | null>(null);

  // Promo code
  const [promoState, setPromoState] = useState<PromoState>('idle');
  const [promoInput, setPromoInput] = useState('');
  const [promoCode, setPromoCode] = useState('');
  const [promoDescription, setPromoDescription] = useState('');
  const [promoError, setPromoError] = useState('');

  // Mercado Pago
  const [mpTerminals, setMpTerminals] = useState<Array<{ id: string; external_pos_id: string }>>([]);
  const [mpTerminalsLoading, setMpTerminalsLoading] = useState(false);
  const [mpDefaultTerminal, setMpDefaultTerminal] = useState<string>('');
  const [mpSaved, setMpSaved] = useState(false);

  // Banking
  const [bankConnections, setBankConnections] = useState<BankConnection[]>([]);
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [bankLoading, setBankLoading] = useState(false);
  const [showSecurityModal, setShowSecurityModal] = useState(false);

  // Data & Privacy
  const [consentStatus, setConsentStatus] = useState<{ consented: boolean; consent_at?: string; consent_version?: string } | null>(null);
  const [showConsentTerms, setShowConsentTerms] = useState(false);
  const [consentTerms, setConsentTerms] = useState<any>(null);
  const [showRevokeModal, setShowRevokeModal] = useState(false);
  const [revokeLoading, setRevokeLoading] = useState(false);
  const [exportLoading, setExportLoading] = useState(false);

  const { plan, limits, refresh } = usePlan();
  const isBankingPlan = plan === 'pro';
  const maxBankConns = limits.maxBankConnections || 0;

  const hasOwnerToken = true; // Admin employees can now access via employee JWT

  // Check URL params for MP connection result
  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.split('?')[1] || '');
    if (params.get('mp') === 'connected') {
      // Remove param from URL
      window.location.hash = window.location.hash.split('?')[0];
    }
  }, []);

  const loadBankData = async () => {
    setBankLoading(true);
    try {
      const [conns, accts] = await Promise.all([
        getBankConnections(),
        getBankAccounts(),
      ]);
      setBankConnections(conns);
      setBankAccounts(accts);
    } catch {
      // silent — section just won't show data
    }
    setBankLoading(false);
  };

  const loadAccount = useCallback(async () => {
    const data = await getAccount();
    setAccount(data);
    setEditName(data.name);
    setEditEmail(data.email);
    if (data.plan === 'pro') {
      loadBankData();
    }
    getFinancingConsent()
      .then(cs => setConsentStatus({ consented: cs.has_consent, consent_at: cs.consented_at, consent_version: cs.consent_version }))
      .catch(() => {});
    return data;
  }, []);

  useEffect(() => {
    setLoading(true);
    loadAccount()
      .catch((err: any) => {
        setError(err.message || t('account.failedLoadAccount'));
      })
      .finally(() => setLoading(false));
  }, [loadAccount, t]);

  useEffect(() => {
    const billingResult = new URLSearchParams(window.location.hash.split('?')[1] || '').get('billing');
    if (!billingResult) return;

    const clearBillingParam = () => {
      const [path] = window.location.hash.split('?');
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${path}`);
    };

    if (billingResult === 'cancelled') {
      setBillingBanner({ type: 'info', text: t('account.billingCancelled') });
      clearBillingParam();
      return;
    }

    if (billingResult !== 'success') return;

    let cancelled = false;
    const pollForUpgrade = async () => {
      setBillingBanner({ type: 'info', text: t('account.billingPending') });

      for (let attempt = 0; attempt < 6 && !cancelled; attempt += 1) {
        try {
          const data = await loadAccount();
          await refresh();
          if (data.plan === 'pro') {
            if (!cancelled) {
              setBillingBanner({ type: 'success', text: t('account.billingSuccess') });
              clearBillingParam();
            }
            return;
          }
        } catch {
          // keep retrying
        }

        if (attempt < 5) {
          await new Promise(resolve => setTimeout(resolve, 2500));
        }
      }

      if (!cancelled) {
        setBillingBanner({ type: 'error', text: t('account.billingRefreshError') });
        clearBillingParam();
      }
    };

    pollForUpgrade();
    return () => {
      cancelled = true;
    };
  }, [loadAccount, refresh, t]);

  const handleSave = async () => {
    setSaving(true);
    setSaveMsg('');
    try {
      const result = await updateAccount({
        name: editName !== account?.name ? editName : undefined,
        email: editEmail !== account?.email ? editEmail : undefined,
      });
      setAccount(prev => prev ? { ...prev, name: result.name, email: result.email } : prev);
      setSaveMsg(t('account.savedSuccessfully'));
      setTimeout(() => setSaveMsg(''), 3000);
    } catch (err: any) {
      setSaveMsg(err.message || t('account.failedSave'));
    }
    setSaving(false);
  };

  const handlePasswordChange = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwMsg(null);
    if (newPw !== confirmPw) {
      setPwMsg({ type: 'error', text: t('account.passwordsNoMatch') });
      return;
    }
    if (newPw.length < 8) {
      setPwMsg({ type: 'error', text: t('account.passwordMinLength') });
      return;
    }
    setPwSaving(true);
    try {
      await changePassword(currentPw, newPw);
      setPwMsg({ type: 'success', text: t('account.passwordUpdated') });
      setCurrentPw('');
      setNewPw('');
      setConfirmPw('');
    } catch (err: any) {
      setPwMsg({ type: 'error', text: err.message || t('account.failedChangePassword') });
    }
    setPwSaving(false);
  };

  const handleValidatePromo = async () => {
    const code = promoInput.trim().toUpperCase();
    if (!code) return;
    setPromoState('loading');
    setPromoError('');
    try {
      const result = await validatePromoCode(code);
      if (result.valid) {
        setPromoState('valid');
        setPromoCode(result.code || code);
        setPromoDescription(result.discount_description || 'Discount applied');
      } else {
        setPromoState('invalid');
        setPromoError(result.message || 'Invalid or expired code');
      }
    } catch {
      setPromoState('invalid');
      setPromoError('Error validating code');
    }
  };

  const handleRemovePromo = () => {
    setPromoState('idle');
    setPromoInput('');
    setPromoCode('');
    setPromoDescription('');
    setPromoError('');
  };

  const handleSubscribe = async (plan: 'pro') => {
    setBillingLoading(plan);
    try {
      const { url } = await createCheckoutSession(plan, promoCode || undefined);
      window.location.href = url;
    } catch {
      setBillingLoading(null);
    }
  };

  const handleManageBilling = async () => {
    setBillingLoading('portal');
    try {
      const { url } = await createPortalSession();
      window.location.href = url;
    } catch {
      setBillingLoading(null);
    }
  };

  return (
    <div className="min-h-screen bg-neutral-950">
      {/* Header */}
      <div className="bg-neutral-900 text-white p-6 border-b border-neutral-800">
        <div className="flex items-center gap-4">
          <Link to="/admin" className="p-2 hover:bg-neutral-800 rounded-lg transition-colors">
            <ArrowLeft size={24} />
          </Link>
          <h1 className="text-3xl font-black tracking-tighter">{t('account.title')}</h1>
        </div>
      </div>

      <div className="max-w-3xl mx-auto p-6 space-y-6">
        {billingBanner && (
          <div className={`border rounded-lg p-4 ${
            billingBanner.type === 'success'
              ? 'bg-green-900/20 border-green-800 text-green-300'
              : billingBanner.type === 'error'
                ? 'bg-amber-900/20 border-amber-800 text-amber-200'
                : 'bg-brand-900/20 border-brand-800 text-brand-200'
          }`}>
            <p>{billingBanner.text}</p>
          </div>
        )}
        {loading ? (
          <div className="space-y-4">
            {[1, 2, 3].map(i => (
              <div key={i} className="bg-neutral-900 border border-neutral-800 rounded-lg p-6 animate-pulse">
                <div className="h-24 bg-neutral-800 rounded" />
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="bg-red-900/30 border border-red-800 rounded-lg p-4">
            <p className="text-red-300">{error}</p>
          </div>
        ) : account && (
          <>
            {/* Account Overview */}
            <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-6">
              <div className="flex items-center gap-3 mb-4">
                <User className="text-brand-500" size={22} />
                <h2 className="text-lg font-bold text-white">{t('account.overview')}</h2>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-neutral-500 text-xs uppercase tracking-wider">{t('account.restaurant')}</p>
                  <p className="text-white font-medium mt-0.5">{account.name}</p>
                </div>
                <div>
                  <p className="text-neutral-500 text-xs uppercase tracking-wider">{t('account.email')}</p>
                  <p className="text-white font-medium mt-0.5">{account.email}</p>
                </div>
                <div>
                  <p className="text-neutral-500 text-xs uppercase tracking-wider">{t('account.planLabel')}</p>
                  <div className="mt-1"><PlanBadge plan={account.plan} /></div>
                </div>
                <div>
                  <p className="text-neutral-500 text-xs uppercase tracking-wider">{t('account.memberSince')}</p>
                  <p className="text-white font-medium mt-0.5">
                    {new Date(account.created_at).toLocaleDateString()}
                  </p>
                </div>
              </div>
            </div>

            {/* Usage Summary */}
            <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-6">
              <div className="flex items-center gap-3 mb-4">
                <BarChart3 className="text-brand-500" size={22} />
                <h2 className="text-lg font-bold text-white">{t('account.usageSummary')}</h2>
              </div>
              <div className="space-y-4">
                <UsageBar
                  label={t('account.employees')}
                  current={account.usage.employees.current}
                  limit={account.usage.employees.limit}
                  unlimitedText={t('account.unlimited')}
                />
                <UsageBar
                  label={t('account.menuItems')}
                  current={account.usage.menu_items.current}
                  limit={account.usage.menu_items.limit}
                  unlimitedText={t('account.unlimited')}
                />
              </div>
            </div>

            {/* Billing */}
            <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-6">
              <div className="flex items-center gap-3 mb-4">
                <CreditCard className="text-brand-500" size={22} />
                <h2 className="text-lg font-bold text-white">{t('account.billing')}</h2>
              </div>
              {account.plan === 'free' ? (
                <div className="space-y-3">
                  <p className="text-neutral-400 text-sm">{t('account.freePlanMessage')}</p>

                  <div className="flex gap-3">
                    <button
                      onClick={() => handleSubscribe('pro')}
                      disabled={billingLoading !== null}
                      className="px-4 py-2 bg-teal-600 text-white text-sm font-semibold rounded-lg hover:bg-teal-700 transition-colors disabled:opacity-50"
                    >
                      {billingLoading === 'pro' ? t('upgrade.redirecting') : t('account.proMonthly')}
                    </button>
                  </div>

                  {/* Promo Code */}
                  <div className="pt-2">
                    {promoState === 'idle' && (
                      <button
                        type="button"
                        onClick={() => setPromoState('expanded')}
                        className="text-sm text-teal-500 hover:text-teal-400 transition-colors"
                      >
                        {t('account.havePromo')}
                      </button>
                    )}

                    {(promoState === 'expanded' || promoState === 'loading' || promoState === 'invalid') && (
                      <div className="space-y-2">
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            value={promoInput}
                            onChange={e => {
                              setPromoInput(e.target.value.toUpperCase());
                              if (promoState === 'invalid') {
                                setPromoState('expanded');
                                setPromoError('');
                              }
                            }}
                            placeholder={t('account.enterCode')}
                            className="flex-1 px-3 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-white text-sm placeholder-neutral-500 focus:outline-none focus:border-teal-600"
                            disabled={promoState === 'loading'}
                            onKeyDown={e => { if (e.key === 'Enter') handleValidatePromo(); }}
                          />
                          <button
                            type="button"
                            onClick={handleValidatePromo}
                            disabled={promoState === 'loading' || !promoInput.trim()}
                            className="px-4 py-2 bg-teal-600 text-white text-sm font-semibold rounded-lg hover:bg-teal-700 transition-colors disabled:opacity-50"
                          >
                            {promoState === 'loading' ? <Loader2 className="w-4 h-4 animate-spin" /> : t('buttons.apply')}
                          </button>
                          <button
                            type="button"
                            onClick={handleRemovePromo}
                            className="p-2 text-neutral-500 hover:text-neutral-300 transition-colors"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                        {promoState === 'invalid' && promoError && (
                          <p className="text-red-400 text-sm">{promoError}</p>
                        )}
                      </div>
                    )}

                    {promoState === 'valid' && (
                      <div className="flex items-center gap-2 p-3 bg-green-900/20 border border-green-800/50 rounded-lg">
                        <Check className="w-4 h-4 text-green-400 flex-shrink-0" />
                        <span className="text-green-400 font-semibold text-sm">{promoCode}</span>
                        <span className="text-neutral-400 text-sm mx-1">&mdash;</span>
                        <span className="text-green-300 text-sm flex-1">{promoDescription}</span>
                        <button
                          type="button"
                          onClick={handleRemovePromo}
                          className="p-1 text-neutral-500 hover:text-neutral-300 transition-colors"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-4">
                  <div>
                    <p className="text-neutral-400 text-sm">{t('account.currentPlan')}</p>
                    <p className="text-white font-bold capitalize flex items-center gap-2">
                      <Crown size={16} className="text-teal-500" />
                      {t('account.proMonthly')}
                    </p>
                  </div>
                  <div className="flex gap-3 ml-auto">
                    <button
                      onClick={handleManageBilling}
                      disabled={billingLoading !== null}
                      className="px-4 py-2 border border-neutral-600 text-neutral-200 text-sm font-medium rounded-lg hover:bg-neutral-800 transition-colors disabled:opacity-50"
                    >
                      {billingLoading === 'portal' ? t('upgrade.redirecting') : t('account.manageSubscription')}
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Settings */}
            <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-6">
              <div className="flex items-center gap-3 mb-4">
                <Settings className="text-brand-500" size={22} />
                <h2 className="text-lg font-bold text-white">{t('account.settings')}</h2>
              </div>
              <div className="space-y-4">
                <div>
                  <label className="block text-neutral-400 text-sm mb-1">{t('account.restaurantName')}</label>
                  <input
                    type="text"
                    value={editName}
                    onChange={e => setEditName(e.target.value)}
                    className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-4 py-2.5 text-white focus:outline-none focus:border-brand-500"
                  />
                </div>
                <div>
                  <label className="block text-neutral-400 text-sm mb-1">{t('account.email')}</label>
                  <input
                    type="email"
                    value={editEmail}
                    onChange={e => setEditEmail(e.target.value)}
                    className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-4 py-2.5 text-white focus:outline-none focus:border-brand-500"
                  />
                </div>
                <div className="flex items-center gap-3">
                  <button
                    onClick={handleSave}
                    disabled={saving || (editName === account.name && editEmail === account.email)}
                    className="px-5 py-2 bg-brand-600 text-white text-sm font-semibold rounded-lg hover:bg-brand-700 transition-colors disabled:opacity-50"
                  >
                    {saving ? t('account.saving') : t('account.saveChanges')}
                  </button>
                  {saveMsg && (
                    <span className="text-sm text-teal-400 flex items-center gap-1">
                      <Check size={14} /> {saveMsg}
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Change Password */}
            <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-6">
              <div className="flex items-center gap-3 mb-4">
                <Lock className="text-brand-500" size={22} />
                <h2 className="text-lg font-bold text-white">{t('account.changePassword')}</h2>
              </div>
              <form onSubmit={handlePasswordChange} className="space-y-4">
                <div>
                  <label className="block text-neutral-400 text-sm mb-1">{t('account.currentPassword')}</label>
                  <input
                    type="password"
                    value={currentPw}
                    onChange={e => setCurrentPw(e.target.value)}
                    className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-4 py-2.5 text-white focus:outline-none focus:border-brand-500"
                    required
                  />
                </div>
                <div>
                  <label className="block text-neutral-400 text-sm mb-1">{t('account.newPassword')}</label>
                  <input
                    type="password"
                    value={newPw}
                    onChange={e => setNewPw(e.target.value)}
                    className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-4 py-2.5 text-white focus:outline-none focus:border-brand-500"
                    required
                    minLength={8}
                  />
                </div>
                <div>
                  <label className="block text-neutral-400 text-sm mb-1">{t('account.confirmNewPassword')}</label>
                  <input
                    type="password"
                    value={confirmPw}
                    onChange={e => setConfirmPw(e.target.value)}
                    className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-4 py-2.5 text-white focus:outline-none focus:border-brand-500"
                    required
                    minLength={8}
                  />
                </div>
                {pwMsg && (
                  <div className={`flex items-center gap-2 text-sm ${pwMsg.type === 'success' ? 'text-teal-400' : 'text-red-400'}`}>
                    {pwMsg.type === 'success' ? <Check size={14} /> : <AlertCircle size={14} />}
                    {pwMsg.text}
                  </div>
                )}
                <button
                  type="submit"
                  disabled={pwSaving || !currentPw || !newPw || !confirmPw}
                  className="px-5 py-2 bg-brand-600 text-white text-sm font-semibold rounded-lg hover:bg-brand-700 transition-colors disabled:opacity-50"
                >
                  {pwSaving ? t('account.updating') : t('account.updatePassword')}
                </button>
              </form>
            </div>

            {/* Mercado Pago Point — Pro only */}
            {account.plan === 'pro' && (
              <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-6">
                <div className="flex items-center gap-3 mb-4">
                  <Smartphone className="text-brand-500" size={22} />
                  <h2 className="text-lg font-bold text-white">{t('account.mercadoPago')}</h2>
                </div>

                {(() => {
                  // Detect connection from URL param or account data
                  // We check the mp endpoint for fresh data
                  const mpUserId = (account as any).mp_user_id;
                  const isConnected = !!mpUserId;

                  if (!isConnected) {
                    return (
                      <div className="space-y-3">
                        <div className="flex items-center gap-2 text-neutral-400">
                          <WifiOff size={16} />
                          <span className="text-sm">{t('account.notConnected')}</span>
                        </div>
                        <p className="text-neutral-400 text-sm">
                          {t('account.mpConnectDesc')}
                        </p>
                        <button
                          onClick={async () => {
                            try {
                              const { auth_url } = await getMpConnectUrl();
                              window.location.href = auth_url;
                            } catch (err) {
                              console.error('MP connect failed', err);
                            }
                          }}
                          className="inline-flex items-center gap-2 px-5 py-2.5 bg-[#009ee3] text-white text-sm font-bold rounded-lg hover:bg-[#0082c0] transition-colors"
                        >
                          <Smartphone size={16} />
                          {t('account.connectMercadoPago')}
                        </button>
                      </div>
                    );
                  }

                  return (
                    <div className="space-y-4">
                      <div className="flex items-center gap-2">
                        <Wifi size={16} className="text-green-400" />
                        <span className="text-sm font-semibold text-green-400">{t('account.connected')}</span>
                        <span className="text-xs text-neutral-500 ml-2">ID: {mpUserId}</span>
                      </div>

                      <div>
                        <label className="block text-neutral-400 text-sm mb-1.5">{t('account.defaultTerminal')}</label>
                        <div className="flex items-center gap-2">
                          <select
                            value={mpDefaultTerminal || (account as any).mp_default_terminal_id || ''}
                            onChange={async (e) => {
                              const termId = e.target.value;
                              setMpDefaultTerminal(termId);
                              try {
                                await apiSetMpDefaultTerminal(termId);
                                setMpSaved(true);
                                setTimeout(() => setMpSaved(false), 2000);
                              } catch {
                                // ignore
                              }
                            }}
                            className="flex-1 bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-brand-500"
                          >
                            <option value="">{t('account.selectTerminal')}</option>
                            {mpTerminals.map(t => (
                              <option key={t.id} value={t.id}>
                                {t.external_pos_id || t.id}
                              </option>
                            ))}
                          </select>
                          <button
                            onClick={async () => {
                              setMpTerminalsLoading(true);
                              try {
                                const res = await getMpTerminals();
                                setMpTerminals(res.terminals);
                              } catch {
                                // ignore
                              }
                              setMpTerminalsLoading(false);
                            }}
                            disabled={mpTerminalsLoading}
                            className="px-3 py-2 bg-neutral-800 border border-neutral-700 text-neutral-300 text-sm rounded-lg hover:bg-neutral-700 transition-colors disabled:opacity-50"
                          >
                            {mpTerminalsLoading ? '...' : t('account.refresh')}
                          </button>
                        </div>
                        {mpSaved && (
                          <p className="text-teal-400 text-xs mt-1 flex items-center gap-1">
                            <Check size={12} /> {t('account.saved')}
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })()}
              </div>
            )}

            {/* Bank Connections — Pro+ only */}
            {isBankingPlan && (
              <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-6">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <Landmark className="text-green-500" size={22} />
                    <h2 className="text-lg font-bold text-white">{t('account.bankConnections')}</h2>
                  </div>
                  <button
                    onClick={() => setShowSecurityModal(true)}
                    className="inline-flex items-center gap-1.5 text-sm text-brand-400 hover:text-brand-300 transition-colors"
                  >
                    <Shield size={14} />
                    {t('account.learnBankSecurity')}
                  </button>
                </div>

                {/* Connection Slots */}
                <div className="flex items-center gap-2 mb-4">
                  <span className="text-sm text-neutral-400">
                    {t('account.connectionsUsed', { used: bankConnections.filter(c => c.status !== 'disconnected').length, max: maxBankConns })}
                  </span>
                  <div className="flex-1 bg-neutral-800 rounded-full h-1.5">
                    <div
                      className="h-1.5 rounded-full bg-green-500 transition-all"
                      style={{
                        width: `${Math.min(
                          (bankConnections.filter(c => c.status !== 'disconnected').length / Math.max(maxBankConns, 1)) * 100,
                          100
                        )}%`,
                      }}
                    />
                  </div>
                </div>

                {/* Connected Banks */}
                {bankLoading ? (
                  <div className="space-y-3">
                    {[1, 2].map(i => (
                      <div key={i} className="h-20 bg-neutral-800 rounded-lg animate-pulse" />
                    ))}
                  </div>
                ) : bankConnections.length > 0 ? (
                  <div className="space-y-3 mb-4">
                    {bankConnections.filter(c => c.status !== 'disconnected').map(conn => (
                      <BankConnectionCard
                        key={conn.id}
                        connection={conn}
                        accounts={bankAccounts}
                        onSync={async (id) => { await syncBankConnection(id); await loadBankData(); }}
                        onDisconnect={async (id) => { await deleteBankConnection(id); await loadBankData(); }}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="text-neutral-500 text-sm mb-4">{t('account.noBankAccounts')}</p>
                )}

                {/* Connect Button */}
                {bankConnections.filter(c => c.status !== 'disconnected').length < maxBankConns ? (
                  <ConnectBankButton onSuccess={loadBankData} />
                ) : (
                  <div className="relative group inline-block">
                    <button
                      disabled
                      className="inline-flex items-center gap-2 px-4 py-2.5 bg-neutral-800 text-neutral-500 font-semibold rounded-lg cursor-not-allowed"
                    >
                      {t('account.connectBank')}
                    </button>
                    <div className="absolute bottom-full left-0 mb-2 px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded-lg text-xs text-neutral-300 whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                      {t('account.connectionLimitReached', { max: maxBankConns, plan })}
                    </div>
                  </div>
                )}

                <SecurityInfoModal open={showSecurityModal} onClose={() => setShowSecurityModal(false)} />
              </div>
            )}

            {/* Data & Privacy */}
            <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-6">
              <div className="flex items-center gap-3 mb-4">
                <Shield className="text-brand-500" size={22} />
                <h2 className="text-lg font-bold text-white">{t('account.dataPrivacy')}</h2>
              </div>

              {/* Consent Status */}
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-neutral-400 text-sm">{t('account.financialDataAnalysis')}</p>
                    <p className="text-white text-sm font-medium mt-0.5">
                      {consentStatus?.consented ? (
                        <span className="text-green-400 flex items-center gap-1">
                          <Check size={14} /> {t('account.consented')}
                          {consentStatus.consent_at && (
                            <span className="text-neutral-500 font-normal ml-1">
                              ({new Date(consentStatus.consent_at).toLocaleDateString()})
                            </span>
                          )}
                        </span>
                      ) : (
                        <span className="text-neutral-500">{t('account.notConsented')}</span>
                      )}
                    </p>
                    {consentStatus?.consent_version && (
                      <p className="text-neutral-600 text-xs mt-0.5">{t('account.versionLabel', { version: consentStatus.consent_version })}</p>
                    )}
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  {/* View Terms */}
                  <button
                    onClick={async () => {
                      if (!consentTerms) {
                        try {
                          const result = await getFinancingConsentTerms('en');
                          setConsentTerms(result.consent);
                        } catch {}
                      }
                      setShowConsentTerms(true);
                    }}
                    className="inline-flex items-center gap-1.5 px-3 py-2 bg-neutral-800 border border-neutral-700 text-neutral-300 text-sm rounded-lg hover:bg-neutral-700 transition-colors"
                  >
                    <FileText size={14} /> {t('account.viewFullTerms')}
                  </button>

                  {/* Download Data */}
                  {consentStatus?.consented && (
                    <button
                      onClick={async () => {
                        setExportLoading(true);
                        try {
                          const data = await exportFinancingData();
                          const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
                          const url = URL.createObjectURL(blob);
                          const a = document.createElement('a');
                          a.href = url;
                          a.download = `financial-profile-${new Date().toISOString().slice(0, 10)}.json`;
                          a.click();
                          URL.revokeObjectURL(url);
                        } catch {}
                        setExportLoading(false);
                      }}
                      disabled={exportLoading}
                      className="inline-flex items-center gap-1.5 px-3 py-2 bg-neutral-800 border border-neutral-700 text-neutral-300 text-sm rounded-lg hover:bg-neutral-700 transition-colors disabled:opacity-50"
                    >
                      <Download size={14} /> {exportLoading ? t('account.exporting') : t('account.downloadMyData')}
                    </button>
                  )}

                  {/* Revoke Consent */}
                  {consentStatus?.consented && (
                    <button
                      onClick={() => setShowRevokeModal(true)}
                      className="inline-flex items-center gap-1.5 px-3 py-2 border border-red-800/50 text-red-400 text-sm rounded-lg hover:bg-red-900/20 transition-colors"
                    >
                      <ShieldOff size={14} /> {t('account.revokeConsent')}
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* View Terms Modal */}
            {showConsentTerms && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={() => setShowConsentTerms(false)}>
                <div className="bg-neutral-900 border border-neutral-700 rounded-xl max-w-lg w-full mx-4 max-h-[80vh] overflow-y-auto p-6" onClick={e => e.stopPropagation()}>
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-white font-bold text-lg">{t('account.dataProcessingTerms')}</h3>
                    <button onClick={() => setShowConsentTerms(false)} className="text-neutral-400 hover:text-white">
                      <X size={20} />
                    </button>
                  </div>
                  {consentTerms ? (
                    <div className="text-neutral-300 text-sm space-y-4">
                      <h4 className="text-white font-semibold">{consentTerms.title}</h4>
                      <p>{consentTerms.intro}</p>
                      {consentTerms.sections?.map((s: any, i: number) => (
                        <div key={i}>
                          <p className="text-white font-medium">{s.heading}</p>
                          <p className="text-neutral-400">{s.body}</p>
                        </div>
                      ))}
                      <div>
                        <p className="text-white font-medium">{consentTerms.dataWeAnalyze?.heading}:</p>
                        <ul className="list-disc pl-5 text-neutral-400 space-y-1">
                          {consentTerms.dataWeAnalyze?.items?.map((item: string, i: number) => <li key={i}>{item}</li>)}
                        </ul>
                      </div>
                      <div>
                        <p className="text-white font-medium">{consentTerms.dataWeDoNotAccess?.heading}:</p>
                        <ul className="list-disc pl-5 text-neutral-400 space-y-1">
                          {consentTerms.dataWeDoNotAccess?.items?.map((item: string, i: number) => <li key={i}>{item}</li>)}
                        </ul>
                      </div>
                      <div>
                        <p className="text-white font-medium">{consentTerms.rights?.heading}:</p>
                        <ul className="list-disc pl-5 text-neutral-400 space-y-1">
                          {consentTerms.rights?.items?.map((item: string, i: number) => <li key={i}>{item}</li>)}
                        </ul>
                        <p className="text-neutral-500 text-xs mt-2">{consentTerms.rights?.retention}</p>
                      </div>
                      <div>
                        <p className="text-white font-medium">{consentTerms.transfer?.heading}:</p>
                        <p className="text-neutral-400">{consentTerms.transfer?.body}</p>
                      </div>
                      <p className="text-neutral-500 text-xs">{t('account.consentVersion', { version: consentTerms.version })}</p>
                    </div>
                  ) : (
                    <p className="text-neutral-400">{t('account.loadingTerms')}</p>
                  )}
                </div>
              </div>
            )}

            {/* Revoke Consent Modal */}
            {showRevokeModal && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={() => setShowRevokeModal(false)}>
                <div className="bg-neutral-900 border border-neutral-700 rounded-xl max-w-md w-full mx-4 p-6 space-y-4" onClick={e => e.stopPropagation()}>
                  <h3 className="text-white font-bold text-lg">{t('account.revokeDataConsent')}</h3>
                  <div className="text-neutral-300 text-sm space-y-2">
                    <p>{t('account.revokeConfirm')}</p>
                    <ul className="list-disc pl-5 space-y-1 text-neutral-400">
                      <li>{t('account.revokeItem1')}</li>
                      <li>{t('account.revokeItem2')}</li>
                      <li>{t('account.revokeItem3')}</li>
                    </ul>
                    <p className="text-neutral-500 text-xs">{t('account.revokeRetention')}</p>
                  </div>
                  <div className="flex gap-3">
                    <button
                      onClick={async () => {
                        setRevokeLoading(true);
                        try {
                          await deleteFinancingConsent();
                          setConsentStatus({ consented: false });
                          setShowRevokeModal(false);
                        } catch {}
                        setRevokeLoading(false);
                      }}
                      disabled={revokeLoading}
                      className="flex-1 py-2.5 bg-red-600 text-white font-semibold rounded-lg hover:bg-red-700 transition-colors disabled:opacity-50"
                    >
                      {revokeLoading ? t('account.revoking') : t('account.revokeConsent')}
                    </button>
                    <button
                      onClick={() => setShowRevokeModal(false)}
                      className="px-6 py-2.5 border border-neutral-600 text-neutral-300 rounded-lg hover:bg-neutral-800 transition-colors"
                    >
                      {t('buttons.cancel')}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
