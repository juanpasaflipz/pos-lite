import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  enrollLoyaltyJoin,
  verifyLoyaltyJoin,
  type LoyaltyJoinEnrollResult,
  type LoyaltyJoinInfo,
} from '../api';

// Public loyalty enrollment page hit via the QR on the kiosk post-payment
// screen. Same page handles "I'm already in the program" and "I'm new" — we
// don't know until the customer types their phone, and it makes no difference
// to the server (find-or-create + idempotent stamp credit).

const money = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });

function formatPhoneDisplay(digits: string): string {
  const a = digits.slice(0, 2);
  const b = digits.slice(2, 6);
  const c = digits.slice(6, 10);
  return [a, b, c].filter(Boolean).join(' ');
}

const LoyaltyJoinScreen: React.FC = () => {
  const { token } = useParams<{ token: string }>();
  const [info, setInfo] = useState<LoyaltyJoinInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [phone, setPhone] = useState('');
  const [smsOptIn, setSmsOptIn] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [result, setResult] = useState<LoyaltyJoinEnrollResult | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    verifyLoyaltyJoin(token)
      .then((data) => { if (!cancelled) setInfo(data); })
      .catch((err) => { if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Enlace inválido'); });
    return () => { cancelled = true; };
  }, [token]);

  const handlePhoneChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const digits = e.target.value.replace(/\D/g, '').slice(0, 10);
    setPhone(digits);
    setSubmitError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || phone.length !== 10 || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const r = await enrollLoyaltyJoin(token, phone, smsOptIn);
      setResult(r);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'No pudimos registrarte');
    } finally {
      setSubmitting(false);
    }
  };

  if (loadError) {
    return (
      <div className="min-h-screen bg-neutral-950 text-white flex items-center justify-center p-6">
        <div className="max-w-md text-center">
          <p className="text-2xl font-black">Este enlace ya no es válido</p>
          <p className="text-neutral-400 font-bold mt-3">{loadError}</p>
        </div>
      </div>
    );
  }

  if (!info) {
    return (
      <div className="min-h-screen bg-neutral-950 text-white flex items-center justify-center p-6">
        <p className="text-lg font-bold text-neutral-400">Cargando…</p>
      </div>
    );
  }

  if (result) {
    return (
      <div className="min-h-screen bg-neutral-950 text-white flex flex-col items-center justify-center p-6">
        <div className="w-full max-w-md text-center">
          <p className="text-4xl">🎉</p>
          <h1 className="text-3xl font-black mt-4">¡Listo, {result.first_name}!</h1>
          <p className="text-neutral-300 font-bold mt-3">
            Sumamos los sellos de esta orden. Llevas{' '}
            <span className="text-white">{result.stamps_earned}</span> de{' '}
            <span className="text-white">{result.stamps_required}</span>.
          </p>
          {result.card_completed && (
            <p className="text-amber-300 font-black mt-3">¡Tarjeta llena! Pide tu recompensa la próxima vez.</p>
          )}

          {result.wallet_url ? (
            <a
              href={result.wallet_url}
              className="mt-8 block w-full rounded-2xl bg-brand-600 active:bg-brand-700 text-white py-5 text-xl font-black text-center"
            >
              Guardar en Wallet
            </a>
          ) : (
            <p className="text-neutral-500 text-sm font-bold mt-6">
              Recibirás tu tarjeta digital por SMS.
            </p>
          )}

          <p className="text-neutral-500 text-xs font-bold mt-6">
            Se actualiza sola con cada compra.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-neutral-950 text-white flex flex-col items-center p-6">
      <div className="w-full max-w-md mt-8">
        <p className="text-neutral-500 text-sm font-black uppercase tracking-widest">
          Orden #{info.order_number} · {money.format(info.order_total)}
        </p>
        <h1 className="text-3xl font-black leading-tight mt-2">
          ¿Ya estás en el programa de lealtad de {info.tenant_name}?
        </h1>
        <p className="text-neutral-400 font-bold mt-3">
          Pon tu teléfono. Si ya eres cliente, sumamos los sellos a tu cuenta.
          Si eres nuevo, te damos tu tarjeta digital al momento.
        </p>

        <form onSubmit={handleSubmit} className="mt-8">
          <label className="block text-sm text-neutral-400 font-black uppercase tracking-wider">
            Tu teléfono
          </label>
          <input
            type="tel"
            inputMode="numeric"
            autoComplete="tel-national"
            autoFocus
            value={formatPhoneDisplay(phone)}
            onChange={handlePhoneChange}
            placeholder="55 0000 0000"
            className="mt-2 w-full h-16 rounded-2xl bg-neutral-900 border-2 border-neutral-700 focus:border-brand-500 outline-none text-2xl font-black text-center tabular-nums"
          />

          <label className="mt-5 flex items-start gap-3 text-neutral-300 font-bold">
            <input
              type="checkbox"
              checked={smsOptIn}
              onChange={(e) => setSmsOptIn(e.target.checked)}
              className="mt-1.5 h-5 w-5 accent-brand-500"
            />
            <span>Quiero recibir mis sellos y recompensas por SMS.</span>
          </label>

          {submitError && (
            <p className="mt-4 text-cockpit-out-text font-bold">{submitError}</p>
          )}

          <button
            type="submit"
            disabled={phone.length !== 10 || submitting}
            className="mt-6 w-full h-16 rounded-2xl bg-brand-600 active:bg-brand-700 disabled:bg-neutral-800 disabled:text-neutral-600 text-xl font-black"
          >
            {submitting ? 'Enviando…' : 'Continuar'}
          </button>
        </form>

        <p className="text-neutral-500 text-xs font-bold mt-6 text-center">
          Solo usamos tu teléfono para tu cuenta de lealtad.
        </p>
      </div>
    </div>
  );
};

export default LoyaltyJoinScreen;
