import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { checkAvailability, onboardClient, type OnboardResult } from '../../api/salesApi';

const STEPS = ['info', 'plan', 'branding', 'review', 'success'] as const;
type Step = (typeof STEPS)[number];

export default function SalesOnboardWizard() {
  const { t } = useTranslation('sales');
  const [step, setStep] = useState<Step>('info');
  const [form, setForm] = useState({
    restaurant_name: '',
    owner_name: '',
    owner_email: '',
    owner_phone: '',
    subdomain: '',
    plan: 'free',
    primaryColor: '#6366f1',
    generate_demo_data: false,
    financing_consent: false,
  });
  const [subdomainAvailable, setSubdomainAvailable] = useState<boolean | null>(null);
  const [checkingSubdomain, setCheckingSubdomain] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<OnboardResult | null>(null);
  const [copied, setCopied] = useState(false);

  const stepIndex = STEPS.indexOf(step);

  const handleCheckSubdomain = async () => {
    if (!form.subdomain.trim()) return;
    setCheckingSubdomain(true);
    try {
      const res = await checkAvailability({ subdomain: form.subdomain });
      setSubdomainAvailable(res.subdomain_available);
    } catch {
      setSubdomainAvailable(null);
    } finally {
      setCheckingSubdomain(false);
    }
  };

  const nextStep = () => {
    const idx = STEPS.indexOf(step);
    if (idx < STEPS.length - 1) setStep(STEPS[idx + 1]);
  };

  const prevStep = () => {
    const idx = STEPS.indexOf(step);
    if (idx > 0) setStep(STEPS[idx - 1]);
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    setError('');
    try {
      const res = await onboardClient({
        restaurant_name: form.restaurant_name,
        owner_name: form.owner_name,
        owner_email: form.owner_email,
        owner_phone: form.owner_phone || undefined,
        subdomain: form.subdomain,
        plan: form.plan,
        branding: { primaryColor: form.primaryColor },
        generate_demo_data: form.generate_demo_data,
        financing_consent: form.financing_consent,
      });
      setResult(res);
      setStep('success');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const update = (field: string, value: any) => setForm((prev) => ({ ...prev, [field]: value }));

  return (
    <div className="max-w-xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold text-white">{t('onboard.title')}</h1>

      {/* Step indicator */}
      <div className="flex gap-1">
        {STEPS.map((s, i) => (
          <div
            key={s}
            className={`flex-1 h-1.5 rounded-full transition ${
              i <= stepIndex ? 'bg-brand-600' : 'bg-neutral-800'
            }`}
          />
        ))}
      </div>
      <p className="text-sm text-neutral-400">
        {t(`onboard.steps.${step}`)}
      </p>

      {/* Step 1: Info */}
      {step === 'info' && (
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5 space-y-4">
          <div>
            <label className="block text-sm font-medium text-neutral-300 mb-1.5">
              {t('onboard.restaurantName')} *
            </label>
            <input
              type="text"
              value={form.restaurant_name}
              onChange={(e) => update('restaurant_name', e.target.value)}
              required
              className="w-full px-3 py-2.5 bg-neutral-800 border border-neutral-700 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-brand-600 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-neutral-300 mb-1.5">
              {t('onboard.ownerName')} *
            </label>
            <input
              type="text"
              value={form.owner_name}
              onChange={(e) => update('owner_name', e.target.value)}
              required
              className="w-full px-3 py-2.5 bg-neutral-800 border border-neutral-700 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-brand-600 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-neutral-300 mb-1.5">
              {t('onboard.ownerEmail')} *
            </label>
            <input
              type="email"
              value={form.owner_email}
              onChange={(e) => update('owner_email', e.target.value)}
              required
              className="w-full px-3 py-2.5 bg-neutral-800 border border-neutral-700 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-brand-600 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-neutral-300 mb-1.5">
              {t('onboard.ownerPhone')}
            </label>
            <input
              type="tel"
              value={form.owner_phone}
              onChange={(e) => update('owner_phone', e.target.value)}
              className="w-full px-3 py-2.5 bg-neutral-800 border border-neutral-700 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-brand-600 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-neutral-300 mb-1.5">
              {t('onboard.subdomain')} *
            </label>
            <div className="flex gap-2">
              <div className="flex-1 relative">
                <input
                  type="text"
                  value={form.subdomain}
                  onChange={(e) => {
                    update('subdomain', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''));
                    setSubdomainAvailable(null);
                  }}
                  required
                  placeholder="my-restaurant"
                  className="w-full px-3 py-2.5 bg-neutral-800 border border-neutral-700 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-brand-600 text-sm"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-neutral-500">
                  .desktop.kitchen
                </span>
              </div>
              <button
                type="button"
                onClick={handleCheckSubdomain}
                disabled={!form.subdomain || checkingSubdomain}
                className="px-3 py-2 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 text-sm rounded-lg transition disabled:opacity-50"
              >
                {checkingSubdomain ? '...' : 'Check'}
              </button>
            </div>
            {subdomainAvailable !== null && (
              <p className={`text-xs mt-1 ${subdomainAvailable ? 'text-green-400' : 'text-red-400'}`}>
                {subdomainAvailable ? 'Available' : 'Already taken'}
              </p>
            )}
          </div>

          <div className="flex justify-end pt-2">
            <button
              onClick={nextStep}
              disabled={!form.restaurant_name || !form.owner_name || !form.owner_email || !form.subdomain}
              className="px-5 py-2 bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Next
            </button>
          </div>
        </div>
      )}

      {/* Step 2: Plan */}
      {step === 'plan' && (
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5 space-y-4">
          <label className="block text-sm font-medium text-neutral-300 mb-3">
            {t('onboard.selectPlan')}
          </label>
          <div className="space-y-2">
            {['free', 'pro'].map((plan) => (
              <label
                key={plan}
                className={`flex items-center gap-3 p-4 rounded-lg border cursor-pointer transition ${
                  form.plan === plan
                    ? 'border-brand-600 bg-brand-600/10'
                    : 'border-neutral-800 hover:border-neutral-700'
                }`}
              >
                <input
                  type="radio"
                  name="plan"
                  value={plan}
                  checked={form.plan === plan}
                  onChange={(e) => update('plan', e.target.value)}
                  className="accent-brand-600"
                />
                <div>
                  <p className="text-sm font-medium text-white capitalize">{plan}</p>
                  <p className="text-xs text-neutral-500">
                    {plan === 'free'
                      ? '50 items, 3 employees, 1 printer'
                      : 'Unlimited everything - $20/mo'}
                  </p>
                </div>
              </label>
            ))}
          </div>

          <div className="flex justify-between pt-2">
            <button
              onClick={prevStep}
              className="px-5 py-2 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 text-sm font-medium rounded-lg transition"
            >
              Back
            </button>
            <button
              onClick={nextStep}
              className="px-5 py-2 bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium rounded-lg transition"
            >
              Next
            </button>
          </div>
        </div>
      )}

      {/* Step 3: Branding */}
      {step === 'branding' && (
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5 space-y-4">
          <div>
            <label className="block text-sm font-medium text-neutral-300 mb-1.5">
              {t('onboard.primaryColor')}
            </label>
            <div className="flex items-center gap-3">
              <input
                type="color"
                value={form.primaryColor}
                onChange={(e) => update('primaryColor', e.target.value)}
                className="w-10 h-10 bg-transparent border-0 cursor-pointer rounded"
              />
              <input
                type="text"
                value={form.primaryColor}
                onChange={(e) => update('primaryColor', e.target.value)}
                placeholder="#6366f1"
                className="w-32 px-3 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-brand-600"
              />
              <div
                className="w-10 h-10 rounded-lg border border-neutral-700"
                style={{ backgroundColor: form.primaryColor }}
              />
            </div>
          </div>

          <div className="flex justify-between pt-2">
            <button
              onClick={prevStep}
              className="px-5 py-2 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 text-sm font-medium rounded-lg transition"
            >
              Back
            </button>
            <button
              onClick={nextStep}
              className="px-5 py-2 bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium rounded-lg transition"
            >
              Next
            </button>
          </div>
        </div>
      )}

      {/* Step 4: Review */}
      {step === 'review' && (
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5 space-y-4">
          <h3 className="text-sm font-semibold text-neutral-300 uppercase tracking-wide">
            {t('onboard.review')}
          </h3>

          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-neutral-500">{t('onboard.restaurantName')}</span>
              <span className="text-white">{form.restaurant_name}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-neutral-500">{t('onboard.ownerName')}</span>
              <span className="text-white">{form.owner_name}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-neutral-500">{t('onboard.ownerEmail')}</span>
              <span className="text-white">{form.owner_email}</span>
            </div>
            {form.owner_phone && (
              <div className="flex justify-between">
                <span className="text-neutral-500">{t('onboard.ownerPhone')}</span>
                <span className="text-white">{form.owner_phone}</span>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-neutral-500">{t('onboard.subdomain')}</span>
              <span className="text-white">{form.subdomain}.desktop.kitchen</span>
            </div>
            <div className="flex justify-between">
              <span className="text-neutral-500">{t('onboard.selectPlan')}</span>
              <span className="text-white capitalize">{form.plan}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-neutral-500">{t('onboard.primaryColor')}</span>
              <div className="flex items-center gap-2">
                <div
                  className="w-4 h-4 rounded border border-neutral-700"
                  style={{ backgroundColor: form.primaryColor }}
                />
                <span className="text-white">{form.primaryColor}</span>
              </div>
            </div>
          </div>

          <label className="flex items-center gap-2 pt-2 cursor-pointer">
            <input
              type="checkbox"
              checked={form.generate_demo_data}
              onChange={(e) => update('generate_demo_data', e.target.checked)}
              className="accent-brand-600"
            />
            <span className="text-sm text-neutral-300">{t('onboard.generateDemoData')}</span>
          </label>

          {/* Financing data consent */}
          <div className="mt-3 p-3 bg-amber-900/10 border border-amber-700/30 rounded-lg">
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={form.financing_consent}
                onChange={(e) => update('financing_consent', e.target.checked)}
                className="accent-amber-500 mt-0.5"
              />
              <div>
                <span className="text-sm text-neutral-200">{t('onboard.financingConsent')}</span>
                <p className="text-xs text-neutral-500 mt-1">{t('onboard.financingConsentNote')}</p>
              </div>
            </label>
          </div>

          {error && (
            <div className="text-red-400 text-sm bg-red-900/20 border border-red-800 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <div className="flex justify-between pt-2">
            <button
              onClick={prevStep}
              className="px-5 py-2 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 text-sm font-medium rounded-lg transition"
            >
              Back
            </button>
            <button
              onClick={handleSubmit}
              disabled={submitting}
              className="px-5 py-2 bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium rounded-lg transition disabled:opacity-50"
            >
              {submitting ? t('onboard.creating') : t('onboard.review')}
            </button>
          </div>
        </div>
      )}

      {/* Step 5: Success */}
      {step === 'success' && result && (
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5 space-y-5">
          <div className="text-center">
            <div className="w-12 h-12 mx-auto mb-3 bg-green-500/20 rounded-full flex items-center justify-center">
              <svg className="w-6 h-6 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h3 className="text-lg font-semibold text-white">{t('onboard.success')}</h3>
          </div>

          <div className="space-y-3 text-sm">
            <div>
              <label className="text-neutral-500 text-xs">{t('onboard.loginUrl')}</label>
              <div className="flex items-center gap-2 mt-1">
                <code className="flex-1 bg-neutral-800 px-3 py-2 rounded-lg text-brand-400 text-xs break-all">
                  {result.login_url}
                </code>
                <button
                  onClick={() => handleCopy(result.login_url)}
                  className="px-3 py-2 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 text-xs rounded-lg transition"
                >
                  {copied ? 'Copied!' : t('onboard.copyLink')}
                </button>
              </div>
            </div>

            <div>
              <label className="text-neutral-500 text-xs">{t('onboard.pin')}</label>
              <p className="mt-1 bg-neutral-800 px-3 py-2 rounded-lg text-white font-mono text-lg tracking-widest">
                {result.pin}
              </p>
            </div>

            <div>
              <label className="text-neutral-500 text-xs">Owner Password</label>
              <p className="mt-1 bg-neutral-800 px-3 py-2 rounded-lg text-white font-mono text-sm">
                {result.owner_password}
              </p>
            </div>

            <div>
              <label className="text-neutral-500 text-xs">Tenant ID</label>
              <p className="mt-1 bg-neutral-800 px-3 py-2 rounded-lg text-neutral-300 text-xs">
                {result.tenant_id}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
