import { fetchWithTimeout } from '../lib/http.js';
/**
 * POS Agent — API Route
 *
 * POST /api/agent/chat
 *   Body: { messages: [...], approved_actions?: [...] }
 *   Returns: { messages: [...], pending_actions?: [...] }
 *
 * The flow:
 *   1. User sends a message
 *   2. We call Claude with the message + tool definitions
 *   3. Claude may call READ tools → we execute them immediately and loop
 *   4. Claude may call ACTION tools → we DON'T execute, instead return them
 *      as "pending_actions" for the UI to render approve/reject buttons
 *   5. When user approves, frontend sends approved_actions back
 *   6. We execute them and tell Claude the results
 *
 * This means Claude's agentic loop runs server-side. The frontend just
 * renders messages and collects approvals.
 */

import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getConn, getTenantId } from '../db/index.js';
import { CLAUDE_TOOLS, ACTION_TOOLS } from './tools.js';
import { TOOL_HANDLERS } from './handlers.js';
import { getPlanLimits } from '../planLimits.js';

const router = Router();

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// System prompt that gives the agent its personality and context
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

Tool-use rules (NON-NEGOTIABLE):
- For ANY question about sales, inventory, menu, waste, payroll, customers, expenses, delivery, or business data, your FIRST action MUST be a tool call. There are no exceptions.
- NEVER speculate about whether data exists. NEVER suggest "the POS may not be connected" or "data may be tied to a different account" — you are running inside the POS, scoped to one tenant, with direct DB access. The tool result is the ground truth.
- If a tool returns zero/empty, REPORT that literally ("0 paid orders in that range") and only then reason about why. Do not pre-emptively claim there is no data without having queried.
- If the user gives a date range, pass it through to start_date/end_date in YYYY-MM-DD form. If the date is ambiguous, pick the most reasonable interpretation and proceed — do not stall asking for clarification on dates.
- When recommending an ACTION (price change, purchase order, etc.), call the action tool — the system will pause for owner approval before executing.

