/**
 * Sentinel — API surface for the incident panel
 *
 * Mounted at /api/sentinel AFTER the tenant middleware, so reads go through
 * the normal RLS-scoped connection (get/all) — a tenant can only ever see
 * its own incidents, structurally.
 *
 * Endpoints:
 *   GET  /api/sentinel/incidents?status=&limit=   — list (view_dashboard)
 *   GET  /api/sentinel/status                     — sentinel config for the panel
 *   POST /api/sentinel/incidents/:id/dismiss      — human waves it off (view_dashboard)
 *   POST /api/sentinel/incidents/:id/approve      — execute the proposed playbook
 *                                                   LIVE (void_orders — money-adjacent)
 *
 * Approve deliberately overrides shadow mode: SENTINEL_AUTOFIX=off means the
 * sentinel won't act on its own, but an explicit human click IS the approval.
 * This is the intended shadow-mode rollout loop: watch diagnoses → approve by
 * hand → build trust → flip autofix on.
 */

import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { all, get, run } from '../db/index.js';
import { PLAYBOOKS, executePlaybook } from './playbooks.js';
import { isTriageEnabled, isAutofixEnabled } from './triage.js';
import { SENSORS } from './sensors.js';

const router = Router();

const LISTABLE_STATUSES = new Set([
  'open', 'diagnosing', 'auto_fixed', 'waiting_approval', 'needs_human', 'resolved', 'dismissed',
]);

// GET /api/sentinel/incidents
router.get('/incidents', requireAuth('view_dashboard'), async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const status = req.query.status;
    if (status && !LISTABLE_STATUSES.has(status)) {
      return res.status(400).json({ error: 'Invalid status filter' });
    }

    const rows = status
      ? await all(
          `SELECT id, sensor, dedup_key, severity, status, subject_table, subject_id,
                  evidence, diagnosis, actions, first_seen_at, last_seen_at, resolved_at
           FROM sentinel_incidents
           WHERE status = $1
           ORDER BY last_seen_at DESC LIMIT $2`,
          [status, limit]
        )
      : await all(
          `SELECT id, sensor, dedup_key, severity, status, subject_table, subject_id,
                  evidence, diagnosis, actions, first_seen_at, last_seen_at, resolved_at
           FROM sentinel_incidents
           ORDER BY (status IN ('open','diagnosing','waiting_approval','needs_human')) DESC,
                    last_seen_at DESC
           LIMIT $1`,
          [limit]
        );
    res.json(rows);
  } catch (err) {
    console.error('[Sentinel] list incidents failed:', err.message);
    res.status(500).json({ error: 'Failed to list incidents' });
  }
});

// GET /api/sentinel/status — config snapshot for the panel header
router.get('/status', requireAuth('view_dashboard'), async (_req, res) => {
  res.json({
    enabled: process.env.SENTINEL_ENABLED !== 'off',
    triage: isTriageEnabled(),
    autofix: isAutofixEnabled(),
    mode: isAutofixEnabled() ? 'autofix' : 'shadow',
    sensors: SENSORS.map((s) => s.id),
    playbooks: Object.entries(PLAYBOOKS).map(([id, p]) => ({ id, title: p.title, auto: p.auto })),
  });
});

// POST /api/sentinel/incidents/:id/dismiss
router.post('/incidents/:id/dismiss', requireAuth('view_dashboard'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    // Free the dedup slot (':d<id>') so a recurrence opens a fresh incident.
    const updated = await get(
      `UPDATE sentinel_incidents
       SET status = 'dismissed',
           resolved_at = NOW(),
           dedup_key = dedup_key || ':d' || id
       WHERE id = $1
         AND status IN ('open','diagnosing','waiting_approval','needs_human')
       RETURNING id, status`,
      [id]
    );
    if (!updated) return res.status(404).json({ error: 'Incident not found or not dismissable' });
    res.json({ ok: true, incident: updated });
  } catch (err) {
    console.error('[Sentinel] dismiss failed:', err.message);
    res.status(500).json({ error: 'Failed to dismiss incident' });
  }
});

// POST /api/sentinel/incidents/:id/approve — execute proposed playbook LIVE
router.post('/incidents/:id/approve', requireAuth('void_orders'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const incident = await get(
      `SELECT id, tenant_id, sensor, severity, status, subject_table, subject_id,
              evidence, diagnosis
       FROM sentinel_incidents WHERE id = $1`,
      [id]
    );
    if (!incident) return res.status(404).json({ error: 'Incident not found' });
    if (!['needs_human', 'waiting_approval'].includes(incident.status)) {
      return res.status(409).json({ error: `Incident is '${incident.status}', not approvable` });
    }

    const playbookId = incident.diagnosis?.proposed_playbook;
    if (!playbookId || !PLAYBOOKS[playbookId]) {
      return res.status(400).json({ error: 'No executable playbook proposed for this incident' });
    }

    // Explicit human approval — run LIVE regardless of shadow mode.
    const result = await executePlaybook(playbookId, incident, { shadow: false });
    const outcome = result.fixed ? 'resolved' : 'needs_human';

    const action = {
      playbook: playbookId,
      shadow: false,
      approved_by: req.employee?.id ?? 'owner',
      result,
      at: new Date().toISOString(),
    };
    await run(
      `UPDATE sentinel_incidents
       SET status = $2,
           actions = actions || $3::jsonb,
           resolved_at = CASE WHEN $2 = 'resolved' THEN NOW() ELSE resolved_at END,
           dedup_key = CASE WHEN $2 = 'resolved' THEN dedup_key || ':r' || id ELSE dedup_key END
       WHERE id = $1`,
      [id, outcome, JSON.stringify([action])]
    );

    res.json({ ok: true, executed: playbookId, result, status: outcome });
  } catch (err) {
    console.error('[Sentinel] approve failed:', err.message);
    res.status(500).json({ error: 'Failed to execute playbook' });
  }
});

export default router;
