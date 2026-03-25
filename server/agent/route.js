/**
 * POS Agent — API Route
 *
 * POST /api/agent/chat         — Interactive AI chat (SDK or legacy)
 * POST /api/agent/execute      — Execute a single approved action
 * GET  /api/agent/reports      — List nightly reports
 * GET  /api/agent/reports/config — Get report scheduling config
 * PUT  /api/agent/reports/config — Update report scheduling config
 * GET  /api/agent/reports/:id  — Get specific report
 * GET  /api/agent/usage        — Month-to-date cost/token stats
 */

import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getConn, getTenantId, adminSql } from '../db/index.js';
import { CLAUDE_TOOLS, ACTION_TOOLS } from './tools.js';
import { TOOL_HANDLERS } from './handlers.js';
import { getPlanLimits } from '../planLimits.js';

const router = Router();

// ==================== Configuration ====================

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CHAT_MODEL = 'claude-sonnet-4-6';

// Cost limits
const PER_QUERY_BUDGET = 0.15;   // $0.15 per interactive query
const MONTHLY_CAP = 10.0;        // $10/month per tenant

// System prompt shared by both SDK and legacy paths
const SYSTEM_PROMPT = `You are the AI co-pilot for a restaurant POS system. You help restaurant owners and managers make data-driven decisions about their business.

Your capabilities:
- Analyze sales, inventory, menu performance, delivery metrics, waste, and expenses
- Recommend and execute actions: price changes, menu toggling (86ing items), purchase orders, inventory adjustments, prep lists, loyalty campaigns

Your personality:
- You speak like a sharp, experienced restaurant consultant — concise, actionable, no fluff
- Use restaurant terminology naturally (86, covers, ticket average, food cost %)
- When you find something noteworthy in the data, flag it proactively
- Always show your reasoning with specific numbers before recommending an action
- For money, use the currency symbol appropriate to the data ($ or MXN)

Important rules:
- ALWAYS call the relevant data tools before making recommendations. Never guess.
- When recommending an ACTION (price change, purchase order, etc.), call the action tool — the system will pause for owner approval before executing.
- Keep responses focused. Restaurant owners are busy.
- If you spot something concerning (high waste, declining sales, inventory running out), lead with that.`;

// ==================== Claude API ====================

async function callClaude(messages, tools) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }

  const model = CHAT_MODEL;

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools,
      messages,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    console.error('[Agent] Claude API error:', response.status, error);
    throw new Error(`Claude API error: ${response.status}`);
  }

  return response.json();
}

async function chatWithClaude(clientMessages, conn, tenantId) {
  const toolCtx = { conn, tenantId };
  const messages = [...clientMessages];
  const pendingActions = [];
  let iterations = 0;
  const MAX_ITERATIONS = 10;
  const startTime = Date.now();

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    const response = await callClaude(messages, CLAUDE_TOOLS);
    const toolUses = response.content.filter(c => c.type === 'tool_use');
    const textBlocks = response.content.filter(c => c.type === 'text');

    if (toolUses.length === 0) {
      return {
        resultText: textBlocks.map(t => t.text).join('\n'),
        pendingActions,
        durationMs: Date.now() - startTime,
      };
    }

    const toolResults = [];
    let hasActions = false;

    for (const toolUse of toolUses) {
      if (ACTION_TOOLS.has(toolUse.name)) {
        hasActions = true;
        pendingActions.push({
          tool_use_id: toolUse.id,
          tool_name: toolUse.name,
          input: toolUse.input,
          description: describeAction(toolUse.name, toolUse.input),
        });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify({
            status: 'pending_approval',
            message: 'This action requires owner approval. It will be executed when approved.',
          }),
        });
      } else {
        const handler = TOOL_HANDLERS[toolUse.name];
        if (!handler) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: JSON.stringify({ error: `Unknown tool: ${toolUse.name}` }),
            is_error: true,
          });
          continue;
        }

        try {
          const result = await handler({ input: toolUse.input, ...toolCtx });
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: JSON.stringify(result),
          });
        } catch (err) {
          console.error(`[Agent] Tool execution error: ${toolUse.name}`, err);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: JSON.stringify({ error: err.message }),
            is_error: true,
          });
        }
      }
    }

    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResults });

    if (hasActions && response.stop_reason === 'tool_use') {
      const summaryResponse = await callClaude(messages, CLAUDE_TOOLS);
      const summaryText = summaryResponse.content
        .filter(c => c.type === 'text')
        .map(t => t.text)
        .join('\n');

      return {
        resultText: summaryText || 'I have some recommendations that need your approval.',
        pendingActions,
        durationMs: Date.now() - startTime,
      };
    }

    if (response.stop_reason === 'end_turn') {
      const finalText = response.content
        .filter(c => c.type === 'text')
        .map(t => t.text)
        .join('\n');

      return {
        resultText: finalText,
        pendingActions,
        durationMs: Date.now() - startTime,
      };
    }
  }

  return {
    resultText: 'I gathered a lot of data but hit my analysis limit. Could you narrow your question?',
    pendingActions: [],
    durationMs: Date.now() - startTime,
  };
}

