import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChefHat, RefreshCw, WifiOff } from 'lucide-react';
import { pairDeviceInit, pairDevicePoll, setDeviceToken, getDeviceToken } from '../api';

// TV-side pairing screen. Wall-mounted KDS hits this URL once, shows a
// 6-character code, polls every 3s. When a manager claims the code from
// /admin/devices, the poll endpoint returns a device JWT — we store it
// in localStorage and continue into the KDS.
export default function KitchenPairScreen() {
  const navigate = useNavigate();
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number>(0);
  const [status, setStatus] = useState<'idle' | 'pending' | 'expired' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // If we somehow land here with an existing valid device token, just
  // skip straight to the KDS. The token might be expired/revoked, in
  // which case KitchenDisplay will bounce them back.
  useEffect(() => {
    if (getDeviceToken()) {
      navigate('/kitchen', { replace: true });
    }
  }, [navigate]);

  const startPairing = async () => {
    setStatus('idle');
    setError(null);
    try {
      const r = await pairDeviceInit('kds');
      setDeviceId(r.device_id);
      setCode(r.pairing_code);
      setExpiresAt(r.expires_at);
      setStatus('pending');
    } catch (err: any) {
      setError(err?.message || 'Could not start pairing');
      setStatus('error');
    }
  };

  // First-mount: kick off pairing immediately.
  useEffect(() => {
    startPairing();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll every 3s while pending.
  useEffect(() => {
    if (!deviceId || status !== 'pending') return;
    pollRef.current = setInterval(async () => {
      try {
        const r = await pairDevicePoll(deviceId);
        if (r.status === 'claimed') {
          setDeviceToken(r.token);
          if (pollRef.current) clearInterval(pollRef.current);
          navigate('/kitchen', { replace: true });
        } else if (r.status === 'expired') {
          setStatus('expired');
          if (pollRef.current) clearInterval(pollRef.current);
        } else if (r.status === 'revoked') {
          setStatus('expired');
          setError('This pairing was revoked');
          if (pollRef.current) clearInterval(pollRef.current);
        }
      } catch {
        // Transient network errors — keep polling.
      }
    }, 3000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [deviceId, status, navigate]);

  // Countdown to expiry.
  useEffect(() => {
    if (!expiresAt) return;
    const tick = () => {
      const ms = new Date(expiresAt).getTime() - Date.now();
      setSecondsLeft(Math.max(0, Math.floor(ms / 1000)));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [expiresAt]);

  return (
    <div className="min-h-screen bg-neutral-950 text-white flex items-center justify-center p-8">
      <div className="max-w-2xl w-full text-center space-y-8">
        <div className="flex items-center justify-center gap-3 text-brand-500">
          <ChefHat className="w-10 h-10" />
          <h1 className="text-4xl font-bold">Pair Kitchen Display</h1>
        </div>

        {status === 'pending' && code && (
          <>
            <p className="text-neutral-400 text-xl">
              On your POS, open <span className="text-white font-semibold">Admin → Devices</span> and enter:
            </p>

            <div
              className="mx-auto inline-flex items-center justify-center rounded-2xl bg-neutral-900 border border-neutral-800 px-12 py-10"
              aria-label="Pairing code"
            >
              <span className="font-mono text-7xl tracking-[0.4em] font-bold text-brand-400 select-all">
                {code}
              </span>
            </div>

            <p className="text-neutral-500">
              Code expires in {Math.floor(secondsLeft / 60)}m {String(secondsLeft % 60).padStart(2, '0')}s
            </p>
            <p className="text-neutral-600 text-sm">
              Waiting for a manager to enter this code...
            </p>
          </>
        )}

        {status === 'expired' && (
          <div className="space-y-6">
            <p className="text-xl text-cockpit-yellow flex items-center justify-center gap-2">
              <WifiOff className="w-6 h-6" />
              {error || 'Pairing code expired'}
            </p>
            <button
              onClick={startPairing}
              className="inline-flex items-center gap-2 px-6 py-3 rounded-lg bg-brand-600 hover:bg-brand-500 text-white font-semibold text-lg"
            >
              <RefreshCw className="w-5 h-5" />
              Generate new code
            </button>
          </div>
        )}

        {status === 'error' && (
          <div className="space-y-6">
            <p className="text-xl text-cockpit-red">{error}</p>
            <button
              onClick={startPairing}
              className="inline-flex items-center gap-2 px-6 py-3 rounded-lg bg-brand-600 hover:bg-brand-500 text-white font-semibold text-lg"
            >
              <RefreshCw className="w-5 h-5" />
              Try again
            </button>
          </div>
        )}

        {status === 'idle' && (
          <p className="text-neutral-400 text-xl">Generating pairing code...</p>
        )}

        <div className="pt-8 text-xs text-neutral-600 max-w-md mx-auto">
          This device will stay paired across reboots. A manager can revoke it
          at any time from Admin → Devices.
        </div>
      </div>
    </div>
  );
}
