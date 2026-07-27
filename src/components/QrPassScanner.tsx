import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import jsQR from 'jsqr';
import { CameraOff } from 'lucide-react';

interface Props {
  // Called with the raw decoded QR text (e.g. "dk-loyalty:<serial>") the
  // moment a code is read. The parent owns what happens next — it may fail
  // (foreign/revoked pass) and should let scanning resume via `busy` going
  // back to false, or it may succeed and unmount this component by changing
  // phase away from 'search'.
  onDetected: (value: string) => void;
  // While true, decoding pauses so we don't fire onDetected again for the
  // same frame while the parent's lookup request is in flight.
  busy: boolean;
}

type CameraState = 'starting' | 'ready' | 'denied' | 'unavailable';

export default function QrPassScanner({ onDetected, busy }: Props) {
  const { t } = useTranslation('pos');
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number>(0);
  const detectedRef = useRef(false);
  const onDetectedRef = useRef(onDetected);
  onDetectedRef.current = onDetected;
  const [state, setState] = useState<CameraState>('starting');

  useEffect(() => {
    let cancelled = false;

    function tick() {
      if (cancelled) return;
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (video && canvas && !detectedRef.current && video.readyState === video.HAVE_ENOUGH_DATA) {
        const w = video.videoWidth;
        const h = video.videoHeight;
        if (w && h) {
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          if (ctx) {
            ctx.drawImage(video, 0, 0, w, h);
            const frame = ctx.getImageData(0, 0, w, h);
            const code = jsQR(frame.data, w, h, { inversionAttempts: 'dontInvert' });
            if (code && code.data) {
              detectedRef.current = true;
              onDetectedRef.current(code.data);
            }
          }
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    }

    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setState('unavailable');
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
        setState('ready');
        rafRef.current = requestAnimationFrame(tick);
      } catch {
        if (!cancelled) setState('denied');
      }
    }

    start();

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    };
    // Intentionally run once per mount — the parent remounts this
    // component (by changing `phase`/`searchBy`) when it wants a fresh
    // camera session rather than us reacting to prop changes here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A failed lookup (foreign/revoked pass) leaves this component mounted so
  // the same camera session keeps running — re-arm detection once the
  // parent clears `busy` so the next scan attempt fires again.
  useEffect(() => {
    if (!busy) detectedRef.current = false;
  }, [busy]);

  return (
    <div className="space-y-2">
      <div className="relative rounded-lg overflow-hidden bg-black aspect-square">
        <video ref={videoRef} className="w-full h-full object-cover" playsInline muted autoPlay />
        <canvas ref={canvasRef} className="hidden" />
        {state === 'ready' && (
          <div className="absolute inset-8 border-2 border-brand-500/80 rounded-lg pointer-events-none" />
        )}
        {state !== 'ready' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/85 text-center px-6">
            {state === 'starting' && (
              <p className="text-sm text-neutral-300">{t('customerLookup.scanStarting')}</p>
            )}
            {state === 'denied' && (
              <>
                <CameraOff size={28} className="text-neutral-400" />
                <p className="text-sm text-neutral-300">{t('customerLookup.scanCameraDenied')}</p>
              </>
            )}
            {state === 'unavailable' && (
              <>
                <CameraOff size={28} className="text-neutral-400" />
                <p className="text-sm text-neutral-300">{t('customerLookup.scanCameraUnavailable')}</p>
              </>
            )}
          </div>
        )}
      </div>
      <p className="text-xs text-neutral-500 text-center">
        {state === 'ready' ? t('customerLookup.scanInstruction') : t('customerLookup.scanFallback')}
      </p>
    </div>
  );
}