// ==================== Cost Tracking ====================

async function checkMonthlyCap(tenantId) {
  const [row] = await adminSql`
    SELECT COALESCE(SUM(cost_usd), 0)::numeric as total
    FROM agent_runs
    WHERE tenant_id = ${tenantId}
      AND created_at >= date_trunc('month', NOW())
  `;
  return Number(row.total);
}

async function logAgentRun(tenantId, { triggerType, promptSummary, model, durationMs, status, errorMessage, costUsd }) {
  try {
    await adminSql`
      INSERT INTO agent_runs (tenant_id, trigger_type, prompt_summary, model, cost_usd, duration_ms, status, error_message)
      VALUES (${tenantId}, ${triggerType || 'chat'}, ${promptSummary || null}, ${model || SDK_MODEL}, ${costUsd || 0}, ${durationMs || 0}, ${status || 'success'}, ${errorMessage || null})
    `;
  } catch (err) {
    console.error('[Agent] Failed to log run:', err.message);
  }
}

// ==================== Routes ====================

/**
 * POST /api/agent/chat — Main interactive chat
 */
router.post('/chat', requireAuth('view_dashboard'), async (req, res) => {
  try {
    const tenantPlan = req.tenant?.plan || 'free';
    const limits = getPlanLimits(tenantPlan);
    if (limits.ai?.mode === 'none') {
      return res.status(403).json({ error: 'PLAN_UPGRADE_REQUIRED', feature: 'ai', requiredPlan: 'pro', currentPlan: tenantPlan });
    }

    const { messages: clientMessages, approved_actions } = req.body;

    if (!clientMessages || !Array.isArray(clientMessages)) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    if (!ANTHROPIC_API_KEY) {
      return res.status(503).json({ error: 'AI agent not configured. Set ANTHROPIC_API_KEY.' });
    }

    const conn = getConn();
    const tenantId = getTenantId();

    // Check monthly cost cap
    const monthlySpend = await checkMonthlyCap(tenantId);
    if (monthlySpend >= MONTHLY_CAP) {
      return res.status(429).json({
        error: 'Monthly AI budget exceeded',
        monthly_spend: monthlySpend,
        monthly_cap: MONTHLY_CAP,
      });
    }

    // Handle approved actions first (same for both SDK and legacy)
    let messages = [...clientMessages];
    if (approved_actions && approved_actions.length > 0) {
      const toolCtx = { conn, tenantId };
      for (const action of approved_actions) {
        if (!TOOL_HANDLERS[action.tool_name]) continue;
        try {
          const result = await TOOL_HANDLERS[action.tool_name]({
            input: action.input,
            ...toolCtx,
          });
          messages.push({
            role: 'assistant',
            content: [{
              type: 'tool_use',
              id: action.tool_use_id,
              name: action.tool_name,
              input: action.input,
            }],
          });
          messages.push({
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: action.tool_use_id,
              content: JSON.stringify(result),
            }],
          });
        } catch (err) {
          console.error(`[Agent] Action execution failed: ${action.tool_name}`, err);
          messages.push({
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: action.tool_use_id,
              content: JSON.stringify({ error: err.message }),
              is_error: true,
            }],
          });
        }
      }
    }

    // Summarize prompt for logging
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
    const promptSummary = typeof lastUserMsg?.content === 'string'
      ? lastUserMsg.content.slice(0, 200)
      : 'multi-turn conversation';

    // Run chat
    let result;
    try {
      result = await chatWithClaude(messages, conn, tenantId);
    } catch (err) {
      console.error('[Agent] Chat engine error:', err);
      await logAgentRun(tenantId, {
        triggerType: 'chat',
        promptSummary,
        model: CHAT_MODEL,
        durationMs: 0,
        status: 'error',
        errorMessage: err.message,
      });
      throw err;
    }

    // Estimate cost (rough: $3/1M input + $15/1M output for Sonnet 4.6)
    const estimatedCost = 0.01;

    // Log successful run
    await logAgentRun(tenantId, {
      triggerType: 'chat',
      promptSummary,
      model: CHAT_MODEL,
      durationMs: result.durationMs,
      status: 'success',
      costUsd: estimatedCost,
    });

    return res.json({
      messages: [{
        role: 'assistant',
        text: result.resultText,
      }],
      pending_actions: result.pendingActions.length > 0 ? result.pendingActions : undefined,
      cost_usd: estimatedCost,
    });

  } catch (err) {
    console.error('[Agent] Chat error:', err);
    return res.status(500).json({ error: 'Agent error: ' + err.message });
  }
});

