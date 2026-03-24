/**
 * Desktop Kitchen — Frictionless Onboarding v2
 *
 * KEY UX CHANGES vs original:
 * 1. Collapsed from 3 steps to 1 visible step + smart progressive disclosure
 * 2. Branding step removed from critical path (set later in Settings)
 * 3. Plan selection defaults to Free Trial with zero friction — no decision required
 * 4. Promo code auto-applied from URL param with instant visual feedback
 * 5. Password replaced by magic link / PIN-email flow (no confirm-password field)
 * 6. Auto-focus and Enter-key support throughout
 * 7. Real-time field validation (not on-submit)
 * 8. Success step shows PIN prominently and deeplinks directly into POS
 */

import React, { useState, useEffect, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Check, ArrowRight, Loader2, Tag, X, Sparkles, ChefHat, ChevronRight, LogIn, KeyRound } from 'lucide-react';
import { useBranding } from '../context/BrandingContext';
import { redirectToTenant, tenantUrl } from '../lib/tenantResolver';
import { validatePromoCode, getMenuTemplates, applyMenuTemplateAsOwner, parseMenuWithAIAsOwner, commitAIMenuAsOwner } from '../api';
import type { MenuTemplateOption, MenuImportStats, AIMenuParseResult } from '../types';

const API_BASE = '/api';

/* ─── Types ─────────────────────────────────────────────────────────────── */
type PromoState = 'idle' | 'expanded' | 'loading' | 'valid' | 'invalid';

interface FormData {
  restaurant_name: string;
  email: string;
  password: string;
}

interface FieldErrors {
  restaurant_name?: string;
  email?: string;
  password?: string;
}

/* ─── Helpers ────────────────────────────────────────────────────────────── */
const validateEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

