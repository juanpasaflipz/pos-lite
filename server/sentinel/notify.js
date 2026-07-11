/**
 * Sentinel — Notification fanout (Phase 1)
 *
 * Phase 1 channels (docs/ai-sentinel-design.md §6):
 *   - structured server log (always) — Railway logs are the platform channel
 *   - optional generic webhook for high/critical (SENTINEL_ALERT_WEBHOOK) —
 *     Slack-compatible {text} payload, fire-and-forget
 *
 * In-app visibility is the /api/sentinel/incidents route (the panel reads
 * it). WhatsApp lands in Phase 2 via the existing Twilio integration.
 */

const ALERT_WEBHOOK = process.env.SENTINEL_ALERT_WEBHOOK || null;
const WEBHOOK_MIN_SEVERITY = process.env.SENTINEL_WEBHOOK_MIN_SEVERITY || 'high';

const SEVERITY_RANK = { low: 0, medium: 1, high: 2, critical: 3 };

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
    fetch(ALERT_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `🚨 Sentinel ${event} — [${incident.severity}] ${incident.sensor} @ ${incident.tenant_id} (incident #${incident.id})${summary}`,
      }),
    }).catch((err) => {
      console.error('[Sentinel] alert webhook failed:', err.message);
    });
  }
}
