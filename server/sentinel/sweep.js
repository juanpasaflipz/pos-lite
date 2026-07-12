/**
 * Sentinel — Sweep loop
 *
 * Same harness as server/lib/autoCompleteReadyOrders.js: 60s setInterval,
 * cross-tenant adminSql, start/stop wired into server boot + graceful
 * shutdown. Everything here is deterministic; the only LLM entry point is
 * the fire-and-forget triage kick for NEW incidents.
 *
 * Per sweep, per sensor:
 *   1. run the sensor → current match set
 *   2. upsert matches (dedup on (tenant_id, sensor, dedup_key) — an existing
 *      incident gets a last_seen_at bump, NOT a re-triage or re-notification)
 *   3. self-heal: active incidents whose condition no longer matches are
 *      resolved with a 'self_healed' action, dedup slot freed via ':r<id>'
 *      suffix so a recurrence opens a fresh incident
 *   4. kick triage for genuinely new incidents
 */

import { adminSql } from '../db/index.js';
import { SENSORS } from './sensors.js';
import { triageIncident } from './triage.js';
import { notifyIncident } from './notify.js';

const SWEEP_INTERVAL_MS = Number(process.env.SENTINEL_SWEEP_INTERVAL_MS) || 60_000;
const ACTIVE_STATUSES = ['open', 'diagnosing', 'waiting_approval', 'needs_human'];

let timer = null;

/**
 * Run every sensor once. Exported for tests; `triage: false` keeps tests
 * deterministic and LLM-free (CI has no ANTHROPIC_API_KEY anyway — this
 * makes it explicit).
 */
export async function sweepOnce({ triage = true } = {}) {
  const summary = { detected: 0, new: 0, selfHealed: 0 };

  for (const sensor of SENSORS) {
    let matches;
    try {
      matches = await sensor.run();
    } catch (err) {
      console.error(`[Sentinel] sensor ${sensor.id} failed:`, err.message);
      continue;
    }
    summary.detected += matches.length;

    // -- upsert current matches ------------------------------------------
    const newIncidents = [];
    for (const m of matches) {
      try {
        const [row] = await adminSql`
          INSERT INTO sentinel_incidents
            (tenant_id, sensor, dedup_key, severity, subject_table, subject_id, evidence)
          VALUES
            (${m.tenantId}, ${sensor.id}, ${m.dedupKey}, ${m.severity},
             ${m.subjectTable ?? null}, ${m.subjectId ?? null}, ${adminSql.json(m.evidence)})
          ON CONFLICT (tenant_id, sensor, dedup_key)
          DO UPDATE SET last_seen_at = NOW(), evidence = EXCLUDED.evidence
          RETURNING id, tenant_id, sensor, dedup_key, severity, status,
                    subject_table, subject_id, evidence, diagnosis,
                    (xmax = 0) AS inserted
        `;
        if (row.inserted) newIncidents.push(row);
      } catch (err) {
        console.error(`[Sentinel] upsert failed for ${sensor.id}/${m.dedupKey}:`, err.message);
      }
    }

    // -- self-heal cleared incidents --------------------------------------
    try {
      const currentKeys = matches.map((m) => `${m.tenantId}|${m.dedupKey}`);
      const healed = await adminSql`
        UPDATE sentinel_incidents
        SET status = 'resolved',
            resolved_at = NOW(),
            actions = actions || ${adminSql.json([{ type: 'self_healed', at: new Date().toISOString() }])},
            dedup_key = dedup_key || ':r' || id
        WHERE sensor = ${sensor.id}
          AND status = ANY(${ACTIVE_STATUSES}::text[])
          AND NOT (tenant_id || '|' || dedup_key = ANY(${currentKeys}::text[]))
        RETURNING id, tenant_id, sensor, severity, status, subject_table, subject_id
      `;
      summary.selfHealed += healed.length;
      for (const h of healed) notifyIncident(h, 'self-healed');
    } catch (err) {
      console.error(`[Sentinel] self-heal pass failed for ${sensor.id}:`, err.message);
    }

    // -- triage new incidents (fire-and-forget) ----------------------------
    summary.new += newIncidents.length;
    for (const incident of newIncidents) {
      notifyIncident(incident, 'detected');
      if (triage) {
        triageIncident(incident).catch((err) =>
          console.error(`[Sentinel] triage kick failed for incident ${incident.id}:`, err.message)
        );
      }
    }
  }

  if (summary.new > 0 || summary.selfHealed > 0) {
    console.log(
      `[Sentinel] sweep: ${summary.detected} matching, ${summary.new} new, ${summary.selfHealed} self-healed`
    );
  }
  return summary;
}

export function startSentinelSweep() {
  if (process.env.SENTINEL_ENABLED === 'off') {
    console.log('[Sentinel] disabled via SENTINEL_ENABLED=off');
    return;
  }
  // Local `npm run dev` connects to the same prod Neon DATABASE_URL. Without
  // this gate, a laptop-side boot would detect real prod incidents and fire
  // real notifications from the developer's misconfigured Twilio/Slack
  // credentials. Explicit override for intentional local sweep testing.
  if (process.env.NODE_ENV !== 'production' && process.env.ENABLE_BACKGROUND_SMS !== 'true') {
    console.log('[Sentinel] sweep disabled (NODE_ENV != production; set ENABLE_BACKGROUND_SMS=true to override)');
    return;
  }
  if (timer) return;
  sweepOnce().catch((err) => console.error('[Sentinel] initial sweep failed:', err.message));
  timer = setInterval(() => {
    sweepOnce().catch((err) => console.error('[Sentinel] sweep failed:', err.message));
  }, SWEEP_INTERVAL_MS);
  timer.unref?.();
  console.log(
    `[Sentinel] sweep started (every ${SWEEP_INTERVAL_MS / 1000}s, ${SENSORS.length} sensors, ` +
    `autofix=${process.env.SENTINEL_AUTOFIX === 'on' ? 'ON' : 'shadow'})`
  );
}

export function stopSentinelSweep() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
