import { fetchWithTimeout } from '../lib/http.js';
/**
 * Sentinel — Triage (the only place the LLM appears)
 *
 * Woken per NEW incident by the sweep — never polls, never watches.
 * (docs/ai-sentinel-design.md §4)
 *
 * Loop shape mirrors server/agent/route.js: bounded tool-use loop against
 * the Messages API. Diagnostic tools are READ-ONLY (implemented in
 * playbooks.js); the model must finish by calling submit_diagnosis, choosing
 * a playbook from the registry or null. It cannot invent remediations.
 *
 * Execution policy after diagnosis:
 *   - proposed playbook is auto-safe + SENTINEL_AUTOFIX=on  → execute live → auto_fixed
 *   - proposed playbook is auto-safe + shadow mode (default) → dry-run, record
 *     exactly what WOULD happen → needs_human (approvable from the panel)
 *   - no playbook matched / guards aborted                   → needs_human
 *
 * Budget: hard per-tenant daily cap (SENTINEL_TRIAGE_DAILY_CAP, default 20)
 * + the dedup upstream. A sensor bug opening 500 incidents must not mean
 * 500 API calls — beyond the cap, incidents skip triage and go straight to
 * needs_human with a 'budget_cap' marker.
 */

import { adminSql } from '../db/index.js';
import {
  PLAYBOOKS,
  executePlaybook,
  pullPaymentStatus,
  getOrderTimeline,
  getDeviceLiveness,
} from './playbooks.js';
import { notifyIncident } from './notify.js';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-6'; // keep in sync with server/agent/route.js
const MAX_ITERATIONS = 5;

const TRIAGE_DAILY_CAP = Number(process.env.SENTINEL_TRIAGE_DAILY_CAP) || 20;

export function isTriageEnabled() {
  return Boolean(ANTHROPIC_API_KEY) && process.env.SENTINEL_TRIAGE !== 'off';
}

export function isAutofixEnabled() {
  return process.env.SENTINEL_AUTOFIX === 'on';
}

// ---------------------------------------------------------------------------
// Per-tenant daily budget (in-memory — single Railway service, resets on
// deploy, which is acceptable for a rate limiter).
// ---------------------------------------------------------------------------

const budgetCounters = new Map(); // tenantId → { day, count }

export function consumeTriageBudget(tenantId) {
  const day = new Date().toISOString().slice(0, 10);
  const entry = budgetCounters.get(tenantId);
  if (!entry || entry.day !== day) {
    budgetCounters.set(tenantId, { day, count: 1 });
    return true;
  }
  if (entry.count >= TRIAGE_DAILY_CAP) return false;
  entry.count += 1;
  return true;
}

