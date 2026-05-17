import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Clock, X, LogIn, LogOut, CheckCircle2 } from 'lucide-react';
import { clockIn, clockOut, getShiftStatus } from '../api';
import type { ShiftStatusResponse } from '../types';

interface TimeClockModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type Phase = 'pin' | 'confirm' | 'success';

const PIN_LENGTH = 6;
const SUCCESS_AUTOCLOSE_MS = 3500;

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h <= 0) return `${m}m`;
  return `${h}h ${m}m`;
}

const TimeClockModal: React.FC<TimeClockModalProps> = ({ isOpen, onClose }) => {
  const { t } = useTranslation('common');
  const [pin, setPin] = useState('');
  const [phase, setPhase] = useState<Phase>('pin');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState<ShiftStatusResponse | null>(null);
  const [successMessage, setSuccessMessage] = useState('');

  const reset = () => {
    setPin('');
    setPhase('pin');
    setStatus(null);
    setError('');
    setSuccessMessage('');
    setBusy(false);
  };

  useEffect(() => {
    if (!isOpen) reset();
  }, [isOpen]);

  useEffect(() => {
    if (phase !== 'success') return;
    const timer = setTimeout(() => onClose(), SUCCESS_AUTOCLOSE_MS);
    return () => clearTimeout(timer);
  }, [phase, onClose]);

  const handleDigit = async (digit: string) => {
    if (busy || phase !== 'pin') return;
    const next = pin + digit;
    setError('');
    setPin(next);
    if (next.length === PIN_LENGTH) {
      try {
        setBusy(true);
        const s = await getShiftStatus(next);
        setStatus(s);
        setPhase('confirm');
      } catch (err) {
        setError(messageFor(err, t));
        setPin('');
      } finally {
        setBusy(false);
      }
    }
  };

  const handleBackspace = () => {
    if (busy || phase !== 'pin') return;
    setPin((prev) => prev.slice(0, -1));
    setError('');
  };

  const handleClear = () => {
    if (busy) return;
    setPin('');
    setError('');
  };

  const handleConfirm = async () => {
    if (!status) return;
    try {
      setBusy(true);
      setError('');
      if (status.openShift) {
        const result = await clockOut(pin);
        const dur = result.shift.duration_seconds || 0;
        setSuccessMessage(t('timeClock.clockedOut', {
          name: result.employee.name,
          duration: formatDuration(dur),
        }));
      } else {
        const result = await clockIn(pin);
        if (result.already_open) {
          setSuccessMessage(t('timeClock.alreadyOpen', {
            name: result.employee.name,
            time: formatTime(result.shift.clock_in_at),
          }));
        } else {
          setSuccessMessage(t('timeClock.clockedIn', {
            name: result.employee.name,
            time: formatTime(result.shift.clock_in_at),
          }));
        }
      }
      setPhase('success');
    } catch (err) {
      setError(messageFor(err, t));
    } finally {
      setBusy(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-50">
      <div className="bg-neutral-900 rounded-2xl border border-neutral-800 shadow-xl max-w-md w-full p-6">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <Clock size={22} />
            {t('timeClock.title')}
          </h2>
          <button onClick={onClose} className="text-neutral-500 hover:text-neutral-300">
            <X size={22} />
          </button>
        </div>

        {phase === 'pin' && (
          <div>
            <p className="text-center text-neutral-400 mb-6">{t('timeClock.enterPinPrompt')}</p>
            <div className="flex gap-3 justify-center mb-6">
              {Array.from({ length: PIN_LENGTH }).map((_, i) => (
                <div key={i} className="w-10 h-10 bg-neutral-950 rounded-full flex items-center justify-center border-2 border-neutral-700">
                  <div className={`w-4 h-4 rounded-full ${pin.length > i ? 'bg-brand-600' : 'bg-neutral-800'}`} />
                </div>
              ))}
            </div>
            {error && <p className="text-center text-red-400 mb-4 font-medium">{error}</p>}
            <div className="grid grid-cols-3 gap-2 mb-3">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'].map((d) => (
                <button
                  key={d}
                  onClick={() => handleDigit(d)}
                  disabled={busy || pin.length === PIN_LENGTH}
                  className={`${d === '0' ? 'col-start-2' : ''} h-16 bg-neutral-800 text-2xl font-bold text-white rounded-xl hover:bg-neutral-700 active:bg-neutral-600 disabled:opacity-40 border border-neutral-700`}
                >
                  {d}
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleBackspace}
                disabled={busy || pin.length === 0}
                className="flex-1 h-12 bg-neutral-800 text-white font-semibold rounded-xl hover:bg-neutral-700 disabled:opacity-40 border border-neutral-700"
              >
                {t('buttons.back')}
              </button>
              <button
                onClick={handleClear}
                disabled={busy}
                className="flex-1 h-12 bg-neutral-800 text-white font-semibold rounded-xl hover:bg-neutral-700 disabled:opacity-40 border border-neutral-700"
              >
                {t('buttons.clear')}
              </button>
            </div>
          </div>
        )}

        {phase === 'confirm' && status && (
          <div className="text-center">
            <p className="text-sm uppercase tracking-wide text-neutral-500">{status.employee.role}</p>
            <p className="text-3xl font-bold text-white mt-1">{status.employee.name}</p>

            {status.openShift ? (
              <div className="mt-6 mb-6 rounded-xl border border-green-800 bg-green-950/40 px-4 py-4">
                <p className="text-green-300 font-semibold">{t('timeClock.youAreClockedIn')}</p>
                <p className="text-sm text-neutral-400 mt-1">
                  {t('timeClock.since', { time: formatTime(status.openShift.clock_in_at) })}
                </p>
              </div>
            ) : (
              <div className="mt-6 mb-6 rounded-xl border border-neutral-800 bg-neutral-950 px-4 py-4">
                <p className="text-neutral-300 font-semibold">{t('timeClock.youAreNotClockedIn')}</p>
              </div>
            )}

            {error && <p className="text-red-400 mb-4 font-medium">{error}</p>}

            <button
              onClick={handleConfirm}
              disabled={busy}
              className={`w-full h-14 rounded-xl font-bold text-white text-lg flex items-center justify-center gap-2 transition-colors ${
                status.openShift ? 'bg-red-600 hover:bg-red-500' : 'bg-brand-600 hover:bg-brand-500'
              } disabled:opacity-60`}
            >
              {status.openShift ? <LogOut size={20} /> : <LogIn size={20} />}
              {status.openShift ? t('timeClock.clockOut') : t('timeClock.clockIn')}
            </button>

            <button onClick={reset} disabled={busy} className="mt-3 text-sm text-neutral-500 hover:text-neutral-300">
              {t('buttons.cancel')}
            </button>
          </div>
        )}

        {phase === 'success' && (
          <div className="text-center py-6">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-green-950/40 border border-green-800 mb-4">
              <CheckCircle2 size={32} className="text-green-400" />
            </div>
            <p className="text-xl font-bold text-white">{successMessage}</p>
          </div>
        )}
      </div>
    </div>
  );
};

function messageFor(err: unknown, t: (k: string, options?: Record<string, unknown>) => string): string {
  const message = err instanceof Error ? err.message : '';
  if (/Invalid PIN/i.test(message)) return t('timeClock.invalidPin');
  if (/Too many/i.test(message)) return t('timeClock.rateLimited');
  return message || t('timeClock.failed');
}

export default TimeClockModal;
