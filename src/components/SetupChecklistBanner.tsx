import React, { useEffect, useState } from 'react';
import { AlertTriangle, X, CreditCard, Printer } from 'lucide-react';
import { getOnboardingStatus, type OnboardingStatus } from '../api';
import { useAuth } from '../context/AuthContext';

// New-tenant first-hour preflight. A brand-new owner finishes onboarding,
// starts taking orders, and their first card charge 500s because no payment
// processor was ever connected. This banner reads the onboarding status
// (now including has_payment / has_printer) and warns BEFORE that happens.
//
// Deliberately non-blocking and dismissible: a cash-first restaurant (many of
// ours are) never needs a card processor, so this is an informational nudge,
// not an error. Only shown to owners/managers who can actually fix it, only
// once the tenant is genuinely operating (has a real menu), and only while
// something's missing. Dismissal is per-session (in-memory) — it reappears
// next login until they connect a processor, which is the point.

let dismissedThisSession = false;

export default function SetupChecklistBanner() {
  const { hasPermission } = useAuth();
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [dismissed, setDismissed] = useState(dismissedThisSession);

  // Only owners/managers can connect a processor or add a printer. Cashiers
  // shouldn't see setup nudges they can't action.
  const canManage = hasPermission?.('manage_invoicing') || hasPermission?.('manage_printers');

  useEffect(() => {
    if (!canManage || dismissed) return;
    let alive = true;
    getOnboardingStatus()
      .then((s) => { if (alive) setStatus(s); })
      .catch(() => { /* non-fatal — the banner just stays hidden */ });
    return () => { alive = false; };
  }, [canManage, dismissed]);

  if (!canManage || dismissed || !status) return null;

  // Nothing to nag about until they've built a real menu (i.e. they're set up
  // enough to take orders). Payment is the load-bearing gap; printer is a
  // softer nudge shown alongside it.
  if (!status.has_menu_items) return null;
  if (status.has_payment && status.has_printer) return null;

  const missing: Array<{ icon: React.ReactNode; text: string }> = [];
  if (!status.has_payment) {
    missing.push({
      icon: <CreditCard size={16} />,
      text: 'Conecta un procesador de pagos (Mercado Pago, Clip o Stripe) para aceptar tarjeta. El efectivo ya funciona.',
    });
  }
  if (!status.has_printer) {
    missing.push({
      icon: <Printer size={16} />,
      text: 'Agrega una impresora para imprimir tickets de cocina y comandas.',
    });
  }

  const dismiss = () => {
    dismissedThisSession = true;
    setDismissed(true);
  };

  return (
    <div className="mb-4 rounded-lg border border-cockpit-yellow/50 bg-cockpit-yellow/10 px-4 py-3">
      <div className="flex items-start gap-3">
        <AlertTriangle className="text-cockpit-attention-text shrink-0 mt-0.5" size={20} />
        <div className="min-w-0 flex-1">
          <p className="font-bold text-cockpit-attention-text">
            Termina de configurar tu punto de venta
          </p>
          <ul className="mt-1 space-y-1">
            {missing.map((m, i) => (
              <li key={i} className="flex items-center gap-2 text-sm text-neutral-200">
                <span className="text-cockpit-attention-text">{m.icon}</span>
                <span>{m.text}</span>
              </li>
            ))}
          </ul>
        </div>
        <button
          onClick={dismiss}
          aria-label="Cerrar"
          className="shrink-0 rounded-md p-1.5 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
        >
          <X size={18} />
        </button>
      </div>
    </div>
  );
}