Other rules:
- Keep responses focused. Restaurant owners are busy.
- If you spot something concerning (high waste, declining sales, inventory running out), lead with that.`;

/**
 * True if the last message is a fresh user question — plain text content,
 * no tool_use/tool_result blocks. Used to decide whether to force tool use
 * on the first iteration of the agent loop.
 */
function lastMessageIsPlainUser(messages) {
  if (!messages.length) return false;
  const last = messages[messages.length - 1];
  if (last.role !== 'user') return false;
  if (typeof last.content === 'string') return true;
  if (Array.isArray(last.content)) {
    return last.content.every((c) => c.type === 'text');
  }
  return false;
}

/**
 * Call Claude Messages API with tools. When `toolChoice` is set, the
 * model is forced to pick one — used on the first turn of a data
 * question so the model can't hedge with "POS may not be connected".
 */
async function callClaude(messages, tools, toolChoice = null) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }

  const model = 'claude-sonnet-4-6';

  const body = {
    model,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    tools,
    messages,
  };
  if (toolChoice) body.tool_choice = toolChoice;

  const response = await fetchWithTimeout(ANTHROPIC_API_URL, { timeoutMs: 90000,
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
    console.error('[Agent] Claude API error:', response.status, error);
    throw new Error(`Claude API error: ${response.status}`);
  }

  return response.json();
}

/**
 * Main agent chat endpoint
 */
router.post('/chat', requireAuth('view_dashboard'), async (req, res) => {
  try {
    // Plan gate: AI is Pro-only
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
    const toolCtx = { conn, tenantId };

    // Build the messages array for Claude
    let messages = [...clientMessages];

    // If there are approved actions, execute them and add results
    if (approved_actions && approved_actions.length > 0) {
      for (const action of approved_actions) {
        if (!TOOL_HANDLERS[action.tool_name]) continue;

        try {
          const result = await TOOL_HANDLERS[action.tool_name]({
            input: action.input,
            ...toolCtx,
          });

          // Add the tool use + result to message history so Claude knows what happened
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

    // Agentic loop — keep calling Claude until it stops requesting tools
    const pendingActions = [];
    let iterations = 0;
    const MAX_ITERATIONS = 10; // safety limit

    while (iterations < MAX_ITERATIONS) {
      iterations++;

      // On the first turn, if the last message is a fresh user question
      // (no tool_result blocks yet), force Claude to call a tool. The model
      // has been ignoring the system prompt and answering from priors
      // ("POS may not be connected") — tool_choice='any' makes hedging
      // structurally impossible. Once tool results are in the message
      // history, drop the constraint so Claude can write a text answer.
      const forceTool = iterations === 1 && lastMessageIsPlainUser(messages);
      const toolChoice = forceTool ? { type: 'any' } : null;
      const response = await callClaude(messages, CLAUDE_TOOLS, toolChoice);

      // Check if Claude wants to use tools
      const toolUses = response.content.filter(c => c.type === 'tool_use');
      const textBlocks = response.content.filter(c => c.type === 'text');

      console.log(`[Agent] iter=${iterations} stop=${response.stop_reason} tools=[${toolUses.map(t => t.name).join(',')}]`);

      if (toolUses.length === 0) {
        // No tool calls — Claude is done. Return the final text.
        return res.json({
          messages: [{
            role: 'assistant',
            text: textBlocks.map(t => t.text).join('\n'),
          }],
          pending_actions: pendingActions.length > 0 ? pendingActions : undefined,
        });
      }

      // Process tool calls
      const toolResults = [];
      let hasActions = false;

      for (const toolUse of toolUses) {
        if (ACTION_TOOLS.has(toolUse.name)) {
          // ACTION tool — don't execute, queue for approval
          hasActions = true;
          pendingActions.push({
            tool_use_id: toolUse.id,
            tool_name: toolUse.name,
            input: toolUse.input,
            description: describeAction(toolUse.name, toolUse.input),
          });

          // Tell Claude the action is pending approval
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: JSON.stringify({
              status: 'pending_approval',
              message: 'This action requires owner approval. It will be executed when approved.',
            }),
          });
        } else {
          // READ tool — execute immediately
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

      // Add Claude's response + tool results to messages
      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });

      // If we have pending actions, get Claude's summary and stop
      if (hasActions && response.stop_reason === 'tool_use') {
        // One more call to let Claude summarize what it's proposing
        const summaryResponse = await callClaude(messages, CLAUDE_TOOLS);
        const summaryText = summaryResponse.content
          .filter(c => c.type === 'text')
          .map(t => t.text)
          .join('\n');

        return res.json({
          messages: [{
            role: 'assistant',
            text: summaryText || 'I have some recommendations that need your approval.',
          }],
          pending_actions: pendingActions,
        });
      }

      // If Claude stopped normally (not requesting more tools), we're done
      if (response.stop_reason === 'end_turn') {
        const finalText = response.content
          .filter(c => c.type === 'text')
          .map(t => t.text)
          .join('\n');

        return res.json({
          messages: [{
            role: 'assistant',
            text: finalText,
          }],
          pending_actions: pendingActions.length > 0 ? pendingActions : undefined,
        });
      }
    }

    // Safety: exceeded max iterations
    return res.json({
      messages: [{
        role: 'assistant',
        text: 'I gathered a lot of data but hit my analysis limit. Here\'s what I have so far — could you narrow your question?',
      }],
    });

  } catch (err) {
    console.error('[Agent] Chat error:', err);
    return res.status(500).json({ error: 'Agent error: ' + err.message });
  }
});

/**
 * Execute a single approved action
 */
router.post('/execute', requireAuth('manage_ai'), async (req, res) => {
  try {
    // Plan gate: AI is Pro-only
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

/**
 * Generate a human-readable description of a pending action
 */
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