/* ─── Component ──────────────────────────────────────────────────────────── */
const OnboardingScreen: React.FC = () => {
  const { t } = useTranslation('common');
  const navigate = useNavigate();
  const location = useLocation();
  const { refresh: refreshBranding } = useBranding();

  // Form state
  const [form, setForm] = useState<FormData>({ restaurant_name: '', email: '', password: '' });
  const [financingConsent, setFinancingConsent] = useState(false);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState('');
  const [emailConflict, setEmailConflict] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Post-registration
  const [generatedPin, setGeneratedPin] = useState('');
  const [tenantSubdomain, setTenantSubdomain] = useState('');
  const [isDone, setIsDone] = useState(false);
  const [pinCopied, setPinCopied] = useState(false);

  // Template setup (post-registration flow)
  type PostStep = 'success' | 'template' | 'applying' | 'done' | 'ai-input' | 'ai-parsing' | 'ai-done';
  const [postStep, setPostStep] = useState<PostStep>('success');
  const [templates, setTemplates] = useState<MenuTemplateOption[]>([]);
  const [templateLoading, setTemplateLoading] = useState(false);
  const [templateStats, setTemplateStats] = useState<MenuImportStats | null>(null);
  const [ownerToken, setOwnerToken] = useState('');
  const [aiText, setAiText] = useState('');
  const [aiError, setAiError] = useState('');

  // Promo
  const [promoState, setPromoState] = useState<PromoState>('idle');
  const [promoInput, setPromoInput] = useState('');
  const [promoCode, setPromoCode] = useState('');
  const [promoDescription, setPromoDescription] = useState('');
  const [promoError, setPromoError] = useState('');

  const nameRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  /* URL param pre-fill + promo auto-apply */
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const urlPromo = params.get('promo_code');
    const urlName = params.get('restaurant_name');
    const urlEmail = params.get('email');

    if (urlName) setForm(p => ({ ...p, restaurant_name: urlName }));
    if (urlEmail) setForm(p => ({ ...p, email: urlEmail }));

    if (urlPromo) {
      const code = urlPromo.trim().toUpperCase();
      setPromoInput(code);
      setPromoCode(code);
      setPromoState('valid');
      setPromoDescription(t('onboarding.discountFromCampaign'));
    }

    // Auto-focus first empty field
    setTimeout(() => nameRef.current?.focus(), 100);
  }, []);

  /* Real-time validation */
  const validateField = (name: keyof FormData, value: string): string => {
    if (name === 'restaurant_name') return value.trim() ? '' : t('onboarding.required');
    if (name === 'email') return validateEmail(value) ? '' : t('onboarding.validEmail');
    if (name === 'password') return value.length >= 8 ? '' : t('onboarding.atLeast8Chars');
    return '';
  };

  const handleChange = (name: keyof FormData, value: string) => {
    setForm(p => ({ ...p, [name]: value }));
    setSubmitError('');
    setEmailConflict(false);
    if (touched[name]) {
      setFieldErrors(p => ({ ...p, [name]: validateField(name, value) }));
    }
  };

  const handleBlur = (name: keyof FormData) => {
    setTouched(p => ({ ...p, [name]: true }));
    setFieldErrors(p => ({ ...p, [name]: validateField(name, form[name]) }));
  };

  /* Promo */
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
        setPromoDescription(result.discount_description || t('onboarding.discountApplied'));
      } else {
        setPromoState('invalid');
        setPromoError(result.message || t('onboarding.invalidCode'));
      }
    } catch {
      setPromoState('invalid');
      setPromoError(t('onboarding.errorValidatingCode'));
    }
  };

  const handleRemovePromo = () => {
    setPromoState('idle');
    setPromoInput('');
    setPromoCode('');
    setPromoDescription('');
    setPromoError('');
  };

  /* Submit */
  const isFormValid = () => {
    return (
      form.restaurant_name.trim() &&
      validateEmail(form.email) &&
      form.password.length >= 8
    );
  };

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();

    // Touch all fields to show any errors
    const allTouched = { restaurant_name: true, email: true, password: true };
    setTouched(allTouched);
    const errors: FieldErrors = {
      restaurant_name: validateField('restaurant_name', form.restaurant_name),
      email: validateField('email', form.email),
      password: validateField('password', form.password),
    };
    setFieldErrors(errors);
    if (Object.values(errors).some(Boolean)) return;

    setIsSubmitting(true);
    setSubmitError('');

    try {
      const body: Record<string, string | boolean> = {
        email: form.email,
        password: form.password,
        restaurant_name: form.restaurant_name,
      };
      if (promoCode) body.promo_code = promoCode;
      if (financingConsent) body.financing_consent = true;

      const res = await fetch(`${API_BASE}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const result = await res.json();
      if (!res.ok) {
        if (res.status === 409 && result.code === 'EMAIL_EXISTS') {
          setEmailConflict(true);
          setSubmitError(result.error);
          setIsSubmitting(false);
          return;
        }
        throw new Error(result.error || t('onboarding.registrationFailed'));
      }

      if (result.pin) setGeneratedPin(result.pin);
      if (result.tenant?.subdomain) setTenantSubdomain(result.tenant.subdomain);
      localStorage.setItem('owner_token', result.token);
      localStorage.setItem('tenant_id', result.tenant.id);
      localStorage.setItem('tenant_name', result.tenant.name);
      setOwnerToken(result.token);

      await refreshBranding();
      setIsDone(true);
      setPostStep('success');
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : t('onboarding.somethingWentWrong'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleGoToPOS = () => {
    if (tenantSubdomain) {
      redirectToTenant(tenantSubdomain);
    } else {
      navigate('/');
    }
  };

  const handleCopyPin = () => {
    navigator.clipboard.writeText(generatedPin).then(() => {
      setPinCopied(true);
      setTimeout(() => setPinCopied(false), 2000);
    });
  };

  const TEMPLATE_ICONS: Record<string, string> = {
    taco: '\uD83C\uDF2E', burger: '\uD83C\uDF54', pizza: '\uD83C\uDF55',
    coffee: '\u2615', sushi: '\uD83C\uDF63', restaurant: '\uD83C\uDF7D\uFE0F',
  };

  const handleSetupMenu = async () => {
    setPostStep('template');
    setTemplateLoading(true);
    try {
      const list = await getMenuTemplates();
      setTemplates(list);
    } catch {
      // fail silently, show empty
    } finally {
      setTemplateLoading(false);
    }
  };

  const handlePickTemplate = async (tmpl: MenuTemplateOption) => {
    setPostStep('applying');
    try {
      const token = ownerToken || localStorage.getItem('owner_token') || '';
      const result = await applyMenuTemplateAsOwner(tmpl.id, token, 'replace');
      setTemplateStats(result);
      setPostStep('done');
      setTimeout(handleGoToPOS, 2500);
    } catch {
      // on error, go to POS anyway
      handleGoToPOS();
    }
  };

  const handleAIBuild = async () => {
    if (!aiText.trim()) return;
    setPostStep('ai-parsing');
    setAiError('');
    try {
      const token = ownerToken || localStorage.getItem('owner_token') || '';
      const parsed = await parseMenuWithAIAsOwner(aiText.trim(), token);
      if (!parsed.success || !parsed.data) {
        setAiError(parsed.error || 'Could not parse menu');
        setPostStep('ai-input');
        return;
      }
      const result = await commitAIMenuAsOwner(parsed.data, token, 'replace');
      setTemplateStats(result);
      setPostStep('ai-done');
      setTimeout(handleGoToPOS, 2500);
    } catch (err) {
      setAiError(err instanceof Error ? err.message : t('onboarding.somethingWentWrong'));
      setPostStep('ai-input');
    }
  };

  /* ── Render: Success ──────────────────────────────────────────────── */
  if (isDone) {
    return (
      <div style={styles.root}>
        <div style={styles.card}>
          {/* Step: Success — show PIN + menu setup buttons */}
          {postStep === 'success' && (
            <>
              <div style={styles.successIcon}>
                <Check size={32} color="#fff" strokeWidth={3} />
              </div>
              <h1 style={styles.successTitle}>{t('onboarding.youreLive')}</h1>
              <p style={styles.successSub}>
                <strong style={{ color: '#f0fdf4' }}>{form.restaurant_name}</strong> {t('onboarding.readyToTakeOrders')}
              </p>

              <div style={styles.pinBlock}>
                <p style={styles.pinLabel}>{t('onboarding.staffLoginPin')}</p>
                <div style={styles.pinRow}>
                  {(generatedPin || '----').split('').map((d, i) => (
                    <div key={i} style={styles.pinDigit}>{d}</div>
                  ))}
                </div>
                <button style={styles.copyBtn} onClick={handleCopyPin}>
                  {pinCopied ? <><Check size={13} /> {t('onboarding.copied')}</> : t('onboarding.copyPin')}
                </button>
                <p style={styles.pinHint}>
                  {t('onboarding.alsoSentTo')} <span style={{ color: '#86efac' }}>{form.email}</span>
                </p>
              </div>

              {tenantSubdomain && (
                <div style={styles.urlBlock}>
                  <p style={styles.urlLabel}>{t('onboarding.posUrl')}</p>
                  <p style={styles.urlValue}>{tenantUrl(tenantSubdomain).replace('https://', '')}</p>
                </div>
              )}

              <button style={styles.primaryBtn} onClick={handleSetupMenu}>
                <Sparkles size={16} /> {t('onboarding.setUpMenu')}
              </button>
              <button
                style={{ ...styles.primaryBtn, background: 'transparent', border: '1px solid #333', color: '#9ca3af', marginTop: 8 }}
                onClick={handleGoToPOS}
              >
                {t('onboarding.skipForNow')} <ArrowRight size={16} />
              </button>
            </>
          )}

          {/* Step: Template picker */}
          {postStep === 'template' && (
            <>
              <h1 style={{ ...styles.successTitle, fontSize: 22, marginBottom: 4 }}>{t('onboarding.whatType')}</h1>
              <p style={{ ...styles.successSub, marginBottom: 20 }}>
                {t('onboarding.pickTemplate')}
              </p>

              {templateLoading ? (
                <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
                  <Loader2 size={28} color="#0d9488" style={styles.spin} />
                </div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  {templates.map(tmpl => (
                    <button
                      key={tmpl.id}
                      onClick={() => handlePickTemplate(tmpl)}
                      style={{
                        background: '#1a1a1a',
                        border: '1px solid #2a2a2a',
                        borderRadius: 12,
                        padding: '14px 12px',
                        textAlign: 'left',
                        cursor: 'pointer',
                        transition: 'border-color 0.15s',
                      }}
                      onMouseEnter={e => (e.currentTarget.style.borderColor = '#0d9488')}
                      onMouseLeave={e => (e.currentTarget.style.borderColor = '#2a2a2a')}
                    >
                      <div style={{ fontSize: 28, marginBottom: 6 }}>{TEMPLATE_ICONS[tmpl.icon] || '\uD83C\uDF7D\uFE0F'}</div>
                      <div style={{ color: '#fff', fontSize: 14, fontWeight: 600, marginBottom: 2 }}>{tmpl.name}</div>
                      <div style={{ color: '#6b7280', fontSize: 11 }}>{tmpl.item_count} {t('onboarding.items')} &middot; {tmpl.category_count} {t('onboarding.categories')}</div>
                    </button>
                  ))}
                </div>
              )}

              <button
                onClick={() => { setPostStep('ai-input'); setAiText(''); setAiError(''); }}
                style={{ width: '100%', background: 'none', border: 'none', color: '#0d9488', cursor: 'pointer', fontSize: 13, padding: '10px 0 2px', fontWeight: 500, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
              >
                <Sparkles size={13} /> {t('onboarding.orDescribeMenu')}
              </button>

              <button
                style={{ ...styles.primaryBtn, background: 'transparent', border: '1px solid #333', color: '#9ca3af', marginTop: 12 }}
                onClick={handleGoToPOS}
              >
                {t('onboarding.skip')} <ArrowRight size={14} />
              </button>
            </>
          )}

          {/* Step: AI input */}
          {postStep === 'ai-input' && (
            <>
              <h1 style={{ ...styles.successTitle, fontSize: 22, marginBottom: 4 }}>{t('onboarding.describeMenu')}</h1>
              <p style={{ ...styles.successSub, marginBottom: 16 }}>
                {t('onboarding.pasteMenu')}
              </p>

              <textarea
                value={aiText}
                onChange={e => { setAiText(e.target.value); setAiError(''); }}
                placeholder="Somos una taqueria con tacos de asada, pastor, chorizo..."
                style={{
                  width: '100%', minHeight: 120, padding: '12px 14px',
                  background: '#0a0a0a', border: '1px solid #2a2a2a', borderRadius: 12,
                  color: '#fff', fontSize: 14, resize: 'vertical', outline: 'none',
                  boxSizing: 'border-box', fontFamily: 'inherit',
                }}
                maxLength={10000}
                autoFocus
              />
              <div style={{ color: '#6b7280', fontSize: 11, textAlign: 'right', marginTop: 4, marginBottom: 8 }}>
                {aiText.length.toLocaleString()} / 10,000
              </div>

              {aiError && (
                <div style={{ ...styles.errorBox, marginBottom: 12 }}>{aiError}</div>
              )}

              <button
                style={{ ...styles.primaryBtn, opacity: aiText.trim() ? 1 : 0.4, cursor: aiText.trim() ? 'pointer' : 'not-allowed' }}
                onClick={handleAIBuild}
                disabled={!aiText.trim()}
              >
                <Sparkles size={16} /> {t('onboarding.buildMyMenu')}
              </button>
              <button
                style={{ ...styles.primaryBtn, background: 'transparent', border: '1px solid #333', color: '#9ca3af', marginTop: 8 }}
                onClick={() => setPostStep('template')}
              >
                {t('onboarding.backToTemplates')}
              </button>
            </>
          )}

          {/* Step: AI parsing */}
          {postStep === 'ai-parsing' && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '48px 0' }}>
              <Loader2 size={36} color="#0d9488" style={styles.spin} />
              <p style={{ color: '#9ca3af', fontSize: 14, marginTop: 16 }}>{t('onboarding.buildingMenu')}</p>
            </div>
          )}

          {/* Step: AI done */}
          {postStep === 'ai-done' && templateStats && (
            <div style={{ textAlign: 'center' }}>
              <div style={styles.successIcon}>
                <Check size={32} color="#fff" strokeWidth={3} />
              </div>
              <h1 style={{ ...styles.successTitle, fontSize: 22 }}>{t('onboarding.menuCreated')}</h1>
              <p style={{ color: '#9ca3af', fontSize: 14, marginBottom: 16 }}>
                {templateStats.itemsCreated} {t('onboarding.items')}, {templateStats.categoriesCreated} {t('onboarding.categories')}
                {templateStats.inventoryCreated > 0 && `, ${templateStats.inventoryCreated} ${t('onboarding.ingredients')}`}
              </p>
              <button style={styles.primaryBtn} onClick={handleGoToPOS}>
                {t('onboarding.openMyPos')} <ArrowRight size={16} />
              </button>
            </div>
          )}

          {/* Step: Applying template */}
          {postStep === 'applying' && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '48px 0' }}>
              <Loader2 size={36} color="#0d9488" style={styles.spin} />
              <p style={{ color: '#9ca3af', fontSize: 14, marginTop: 16 }}>{t('onboarding.creatingMenu')}</p>
            </div>
          )}

          {/* Step: Done — brief stats then auto-redirect */}
          {postStep === 'done' && templateStats && (
            <div style={{ textAlign: 'center' }}>
              <div style={styles.successIcon}>
                <Check size={32} color="#fff" strokeWidth={3} />
              </div>
              <h1 style={{ ...styles.successTitle, fontSize: 22 }}>{t('onboarding.menuCreated')}</h1>
              <p style={{ color: '#9ca3af', fontSize: 14, marginBottom: 16 }}>
                {templateStats.itemsCreated} {t('onboarding.items')}, {templateStats.categoriesCreated} {t('onboarding.categories')}
                {templateStats.inventoryCreated > 0 && `, ${templateStats.inventoryCreated} ${t('onboarding.ingredients')}`}
              </p>
              <button style={styles.primaryBtn} onClick={handleGoToPOS}>
                {t('onboarding.openMyPos')} <ArrowRight size={16} />
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  /* ── Render: Form ─────────────────────────────────────────────────── */
  return (
    <div style={styles.root}>
      {/* Background grain */}
      <div style={styles.grain} />

      <div style={styles.card}>
        {/* Header */}
        <div style={styles.header}>
          <div style={styles.logoMark}>
            <ChefHat size={22} color="#0d9488" />
          </div>
          <span style={styles.logoText}>Desktop Kitchen</span>
        </div>

        <h1 style={styles.title}>{t('onboarding.getStarted')}</h1>
        <p style={styles.subtitle}>
          {t('onboarding.freeForDays')}
        </p>

        <form onSubmit={handleSubmit} style={styles.form} noValidate>
          {/* Restaurant name */}
          <Field
            label={t('onboarding.restaurantName')}
            placeholder="e.g. Tacos El Rey"
            value={form.restaurant_name}
            inputRef={nameRef}
            error={fieldErrors.restaurant_name}
            onChange={v => handleChange('restaurant_name', v)}
            onBlur={() => handleBlur('restaurant_name')}
            onEnter={() => emailRef.current?.focus()}
            autoCapitalize="words"
          />

          {/* Email */}
          <Field
            label={t('onboarding.ownerEmail')}
            type="email"
            placeholder="you@restaurant.com"
            value={form.email}
            inputRef={emailRef}
            error={fieldErrors.email}
            onChange={v => handleChange('email', v)}
            onBlur={() => handleBlur('email')}
            onEnter={() => passwordRef.current?.focus()}
          />

          {/* Password */}
          <Field
            label={t('onboarding.password')}
            type="password"
            placeholder={t('onboarding.minChars')}
            value={form.password}
            inputRef={passwordRef}
            error={fieldErrors.password}
            onChange={v => handleChange('password', v)}
            onBlur={() => handleBlur('password')}
            onEnter={handleSubmit}
          />

          {/* Financing consent — optional */}
          <div style={{ marginBottom: 16, background: 'rgba(13,148,136,0.06)', border: '1px solid rgba(13,148,136,0.15)', borderRadius: 10, padding: '14px 14px 12px' }}>
            <p style={{ color: '#d1d5db', fontSize: 13, fontWeight: 600, margin: '0 0 4px' }}>{t('onboarding.workingCapital')}</p>
            <p style={{ color: '#6b7280', fontSize: 12, margin: '0 0 10px' }}>{t('onboarding.workingCapitalDesc')}</p>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={financingConsent}
                onChange={e => setFinancingConsent(e.target.checked)}
                style={{ marginTop: 2, accentColor: '#0d9488' }}
              />
              <span style={{ color: '#9ca3af', fontSize: 12 }}>{t('onboarding.agreeDataAnalysis')}</span>
            </label>
          </div>

          {/* Promo code — collapsed by default */}
          <PromoSection
            state={promoState}
            input={promoInput}
            code={promoCode}
            description={promoDescription}
            error={promoError}
            onExpand={() => setPromoState('expanded')}
            onInputChange={v => {
              setPromoInput(v.toUpperCase());
              if (promoState === 'invalid') { setPromoState('expanded'); setPromoError(''); }
            }}
            onValidate={handleValidatePromo}
            onRemove={handleRemovePromo}
          />

          {/* Submit error */}
          {emailConflict ? (
            <div style={styles.conflictBox}>
              <p style={styles.conflictText}>{t('onboarding.emailExists')}</p>
              <div style={styles.conflictActions}>
                <button
                  type="button"
                  style={styles.conflictPrimaryBtn}
                  onClick={() => navigate(`/?email=${encodeURIComponent(form.email)}`)}
                >
                  <LogIn size={14} /> {t('onboarding.logInToAccount')}
                </button>
                <button
                  type="button"
                  style={styles.conflictSecondaryBtn}
                  onClick={() => navigate(`/?email=${encodeURIComponent(form.email)}&view=forgot`)}
                >
                  <KeyRound size={14} /> {t('onboarding.resetYourPassword')}
                </button>
              </div>
            </div>
          ) : submitError ? (
            <div style={styles.errorBox}>{submitError}</div>
          ) : null}

          {/* CTA */}
          <button
            type="submit"
            style={{
              ...styles.primaryBtn,
              opacity: isSubmitting ? 0.7 : 1,
              cursor: isSubmitting ? 'wait' : 'pointer',
              marginTop: 8,
            }}
            disabled={isSubmitting}
          >
            {isSubmitting
              ? <><Loader2 size={16} style={styles.spin} /> {t('onboarding.creatingAccount')}</>
              : <><Sparkles size={16} /> {t('onboarding.createFreeAccount')}</>
            }
          </button>
        </form>

        {/* Trust signals */}
        <div style={styles.trustRow}>
          {[t('onboarding.freeForever'), t('onboarding.noCreditCard'), t('onboarding.upgradeAnytime')].map(chip => (
            <span key={chip} style={styles.trustChip}>
              <Check size={10} color="#0d9488" strokeWidth={3} style={{ flexShrink: 0 }} />
              {chip}
            </span>
          ))}
        </div>

        {/* Login link */}
        <p style={styles.loginLink}>
          {t('onboarding.alreadyHaveAccount')}{' '}
          <button style={styles.link} onClick={() => navigate('/')}>{t('onboarding.logIn')}</button>
        </p>
      </div>
    </div>
  );
};

/* ─── Field sub-component ────────────────────────────────────────────────── */
interface FieldProps {
  label: string;
  type?: string;
  placeholder?: string;
  value: string;
  inputRef?: React.RefObject<HTMLInputElement>;
  error?: string;
  onChange: (v: string) => void;
  onBlur: () => void;
  onEnter?: () => void;
  autoCapitalize?: string;
}

const Field: React.FC<FieldProps> = ({
  label, type = 'text', placeholder, value, inputRef, error, onChange, onBlur, onEnter, autoCapitalize,
}) => {
  const [focused, setFocused] = useState(false);

  return (
    <div style={{ marginBottom: 16 }}>
      <label style={styles.label}>{label}</label>
      <input
        ref={inputRef}
        type={type}
        value={value}
        placeholder={placeholder}
        autoCapitalize={autoCapitalize}
        autoComplete={type === 'password' ? 'new-password' : type === 'email' ? 'email' : 'organization'}
        onChange={e => onChange(e.target.value)}
        onBlur={() => { setFocused(false); onBlur(); }}
        onFocus={() => setFocused(true)}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); onEnter?.(); } }}
        style={{
          ...styles.input,
          borderColor: error ? '#f87171' : focused ? '#0d9488' : '#2a2a2a',
          boxShadow: focused ? '0 0 0 3px rgba(13,148,136,0.15)' : 'none',
        }}
      />
      {error && <p style={styles.fieldError}>{error}</p>}
    </div>
  );
};

/* ─── PromoSection sub-component ─────────────────────────────────────────── */
interface PromoSectionProps {
  state: PromoState;
  input: string;
  code: string;
  description: string;
  error: string;
  onExpand: () => void;
  onInputChange: (v: string) => void;
  onValidate: () => void;
  onRemove: () => void;
}

const PromoSection: React.FC<PromoSectionProps> = ({
  state, input, code, description, error, onExpand, onInputChange, onValidate, onRemove,
}) => {
  const { t } = useTranslation('common');

  if (state === 'valid') {
    return (
      <div style={styles.promoValid}>
        <Tag size={13} color="#4ade80" />
        <span style={{ color: '#4ade80', fontWeight: 700, fontSize: 13 }}>{code}</span>
        <span style={{ color: '#86efac', fontSize: 13, flex: 1 }}>— {description}</span>
        <button style={styles.iconBtn} onClick={onRemove}><X size={13} /></button>
      </div>
    );
  }

  if (state === 'idle') {
    return (
      <button type="button" style={styles.promoToggle} onClick={onExpand}>
        <Tag size={12} /> {t('onboarding.havePromo')}
      </button>
    );
  }

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={styles.promoRow}>
        <input
          autoFocus
          type="text"
          value={input}
          placeholder={t('onboarding.enterCode')}
          onChange={e => onInputChange(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); onValidate(); } }}
          style={{ ...styles.input, flex: 1, marginBottom: 0, letterSpacing: '0.1em', fontSize: 13 }}
          disabled={state === 'loading'}
        />
        <button
          type="button"
          onClick={onValidate}
          disabled={state === 'loading' || !input.trim()}
          style={styles.promoApplyBtn}
        >
          {state === 'loading' ? <Loader2 size={13} style={styles.spin} /> : t('buttons.apply')}
        </button>
        <button type="button" style={styles.iconBtn} onClick={onRemove}><X size={14} /></button>
      </div>
      {state === 'invalid' && error && <p style={styles.fieldError}>{error}</p>}
    </div>
  );
};

/* ─── Styles ─────────────────────────────────────────────────────────────── */
const styles: Record<string, React.CSSProperties> = {
  root: {
    minHeight: '100vh',
    background: '#0a0a0a',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '24px 16px',
    position: 'relative',
    fontFamily: "'DM Sans', 'Inter', system-ui, sans-serif",
  },
  grain: {
    position: 'fixed',
    inset: 0,
    backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.75' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.04'/%3E%3C/svg%3E")`,
    backgroundSize: '200px',
    pointerEvents: 'none',
    zIndex: 0,
  },
  card: {
    position: 'relative',
    zIndex: 1,
    width: '100%',
    maxWidth: 420,
    background: '#111',
    border: '1px solid #1f1f1f',
    borderRadius: 20,
    padding: '36px 32px 32px',
    boxShadow: '0 24px 80px rgba(0,0,0,0.6)',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 28,
  },
  logoMark: {
    width: 36,
    height: 36,
    background: 'rgba(13,148,136,0.1)',
    border: '1px solid rgba(13,148,136,0.25)',
    borderRadius: 10,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoText: {
    color: '#e2e8f0',
    fontSize: 15,
    fontWeight: 600,
    letterSpacing: '-0.01em',
  },
  title: {
    color: '#fff',
    fontSize: 26,
    fontWeight: 700,
    letterSpacing: '-0.03em',
    margin: '0 0 6px',
    lineHeight: 1.2,
  },
  subtitle: {
    color: '#6b7280',
    fontSize: 14,
    margin: '0 0 28px',
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
  },
  label: {
    display: 'block',
    color: '#9ca3af',
    fontSize: 12,
    fontWeight: 600,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    marginBottom: 6,
  },
  input: {
    width: '100%',
    padding: '11px 14px',
    background: '#0a0a0a',
    border: '1px solid #2a2a2a',
    borderRadius: 10,
    color: '#fff',
    fontSize: 15,
    outline: 'none',
    transition: 'border-color 0.15s, box-shadow 0.15s',
    boxSizing: 'border-box',
  },
  fieldError: {
    color: '#f87171',
    fontSize: 12,
    margin: '4px 0 0',
  },
  primaryBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    width: '100%',
    padding: '13px 20px',
    background: '#0d9488',
    border: 'none',
    borderRadius: 12,
    color: '#fff',
    fontSize: 15,
    fontWeight: 700,
    cursor: 'pointer',
    transition: 'background 0.15s, transform 0.1s',
    marginTop: 4,
    letterSpacing: '-0.01em',
  },
  errorBox: {
    background: 'rgba(248,113,113,0.08)',
    border: '1px solid rgba(248,113,113,0.3)',
    borderRadius: 8,
    color: '#f87171',
    fontSize: 13,
    padding: '10px 12px',
    marginBottom: 12,
  },
  conflictBox: {
    background: 'rgba(251,191,36,0.06)',
    border: '1px solid rgba(251,191,36,0.25)',
    borderRadius: 10,
    padding: '14px 16px',
    marginBottom: 12,
  },
  conflictText: {
    color: '#fbbf24',
    fontSize: 13,
    fontWeight: 600,
    margin: '0 0 12px',
  },
  conflictActions: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 8,
  },
  conflictPrimaryBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    width: '100%',
    padding: '10px 16px',
    background: '#0d9488',
    border: 'none',
    borderRadius: 8,
    color: '#fff',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
  },
  conflictSecondaryBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    width: '100%',
    padding: '10px 16px',
    background: 'transparent',
    border: '1px solid #333',
    borderRadius: 8,
    color: '#9ca3af',
    fontSize: 13,
    fontWeight: 500,
    cursor: 'pointer',
  },
  trustRow: {
    display: 'flex',
    gap: 8,
    justifyContent: 'center',
    flexWrap: 'wrap',
    marginTop: 20,
  },
  trustChip: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    color: '#6b7280',
    fontSize: 11,
    fontWeight: 500,
  },
  loginLink: {
    textAlign: 'center',
    color: '#6b7280',
    fontSize: 13,
    marginTop: 16,
    marginBottom: 0,
  },
  link: {
    background: 'none',
    border: 'none',
    color: '#0d9488',
    cursor: 'pointer',
    fontSize: 13,
    padding: 0,
  },
  promoToggle: {
    background: 'none',
    border: 'none',
    color: '#6b7280',
    cursor: 'pointer',
    fontSize: 12,
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    padding: 0,
    marginBottom: 16,
    transition: 'color 0.15s',
  },
  promoRow: {
    display: 'flex',
    gap: 8,
    alignItems: 'center',
    marginBottom: 4,
  },
  promoApplyBtn: {
    padding: '10px 14px',
    background: '#0d9488',
    border: 'none',
    borderRadius: 10,
    color: '#fff',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    gap: 4,
  },
  promoValid: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '10px 12px',
    background: 'rgba(74,222,128,0.06)',
    border: '1px solid rgba(74,222,128,0.2)',
    borderRadius: 10,
    marginBottom: 16,
  },
  iconBtn: {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    color: '#6b7280',
    padding: 4,
    display: 'flex',
    alignItems: 'center',
    borderRadius: 4,
    flexShrink: 0,
  },
  spin: {
    animation: 'spin 1s linear infinite',
  },

  // ── Success screen ──
  successIcon: {
    width: 64,
    height: 64,
    borderRadius: '50%',
    background: 'linear-gradient(135deg, #0d9488, #059669)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    margin: '0 auto 20px',
    boxShadow: '0 0 40px rgba(13,148,136,0.4)',
  },
  successTitle: {
    color: '#fff',
    fontSize: 28,
    fontWeight: 700,
    letterSpacing: '-0.03em',
    textAlign: 'center',
    margin: '0 0 8px',
  },
  successSub: {
    color: '#9ca3af',
    fontSize: 15,
    textAlign: 'center',
    margin: '0 0 28px',
  },
  pinBlock: {
    background: '#0a0a0a',
    border: '1px solid #1f1f1f',
    borderRadius: 14,
    padding: '20px',
    textAlign: 'center',
    marginBottom: 16,
  },
  pinLabel: {
    color: '#6b7280',
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    margin: '0 0 12px',
  },
  pinRow: {
    display: 'flex',
    gap: 10,
    justifyContent: 'center',
    marginBottom: 14,
  },
  pinDigit: {
    width: 52,
    height: 60,
    background: '#111',
    border: '1px solid #2a2a2a',
    borderRadius: 12,
    color: '#fff',
    fontSize: 28,
    fontWeight: 700,
    fontFamily: 'monospace',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    letterSpacing: 0,
  },
  copyBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    padding: '6px 14px',
    background: 'rgba(255,255,255,0.06)',
    border: '1px solid #2a2a2a',
    borderRadius: 8,
    color: '#9ca3af',
    fontSize: 12,
    cursor: 'pointer',
    marginBottom: 12,
    fontWeight: 500,
  },
  pinHint: {
    color: '#6b7280',
    fontSize: 12,
    margin: 0,
  },
  urlBlock: {
    background: 'rgba(13,148,136,0.06)',
    border: '1px solid rgba(13,148,136,0.2)',
    borderRadius: 10,
    padding: '12px 16px',
    textAlign: 'center',
    marginBottom: 20,
  },
  urlLabel: {
    color: '#6b7280',
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    margin: '0 0 4px',
  },
  urlValue: {
    color: '#5eead4',
    fontSize: 14,
    fontWeight: 600,
    margin: 0,
    fontFamily: 'monospace',
  },
  successFooter: {
    color: '#6b7280',
    fontSize: 12,
    textAlign: 'center',
    margin: '16px 0 0',
  },
};

export default OnboardingScreen;
