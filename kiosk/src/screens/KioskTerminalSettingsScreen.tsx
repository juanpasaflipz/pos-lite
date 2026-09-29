import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Check, Loader2, RefreshCcw, XCircle } from 'lucide-react';
import { useKioskBinding } from '../context/KioskBindingContext';
import {
  listKioskClipDevices,
  listKioskMpTerminals,
  type KioskClipDevice,
  type KioskMpTerminal,
} from '../lib/kioskApi';

function terminalLabel(t: KioskMpTerminal): string {
  return t.external_pos_id?.trim() || t.id;
}

const KioskTerminalSettingsScreen: React.FC = () => {
  const navigate = useNavigate();
  const {
    tenantId,
    tenantName,
    kioskToken,
    terminalId,
    terminalLabel: currentLabel,
    terminalProvider,
    setTerminal,
    unbind,
  } = useKioskBinding();

  const [terminals, setTerminals] = useState<KioskMpTerminal[]>([]);
  const [clipDevices, setClipDevices] = useState<KioskClipDevice[]>([]);
  const [loading, setLoading] = useState(true);
  // Per provider: a tenant usually runs only one, so the other one failing
  // ("not connected") must not hide the list that does work.
  const [error, setError] = useState<string | null>(null);
  const [clipError, setClipError] = useState<string | null>(null);
  const load = async () => {
    if (!tenantId || !kioskToken) return;
    const auth = { tenantId, kioskToken };
    setLoading(true);
    setError(null);
    setClipError(null);
    const [mp, clip] = await Promise.allSettled([listKioskMpTerminals(auth), listKioskClipDevices(auth)]);
    if (mp.status === 'fulfilled') setTerminals(mp.value.terminals);
    else setError(mp.reason instanceof Error ? mp.reason.message : 'No se pudo cargar la lista');
    if (clip.status === 'fulfilled') setClipDevices(clip.value.devices);
    else setClipError(clip.reason instanceof Error ? clip.reason.message : 'No se pudo cargar la lista');
    setLoading(false);
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, kioskToken]);

  const onPick = (t: KioskMpTerminal) => {
    setTerminal({ id: t.id, label: terminalLabel(t), provider: 'mp' });
  };

  const onPickClip = (d: KioskClipDevice) => {
    setTerminal({ id: d.serial_number, label: `Clip ${d.serial_number}`, provider: 'clip' });
  };

  const onClear = () => {
    setTerminal(null);
  };

  return (
    <div className="h-full w-full bg-neutral-950 text-white flex flex-col">
      <header className="px-4 sm:px-6 py-3 sm:py-4 border-b border-neutral-800 flex items-center justify-between gap-2 pt-safe">
        <button
          onClick={() => navigate('/')}
          className="h-11 sm:h-16 px-3 sm:px-5 rounded-lg bg-neutral-800 active:bg-neutral-700 text-sm sm:text-lg font-bold touch-manipulation inline-flex items-center gap-2 shrink-0"
        >
          <ArrowLeft className="h-4 w-4 sm:h-6 sm:w-6" />
          Salir
        </button>
        <h1 className="text-base sm:text-3xl font-black leading-none text-center">Terminal de este kiosko</h1>
        <button
          onClick={() => void load()}
          disabled={loading}
          className="h-11 sm:h-16 px-3 sm:px-5 rounded-lg bg-neutral-800 active:bg-neutral-700 disabled:opacity-50 text-sm sm:text-lg font-bold touch-manipulation inline-flex items-center gap-2 shrink-0"
        >
          {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : <RefreshCcw className="h-5 w-5" />}
          <span className="hidden sm:inline">Recargar</span>
        </button>
      </header>

      <main className="flex-1 overflow-y-auto px-4 sm:px-6 py-4 sm:py-6 pb-safe max-w-3xl w-full mx-auto">
        <p className="text-base text-neutral-400 mb-2">
          {tenantName ? `Conectado a ${tenantName}.` : null} Cada kiosko debe vincularse a su terminal más cercana (Mercado Pago Point o Clip).
        </p>
        <p className="text-base text-neutral-400 mb-6">
          Sin terminal vinculada este kiosko no puede cobrar — elige una abajo.
        </p>

        <div className="rounded-lg bg-neutral-900 border border-neutral-800 p-5 mb-6">
          <div className="text-sm uppercase tracking-wider text-neutral-500 font-bold mb-1">Este kiosko</div>
          {terminalId ? (
            <div className="flex items-baseline justify-between gap-3">
              <div>
                <div className="text-2xl font-black">{currentLabel}</div>
                <div className="text-xs text-neutral-500 font-mono mt-1">{terminalId}</div>
              </div>
              <button
                onClick={onClear}
                className="h-12 px-4 rounded-lg bg-neutral-800 active:bg-neutral-700 text-sm font-bold inline-flex items-center gap-2 touch-manipulation"
              >
                <XCircle className="h-4 w-4" />
                Quitar
              </button>
            </div>
          ) : (
            <div className="text-lg text-cockpit-yellow">
              Sin terminal vinculada — este kiosko no puede cobrar hasta que elijas una.
            </div>
          )}
        </div>

        <div className="text-sm uppercase tracking-wider text-neutral-500 font-bold mb-3">
          Mercado Pago Point ({terminals.length})
        </div>

        {error && (
          <div className="mb-4 rounded-lg bg-neutral-900 border border-neutral-800 px-5 py-3 text-base font-bold text-neutral-400">
            {error}
          </div>
        )}

        {loading && terminals.length === 0 ? (
          <div className="rounded-lg bg-neutral-900 border border-neutral-800 px-5 py-10 text-center text-neutral-500">
            <Loader2 className="h-8 w-8 animate-spin inline-block" />
          </div>
        ) : (
          <div className="space-y-3">
            {terminals.map((t) => {
              const picked = terminalProvider === 'mp' && terminalId === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => onPick(t)}
                  className={`w-full text-left p-5 rounded-lg border-2 touch-manipulation transition-colors ${
                    picked
                      ? 'bg-brand-700/20 border-brand-500'
                      : 'bg-neutral-900 border-neutral-800 active:border-neutral-700'
                  }`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-xl font-black">{terminalLabel(t)}</div>
                      <div className="text-xs text-neutral-500 font-mono mt-1">{t.id}</div>
                    </div>
                    {picked && <Check className="h-7 w-7 text-brand-400 shrink-0" />}
                  </div>
                </button>
              );
            })}
            {!loading && !error && terminals.length === 0 && (
              <div className="rounded-lg bg-neutral-900 border border-neutral-800 px-5 py-10 text-center text-neutral-500">
                No hay terminales en modo PDV en esta cuenta de Mercado Pago.
              </div>
            )}
          </div>
        )}

        <div className="text-sm uppercase tracking-wider text-neutral-500 font-bold mt-10 mb-3">
          Clip ({clipDevices.length})
        </div>

        {clipError && (
          <div className="mb-4 rounded-lg bg-neutral-900 border border-neutral-800 px-5 py-3 text-base font-bold text-neutral-400">
            {clipError}
          </div>
        )}

        <div className="space-y-3">
          {clipDevices.map((d) => {
            const picked = terminalProvider === 'clip' && terminalId === d.serial_number;
            const online = d.status === 'active';
            return (
              <button
                key={d.serial_number}
                onClick={() => onPickClip(d)}
                className={`w-full text-left p-5 rounded-lg border-2 touch-manipulation transition-colors ${
                  picked
                    ? 'bg-brand-700/20 border-brand-500'
                    : 'bg-neutral-900 border-neutral-800 active:border-neutral-700'
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-xl font-black">Clip {d.serial_number}</div>
                    <div className={`text-sm font-bold mt-1 ${online ? 'text-cockpit-in-text' : 'text-cockpit-yellow'}`}>
                      {online ? 'En línea' : 'Sin conexión — abre la app Clip PinPad'}
                    </div>
                  </div>
                  {picked && <Check className="h-7 w-7 text-brand-400 shrink-0" />}
                </div>
              </button>
            );
          })}
          {!loading && !clipError && clipDevices.length === 0 && (
            <div className="rounded-lg bg-neutral-900 border border-neutral-800 px-5 py-10 text-center text-neutral-500">
              No hay terminales Clip PinPad en esta cuenta.
            </div>
          )}
        </div>

        <button
          onClick={() => {
            unbind();
            navigate('/');
          }}
          className="mt-12 text-sm text-neutral-600 active:text-neutral-400 underline underline-offset-4 touch-manipulation"
        >
          Desvincular este iPad
        </button>
      </main>
    </div>
  );
};

export default KioskTerminalSettingsScreen;
