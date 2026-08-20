import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, Delete, Gift, Star } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useKioskBinding } from '../context/KioskBindingContext';
import { useKioskCustomer } from '../context/KioskCustomerContext';
import { identifyCustomer, logSuggestionEvents } from '../lib/kioskApi';

/** Member check-in: the enrolled customer's front door. Ten digits → the
 *  session carries their customer_token, so the order links to them at
 *  creation, the stamp awards itself on payment, and the confirmation shows
 *  real progress. Unknown numbers are sent through as guests — the loyalty
 *  interstitial at the end enrolls them WITH this order's stamp, which beats
 *  asking a stranger to type their name on a kiosk. */

type Step = 'input' | 'checking' | 'found' | 'notfound' | 'error';

const PHONE_LEN = 10; // MX national number; server normalizes with country_code MX
const IDLE_BACK_MS = 45_000; // abandoned screen rolls back to attract
const FOUND_AUTO_MS = 8_000; // greeting auto-advances into the menu

const KioskMemberScreen: React.FC = () => {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { tenantId, kioskToken } = useKioskBinding();
  const { session, setSessionFromIdentify } = useKioskCustomer();
  const [digits, setDigits] = useState('');
  const [step, setStep] = useState<Step>('input');

  const log = useCallback(
    (outcome: string, customerToken: string | null = null) => {
      if (!tenantId || !kioskToken) return;
      logSuggestionEvents({ tenantId, kioskToken }, customerToken, [
        { lane: 'member_checkin', source: outcome, event_type: 'tapped' },
      ]);
    },
    [tenantId, kioskToken],
  );

  useEffect(() => {
    log('shown');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Kiosk hygiene: an abandoned check-in returns to the attract screen.
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const armIdle = useCallback(() => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => navigate('/', { replace: true }), IDLE_BACK_MS);
  }, [navigate]);
  useEffect(() => {
    armIdle();
    return () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
  }, [armIdle]);

  // Found → auto-advance so a distracted member still lands in the menu with
  // their session intact.
  useEffect(() => {
    if (step !== 'found') return;
    const id = setTimeout(() => navigate('/menu', { replace: true }), FOUND_AUTO_MS);
    return () => clearTimeout(id);
  }, [step, navigate]);

  const tap = (d: string) => {
    armIdle();
    setDigits((cur) => (cur.length >= PHONE_LEN ? cur : cur + d));
  };
  const backspace = () => {
    armIdle();
    setDigits((cur) => cur.slice(0, -1));
  };

  const submit = async () => {
    if (digits.length !== PHONE_LEN || !tenantId || !kioskToken) return;
    armIdle();
    setStep('checking');
    try {
      const result = await identifyCustomer({ tenantId, kioskToken }, { phone: digits });
      if (result.found) {
        const s = setSessionFromIdentify(result);
        log('found', s?.customerToken || null);
        setStep('found');
      } else {
        log('not_found');
        setStep('notfound');
      }
    } catch {
      log('error');
      setStep('error');
    }
  };

  const orderAsGuest = () => {
    log('guest');
    navigate('/menu', { replace: true });
  };

  const formatted = digits
    .padEnd(PHONE_LEN, '·')
    .replace(/^(..)(....)(....)$/, '$1 $2 $3');

  const stamp = session?.stamp || null;
  const remaining = stamp ? Math.max(0, stamp.required - stamp.earned) : null;

  return (
    <div className="h-full w-full bg-neutral-950 text-white flex flex-col items-center justify-center overflow-y-auto p-6 sm:p-10 pt-safe pb-safe text-center">
      <button
        onClick={() => navigate('/', { replace: true })}
        aria-label={t('common.back')}
        className="absolute top-0 left-0 p-5 sm:p-8 pt-safe text-neutral-400 touch-manipulation"
      >
        <ArrowLeft className="h-8 w-8 sm:h-10 sm:w-10" />
      </button>

      {step === 'found' && session ? (
        <>
          <Star className="h-14 w-14 sm:h-20 sm:w-20 text-brand-300 mb-4 sm:mb-6" />
          <h1 className="text-4xl sm:text-6xl font-black leading-tight">
            {t('member.hello', { name: session.firstName })}
          </h1>
          {stamp ? (
            <>
              <div className="flex items-center gap-1.5 sm:gap-2.5 mt-6 sm:mt-8" aria-hidden="true">
                {Array.from({ length: stamp.required }, (_, i) =>
                  i < stamp.earned ? (
                    <span key={i} className="w-7 h-7 sm:w-10 sm:h-10 rounded-full bg-brand-600 border-2 border-brand-300 flex items-center justify-center shrink-0">
                      <Check className="h-4 w-4 sm:h-6 sm:w-6" strokeWidth={4} />
                    </span>
                  ) : i === stamp.required - 1 ? (
                    <span key={i} className="w-7 h-7 sm:w-10 sm:h-10 rounded-full border-2 border-dashed border-brand-300 flex items-center justify-center shrink-0">
                      <Gift className="h-4 w-4 sm:h-6 sm:w-6 text-brand-300" />
                    </span>
                  ) : (
                    <span key={i} className="w-7 h-7 sm:w-10 sm:h-10 rounded-full border-2 border-neutral-700 shrink-0" />
                  ),
                )}
              </div>
              <p className="text-lg sm:text-2xl text-neutral-300 font-bold mt-4 sm:mt-6 max-w-2xl">
                {remaining !== null && remaining <= 1
                  ? t('member.almostThere')
                  : t('member.progress', { earned: stamp.earned, required: stamp.required, remaining })}
              </p>
              <p className="text-sm sm:text-base text-neutral-500 font-bold mt-2">{t('member.autoStamp')}</p>
            </>
          ) : (
            <p className="text-lg sm:text-2xl text-neutral-300 font-bold mt-4 max-w-2xl">{t('member.autoStamp')}</p>
          )}
          <button
            onClick={() => navigate('/menu', { replace: true })}
            className="mt-8 sm:mt-12 w-full max-w-xl h-16 sm:h-20 rounded-2xl bg-brand-600 active:bg-brand-700 text-xl sm:text-2xl font-black touch-manipulation"
          >
            {t('member.order')}
          </button>
        </>
      ) : step === 'notfound' || step === 'error' ? (
        <>
          <h1 className="text-3xl sm:text-5xl font-black leading-tight max-w-2xl">
            {step === 'error' ? t('member.errorTitle') : t('member.notFoundTitle')}
          </h1>
          <p className="text-lg sm:text-2xl text-neutral-300 font-bold mt-4 max-w-2xl">
            {step === 'error' ? t('member.errorBody') : t('member.notFoundBody')}
          </p>
          <div className="mt-8 sm:mt-12 grid grid-cols-1 gap-3 sm:gap-4 w-full max-w-xl">
            <button
              onClick={() => { setDigits(''); setStep('input'); armIdle(); }}
              className="h-16 sm:h-20 rounded-2xl bg-brand-600 active:bg-brand-700 text-xl sm:text-2xl font-black touch-manipulation"
            >
              {t('member.tryAgain')}
            </button>
            <button
              onClick={orderAsGuest}
              className="h-16 sm:h-20 rounded-2xl bg-neutral-800 active:bg-neutral-700 text-xl sm:text-2xl font-black touch-manipulation"
            >
              {t('member.orderAsGuest')}
            </button>
          </div>
        </>
      ) : (
        <>
          <h1 className="text-3xl sm:text-5xl font-black leading-tight">{t('member.title')}</h1>
          <p className="text-base sm:text-xl text-neutral-400 font-bold mt-3 max-w-2xl">{t('member.subtitle')}</p>

          <div className="mt-6 sm:mt-8 text-4xl sm:text-5xl font-black tracking-[0.2em] tabular-nums text-brand-300 min-h-[3rem]">
            {formatted}
          </div>

          <div className="mt-6 sm:mt-8 grid grid-cols-3 gap-3 sm:gap-4 w-full max-w-sm">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
              <button
                key={d}
                onClick={() => tap(d)}
                disabled={step === 'checking'}
                className="h-16 sm:h-20 rounded-2xl bg-neutral-900 border border-neutral-800 active:bg-neutral-800 text-2xl sm:text-3xl font-black touch-manipulation disabled:opacity-40"
              >
                {d}
              </button>
            ))}
            <span aria-hidden="true" />
            <button
              onClick={() => tap('0')}
              disabled={step === 'checking'}
              className="h-16 sm:h-20 rounded-2xl bg-neutral-900 border border-neutral-800 active:bg-neutral-800 text-2xl sm:text-3xl font-black touch-manipulation disabled:opacity-40"
            >
              0
            </button>
            <button
              onClick={backspace}
              disabled={step === 'checking'}
              aria-label={t('member.deleteDigit')}
              className="h-16 sm:h-20 rounded-2xl bg-neutral-900 border border-neutral-800 active:bg-neutral-800 flex items-center justify-center touch-manipulation disabled:opacity-40"
            >
              <Delete className="h-7 w-7 sm:h-8 sm:w-8" />
            </button>
          </div>

          <button
            onClick={submit}
            disabled={digits.length !== PHONE_LEN || step === 'checking'}
            className="mt-6 sm:mt-8 w-full max-w-sm h-16 sm:h-20 rounded-2xl bg-brand-600 active:bg-brand-700 disabled:bg-neutral-800 disabled:text-neutral-500 text-xl sm:text-2xl font-black touch-manipulation"
          >
            {step === 'checking' ? t('member.checking') : t('member.continue')}
          </button>
        </>
      )}
    </div>
  );
};

export default KioskMemberScreen;