// Test hook.
export function _resetTriageBudget() {
  budgetCounters.clear();
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const TRIAGE_TOOLS = [
  {
    name: 'pull_payment_status',
    description:
      'Live-pull the payment processor for the current status of an order that is pending on a terminal. ' +
      'Ground truth for deciding unstick vs reconcile.',
    input_schema: {
      type: 'object',
      properties: { order_id: { type: 'number' } },
      required: ['order_id'],
    },
  },
  {
    name: 'get_order_timeline',
    description: 'Full order context: order row, payment attempts, recent audit entries.',
    input_schema: {
      type: 'object',
      properties: { order_id: { type: 'number' } },
      required: ['order_id'],
    },
  },
  {
    name: 'get_device_liveness',
    description: "Kitchen display devices for this tenant with last_seen_at — distinguishes 'screen down' from 'orders invisible'.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'submit_diagnosis',
    description:
      'REQUIRED final step. Submit your diagnosis and (optionally) propose ONE playbook from the registry. ' +
      'Set proposed_playbook to null when no registered playbook safely applies.',
    input_schema: {
      type: 'object',
      properties: {
        classification: { type: 'string', description: 'Short machine-readable label, e.g. dead_intent, orphan_paid_order, kds_offline, abandoned_cash_draft' },
        confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
        explanation: { type: 'string', description: 'Owner-facing explanation in Spanish. Concrete, no fluff, includes the numbers.' },
        proposed_playbook: {
          type: ['string', 'null'],
          enum: [...Object.keys(PLAYBOOKS), null],
        },
      },
      required: ['classification', 'confidence', 'explanation', 'proposed_playbook'],
    },
  },
];

const SYSTEM_PROMPT = `You are the triage brain of a restaurant POS sentinel. A deterministic sensor detected an operational incident; your job is to diagnose it and pick a remediation playbook — or decline.

Rules (NON-NEGOTIABLE):
- Use the diagnostic tools before concluding. For stuck payments, pull_payment_status is ground truth: if the processor says PAID, the fix is reconciliation, NOT unsticking — propose null (reconcile is human-approved in this phase) and say so in the explanation.
- Only propose a playbook when the evidence matches its purpose exactly. When unsure, propose null. A wrong auto-fix is far worse than a needs_human.
- unstick_terminal_payment: ONLY for intents the processor reports as not-paid (dead/expired/pending forever).
- retry_courier_dispatch: ONLY for paid delivery orders with a stashed pending dispatch or dispatch_failed status.
- notify_only: when a human must act physically (kitchen screen down) or per policy (stale cash drafts are NEVER voided).
- explanation is read by a busy restaurant owner on their phone: Spanish, 2-3 sentences, specific.
- Always finish by calling submit_diagnosis. Never finish with plain text.`;

async function callClaude(messages, toolChoice = null) {
  const body = {
    model: MODEL,
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    tools: TRIAGE_TOOLS,
    messages,
  };
  if (toolChoice) body.tool_choice = toolChoice;

  const response = await fetchWithTimeout(ANTHROPIC_API_URL, { timeoutMs: 30000,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Claude API error: ${response.status} ${error.slice(0, 200)}`);
  }
  return response.json();
}

async function runTool(name, input, incident) {
  const tenantId = incident.tenant_id;
  switch (name) {
    case 'pull_payment_status':
      return pullPaymentStatus(tenantId, input.order_id);
    case 'get_order_timeline':
      return getOrderTimeline(tenantId, input.order_id);
    case 'get_device_liveness':
      return getDeviceLiveness(tenantId);
    default:
      return { error: `unknown tool ${name}` };
  }
}

// ---------------------------------------------------------------------------
// Incident state helpers
// ---------------------------------------------------------------------------

// Exported for tests. Explicit ::text/::jsonb casts are load-bearing: a bare
// null parameter inside `CASE WHEN $n IS NULL` gives Postgres no context to
// infer its type and the whole UPDATE fails with "could not determine data
// type of parameter" — which is why no incident ever got a diagnosis written
// before 2026-07-20 (every triage call, including the error handler's own
// fallback write, died on this statement).
export async function updateIncident(id, { status, diagnosis, action }) {
  const actionRow = action ? [{ ...action, at: new Date().toISOString() }] : null;
  // ::text::jsonb (not a bare ::jsonb): with a direct jsonb cast postgres.js
  // types the parameter as jsonb and serializes the pre-stringified JSON as a
  // jsonb STRING scalar (double-encoded). Routing through text makes Postgres
  // itself parse the JSON.
  await adminSql.unsafe(`
    UPDATE sentinel_incidents SET
      status = COALESCE($2::text, status),
      diagnosis = COALESCE($3::text::jsonb, diagnosis),
      actions = CASE WHEN $4::text IS NULL THEN actions ELSE actions || $4::text::jsonb END,
      resolved_at = CASE WHEN $2::text IN ('auto_fixed','resolved') THEN NOW() ELSE resolved_at END
    WHERE id = $1
  `, [
    id,
    status ?? null,
    diagnosis ? JSON.stringify(diagnosis) : null,
    actionRow ? JSON.stringify(actionRow) : null,
  ]);
}

// ---------------------------------------------------------------------------
// Main entry — called by the sweep for each NEW incident (fire-and-forget).
// ---------------------------------------------------------------------------

export async function triageIncident(incident) {
  try {
    if (!isTriageEnabled()) {
      // Sweep-only mode: detection keeps working with AI off.
      notifyIncident(incident, 'detected (triage off)');
      return;
    }
    if (!consumeTriageBudget(incident.tenant_id)) {
      await updateIncident(incident.id, {
        status: 'needs_human',
        diagnosis: { skipped: 'budget_cap', cap: TRIAGE_DAILY_CAP },
      });
      notifyIncident({ ...incident, status: 'needs_human' }, 'budget-capped');
      return;
    }

    await updateIncident(incident.id, { status: 'diagnosing' });

    const messages = [
      {
        role: 'user',
        content:
          `Incident from sensor "${incident.sensor}" (severity ${incident.severity}) ` +
          `for tenant ${incident.tenant_id}.\n\nEvidence:\n${JSON.stringify(incident.evidence, null, 2)}`,
      },
    ];

    let diagnosis = null;
    for (let i = 0; i < MAX_ITERATIONS && !diagnosis; i++) {
      // Force a tool call every turn — the loop only ends via submit_diagnosis.
      const response = await callClaude(messages, { type: 'any' });
      const toolUses = response.content.filter((c) => c.type === 'tool_use');
      if (!toolUses.length) break;

      const results = [];
      for (const toolUse of toolUses) {
        if (toolUse.name === 'submit_diagnosis') {
          diagnosis = toolUse.input;
          results.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: JSON.stringify({ ok: true }),
          });
          continue;
        }
        let result;
        try {
          result = await runTool(toolUse.name, toolUse.input, incident);
        } catch (err) {
          result = { error: err.message };
        }
        results.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify(result),
        });
      }
      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: results });
    }

    if (!diagnosis) {
      await updateIncident(incident.id, {
        status: 'needs_human',
        diagnosis: { skipped: 'no_diagnosis_within_iteration_limit' },
      });
      notifyIncident({ ...incident, status: 'needs_human' }, 'triage-inconclusive');
      return;
    }

    const playbookId = diagnosis.proposed_playbook;
    const playbook = playbookId ? PLAYBOOKS[playbookId] : null;

    if (!playbook || playbookId === 'notify_only') {
      await updateIncident(incident.id, { status: 'needs_human', diagnosis });
      notifyIncident({ ...incident, status: 'needs_human', diagnosis }, 'needs-human');
      return;
    }

    const shadow = !isAutofixEnabled();
    const result = await executePlaybook(playbookId, incident, { shadow });
    const action = { playbook: playbookId, shadow, result };

    if (result.fixed) {
      await updateIncident(incident.id, { status: 'auto_fixed', diagnosis, action });
      notifyIncident({ ...incident, status: 'auto_fixed', diagnosis }, 'auto-fixed');
    } else {
      // shadow dry-run, guard abort, or execution error → a human decides.
      await updateIncident(incident.id, { status: 'needs_human', diagnosis, action });
      notifyIncident(
        { ...incident, status: 'needs_human', diagnosis },
        result.shadow ? 'shadow-diagnosed' : 'fix-aborted'
      );
    }
  } catch (err) {
    console.error(`[Sentinel] triage failed for incident ${incident.id}:`, err.message);
    await updateIncident(incident.id, {
      status: 'needs_human',
      diagnosis: { error: err.message },
    }).catch(() => {});
  }
}