/**
 * POST /api/agent/execute — Execute a single approved action
 */
router.post('/execute', requireAuth('view_dashboard'), async (req, res) => {
  try {
    const tenantPlan = req.tenant?.plan || 'free';
    const exLimits = getPlanLimits(tenantPlan);
    if (exLimits.ai?.mode === 'none') {
      return res.status(403).json({ error: 'PLAN_UPGRADE_REQUIRED', feature: 'ai', requiredPlan: 'pro', currentPlan: tenantPlan });
    }

    const { tool_name, tool_use_id, input } = req.body;

    if (!tool_name || !input) {
      return res.status(400).json({ error: 'tool_name and input are required' });
    }

    if (!ACTION_TOOLS.has(tool_name)) {
      return res.status(400).json({ error: 'Not an action tool' });
    }

    const handler = TOOL_HANDLERS[tool_name];
    if (!handler) {
      return res.status(400).json({ error: `Unknown tool: ${tool_name}` });
    }

    const conn = getConn();
    const tenantId = getTenantId();
    const result = await handler({ input, conn, tenantId });

    return res.json({ success: true, result });
  } catch (err) {
    console.error('[Agent] Execute error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ==================== Report Endpoints ====================

/**
 * GET /api/agent/reports — List recent reports for tenant
 */
router.get('/reports', requireAuth('view_dashboard'), async (req, res) => {
  try {
    const conn = getConn();
    const limit = Math.min(parseInt(req.query.limit) || 30, 100);

    const reports = await conn`
      SELECT id, report_date, report_type, highlights, cost_usd, created_at
      FROM agent_reports
      ORDER BY report_date DESC
      LIMIT ${limit}
    `;

    return res.json({ reports });
  } catch (err) {
    console.error('[Agent] List reports error:', err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/agent/reports/config — Get scheduling config
 */
router.get('/reports/config', requireAuth('view_dashboard'), async (req, res) => {
  try {
    const conn = getConn();
    const [config] = await conn`
      SELECT enabled, report_hour, timezone, delivery_method, custom_prompt, updated_at
      FROM agent_report_config
      LIMIT 1
    `;

    return res.json({
      config: config || {
        enabled: false,
        report_hour: 5,
        timezone: 'America/Mexico_City',
        delivery_method: 'in_app',
        custom_prompt: null,
      },
    });
  } catch (err) {
    console.error('[Agent] Get report config error:', err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/agent/reports/config — Update scheduling config
 */
router.put('/reports/config', requireAuth('view_dashboard'), async (req, res) => {
  try {
    const tenantPlan = req.tenant?.plan || 'free';
    const limits = getPlanLimits(tenantPlan);
    if (limits.ai?.mode === 'none') {
      return res.status(403).json({ error: 'PLAN_UPGRADE_REQUIRED', feature: 'ai', requiredPlan: 'pro', currentPlan: tenantPlan });
    }

    const tenantId = getTenantId();
    const { enabled, report_hour, timezone, delivery_method, custom_prompt } = req.body;

    const hour = typeof report_hour === 'number' ? Math.max(0, Math.min(23, report_hour)) : 5;

    await adminSql`
      INSERT INTO agent_report_config (tenant_id, enabled, report_hour, timezone, delivery_method, custom_prompt, updated_at)
      VALUES (
        ${tenantId},
        ${enabled ?? false},
        ${hour},
        ${timezone || 'America/Mexico_City'},
        ${delivery_method || 'in_app'},
        ${custom_prompt || null},
        NOW()
      )
      ON CONFLICT (tenant_id) DO UPDATE SET
        enabled = EXCLUDED.enabled,
        report_hour = EXCLUDED.report_hour,
        timezone = EXCLUDED.timezone,
        delivery_method = EXCLUDED.delivery_method,
        custom_prompt = EXCLUDED.custom_prompt,
        updated_at = NOW()
    `;

    return res.json({ success: true });
  } catch (err) {
    console.error('[Agent] Update report config error:', err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/agent/reports/:id — Get specific report
 */
router.get('/reports/:id', requireAuth('view_dashboard'), async (req, res) => {
  try {
    const conn = getConn();
    const [report] = await conn`
      SELECT id, report_date, report_type, content_md, highlights, cost_usd, created_at
      FROM agent_reports
      WHERE id = ${req.params.id}
    `;

    if (!report) {
      return res.status(404).json({ error: 'Report not found' });
    }

    return res.json({ report });
  } catch (err) {
    console.error('[Agent] Get report error:', err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/agent/usage — Month-to-date cost/token stats
 */
router.get('/usage', requireAuth('view_dashboard'), async (req, res) => {
  try {
    const conn = getConn();

    const [stats] = await conn`
      SELECT
        COUNT(*) as total_runs,
        COALESCE(SUM(cost_usd), 0) as total_cost,
        COALESCE(SUM(input_tokens), 0) as total_input_tokens,
        COALESCE(SUM(output_tokens), 0) as total_output_tokens,
        COALESCE(AVG(duration_ms), 0) as avg_duration_ms,
        COUNT(*) FILTER (WHERE trigger_type = 'chat') as chat_runs,
        COUNT(*) FILTER (WHERE trigger_type = 'scheduled') as scheduled_runs,
        COUNT(*) FILTER (WHERE status = 'error') as error_count
      FROM agent_runs
      WHERE created_at >= date_trunc('month', NOW())
    `;

    return res.json({
      period: 'current_month',
      monthly_cap: MONTHLY_CAP,
      ...stats,
    });
  } catch (err) {
    console.error('[Agent] Usage error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ==================== Helpers ====================

function describeAction(toolName, input) {
  switch (toolName) {
    case 'update_menu_item_price':
      return `Change price to $${input.new_price} — ${input.reason}`;
    case 'toggle_menu_item':
      return input.active
        ? `Re-enable menu item — ${input.reason}`
        : `86 (disable) menu item — ${input.reason}`;
    case 'create_purchase_order':
      return `Create PO with ${input.items.length} items`;
    case 'update_inventory_quantity':
      return `Adjust inventory to ${input.new_quantity} — ${input.reason}`;
    case 'create_prep_list':
      return `Generate prep list for ${input.target_date || 'tomorrow'}`;
    case 'send_loyalty_campaign':
      return `Send SMS to "${input.filter}" segment: "${input.message}"`;
    default:
      return `Execute ${toolName}`;
  }
}

export default router;
