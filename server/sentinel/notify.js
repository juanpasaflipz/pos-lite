/**
 * Sentinel — Notification fanout (Phase 2: WhatsApp live)
 *
 * Channels:
 *   - structured server log (always) — Railway logs are the platform channel
 *   - optional generic webhook for high/critical (SENTINEL_ALERT_WEBHOOK) —
 *     Slack-compatible {text} payload, fire-and-forget
 *   - WhatsApp to the tenant's admin/manager employees with a phone on file
 *     (severity ≥ SENTINEL_WA_MIN_SEVERITY, default 'high'), with plain-SMS
 *     fallback when the WA send fails (e.g. outside the 24h session window).
 *     Disable entirely with SENTINEL_WA_NOTIFY=off.
 *
 * Everything here is fire-and-forget: a notification failure must never
 * break the sweep/triage path. In-app visibility remains the
 * /api/sentinel/incidents route (the panel reads it).
 */

import { adminSql } from '../db/index.js';
import { fetchWithTimeout } from '../lib/http.js';
import { sendWhatsAppText, sendSMSReply } from '../helpers/twilio.js';

const ALERT_WEBHOOK = process.env.SENTINEL_ALERT_WEBHOOK || null;
const WEBHOOK_MIN_SEVERITY = process.env.SENTINEL_WEBHOOK_MIN_SEVERITY || 'high';
const WA_MIN_SEVERITY = process.env.SENTINEL_WA_MIN_SEVERITY || 'high';
const WA_ENABLED = process.env.SENTINEL_WA_NOTIFY !== 'off';

const SEVERITY_RANK = { low: 0, medium: 1, high: 2, critical: 3 };

// Events worth a phone buzz. Detection-only noise (low-severity sweeps,
// budget caps) stays in logs/panel.
const WA_EVENTS = new Set([
  'needs-human', 'auto-fixed', 'shadow-diagnosed', 'fix-aborted',
  'triage-inconclusive', 'detected (triage off)',
]);

function buildOwnerMessage(incident, event) {
  const dx = incident.diagnosis?.explanation
    ? `\n${incident.diagnosis.explanation}`
    : '';
  const action = incident.status === 'auto_fixed'
    ? 'Se corrigió automáticamente.'
    : 'Requiere tu revisión — entra al panel Sentinel del POS para aprobar la corrección.';
  return (
    `🛡️ Sentinel [${incident.severity}] ${incident.sensor} — incidente #${incident.id}.` +
    `${dx}\n${action}`
  );
}

async function notifyOwnersWhatsApp(incident, event) {
  if (!WA_ENABLED) return;
  if (SEVERITY_RANK[incident.severity] < SEVERITY_RANK[WA_MIN_SEVERITY]) return;
  if (!WA_EVENTS.has(event)) return;

  const recipients = await adminSql`
    SELECT name, phone FROM employees
    WHERE tenant_id = ${incident.tenant_id}
      AND active = true
      AND phone IS NOT NULL AND phone <> ''
      AND role IN ('owner', 'admin', 'manager')
    LIMIT 5
  `;
  if (!recipients.length) {
    console.log(`[Sentinel] no notifiable owner/manager phones for tenant ${incident.tenant_id}`);
    return;
  }

  const body = buildOwnerMessage(incident, event);
  for (const r of recipients) {
    const waSid = await sendWhatsAppText(r.phone, body);
    if (waSid) {
      console.log(`[Sentinel] WA alert sent to ${r.name} for incident ${incident.id} (${waSid})`);
      continue;
    }
    // Outside the WA session window (or WA misconfigured) → plain SMS.
    const smsSid = await sendSMSReply(r.phone, body.replace('🛡️ ', ''));
    console.log(
      smsSid
        ? `[Sentinel] SMS fallback sent to ${r.name} for incident ${incident.id} (${smsSid})`
        : `[Sentinel] alert to ${r.name} failed on both WA and SMS for incident ${incident.id}`
    );
  }
}

export function notifyIncident(incident, event) {
  const line =
    `[Sentinel] ${event} tenant=${incident.tenant_id} sensor=${incident.sensor} ` +
    `severity=${incident.severity} status=${incident.status} incident=${incident.id}` +
    (incident.subject_table ? ` subject=${incident.subject_table}:${incident.subject_id ?? '-'}` : '');
  if (incident.severity === 'critical' || incident.severity === 'high') {
    console.error(line);
  } else {
    console.log(line);
  }

  if (
    ALERT_WEBHOOK &&
    SEVERITY_RANK[incident.severity] >= SEVERITY_RANK[WEBHOOK_MIN_SEVERITY]
  ) {
    const summary = incident.diagnosis?.explanation
      ? `\n${incident.diagnosis.explanation}`
      : '';
    fetchWithTimeout(ALERT_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `🚨 Sentinel ${event} — [${incident.severity}] ${incident.sensor} @ ${incident.tenant_id} (incident #${incident.id})${summary}`,
      }),
    }).catch((err) => {
      console.error('[Sentinel] alert webhook failed:', err.message);
    });
  }

  notifyOwnersWhatsApp(incident, event).catch((err) => {
    console.error('[Sentinel] WA notify failed:', err.message);
  });
}
