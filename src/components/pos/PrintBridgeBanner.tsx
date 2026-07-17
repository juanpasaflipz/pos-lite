import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Printer, AlertTriangle } from 'lucide-react';
import { getPrintBridgeStatus, PrintBridgeStatus } from '../../api';

/**
 * Amber strip on the POS register when kitchen tickets can't reach the
 * printer: the on-site print bridge is offline, or real tickets have been
 * sitting queued for 2+ minutes. Jobs are never lost — they print when the
 * bridge reconnects — but during service the cashier needs to know NOW.
 *
 * Polling discipline (see 2026-07-16 audit): one status fetch on mount;
 * if the tenant has no bridge configured we stop entirely for the session.
 * Otherwise poll every 60s, and skip ticks while the tab is hidden.
 */
const POLL_MS = 60_000;

export default function PrintBridgeBanner() {
  const { t } = useTranslation('pos');
  const [status, setStatus] = useState<PrintBridgeStatus | null>(null);
  const stopped = useRef(false);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;

    const fetchStatus = async () => {
      if (stopped.current || document.hidden) return;
      try {
        const s = await getPrintBridgeStatus();
        if (!s.configured) {
          // No bridge on this tenant — never poll again this session.
          stopped.current = true;
          if (timer) clearInterval(timer);
          setStatus(null);
          return;
        }
        setStatus(s);
      } catch {
        // Transient fetch error — keep the last known state, retry next tick
      }
    };

    fetchStatus();
    timer = setInterval(fetchStatus, POLL_MS);
    return () => { if (timer) clearInterval(timer); };
  }, []);

  if (!status) return null;
  const offline = !status.online;
  const stuck = status.stuck_queued > 0;
  if (!offline && !stuck) return null;

  return (
    <Link
      to="/admin/printers"
      className="flex items-center gap-3 px-4 py-2.5 bg-amber-500/15 border border-amber-500/40 rounded-lg text-amber-300 hover:bg-amber-500/25 transition-colors"
    >
      {offline ? <AlertTriangle size={18} className="shrink-0" /> : <Printer size={18} className="shrink-0" />}
      <span className="text-sm font-medium">
        {offline
          ? t('printBridge.offline')
          : t('printBridge.stuck', { count: status.stuck_queued })}
      </span>
    </Link>
  );
}
