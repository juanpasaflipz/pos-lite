/**
 * POS Agent — Nightly Report Scheduler
 *
 * Runs every hour via node-cron. For each eligible tenant:
 *   1. Check if current hour matches their configured report_hour in their timezone
 *   2. Check if a report already exists for yesterday
 *   3. Generate a read-only agent report using the Anthropic API
 *   4. Store in agent_reports table, log to agent_runs
 */

import cron from 'node-cron';
import { adminSql, tenantSql } from '../db/index.js';
import { AGENT_TOOLS } from './tools.js';
import { TOOL_HANDLERS } from './handlers.js';

const REPORT_BUDGET = 0.05; // $0.05 per scheduled report
const REPORT_MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MAX_ITERATIONS = 12;

// Read-only tools only (no action tools in scheduled reports)
const READ_ONLY_TOOLS = AGENT_TOOLS
  .filter(t => t.category === 'read')
  .map(({ category, ...tool }) => tool);

const REPORT_SYSTEM_PROMPT = 'You are a restaurant business analyst. Generate clear, data-driven reports for restaurant owners. Always call data tools before writing the report — never guess at numbers.';

const NIGHTLY_REPORT_PROMPT = `Generate a concise daily business report for yesterday. Include:
1. Revenue summary vs same day last week
2. Top 5 selling items and notable changes
3. Inventory alerts (low stock, trending toward stockout)
4. Waste summary if any was logged
5. One actionable recommendation for today

Be concise. Use bullet points. Lead with the most important insight.
Format the report in markdown.`;

/**
 * Get the current hour in a given timezone.
 */
function getCurrentHourInTimezone(tz) {
  try {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric',
      hour12: false,
    });
    return parseInt(formatter.format(now), 10);
  } catch {
    // Fallback to America/Mexico_City (UTC-6)
    const now = new Date();
    const utcHour = now.getUTCHours();
    return (utcHour - 6 + 24) % 24;
  }
}

/**
 * Get yesterday's date string in YYYY-MM-DD format for a timezone.
 */
function getYesterdayInTimezone(tz) {
  try {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 86400000);
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: tz }); // en-CA gives YYYY-MM-DD
    return formatter.format(yesterday);
  } catch {
    const yesterday = new Date(Date.now() - 86400000);
    return yesterday.toISOString().slice(0, 10);
  }
}

/**
 * Call Claude API directly (no Agent SDK — works in any environment).
 */
async function callClaudeForReport(messages) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: REPORT_MODEL,
      max_tokens: 4096,
      system: REPORT_SYSTEM_PROMPT,
      tools: READ_ONLY_TOOLS,
      messages,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Claude API error: ${response.status} — ${error.slice(0, 200)}`);
  }

  return response.json();
}

/**
 * Generate a nightly report for a single tenant using raw API with tool loop.
 */
async function generateReport(tenantId, customPrompt) {
  const startTime = Date.now();

  try {
    // Reserve a connection and set tenant context
    const conn = await tenantSql.reserve();
    try {
      await conn`SELECT set_config('app.tenant_id', ${tenantId}, true)`;

      const toolCtx = { conn, tenantId };
      const prompt = customPrompt || NIGHTLY_REPORT_PROMPT;
      const messages = [{ role: 'user', content: prompt }];
      let iterations = 0;

      while (iterations < MAX_ITERATIONS) {
        iterations++;
        const response = await callClaudeForReport(messages);
        const toolUses = response.content.filter(c => c.type === 'tool_use');
        const textBlocks = response.content.filter(c => c.type === 'text');

        // No tool calls — we have the final report
        if (toolUses.length === 0 || response.stop_reason === 'end_turn') {
          const resultText = textBlocks.map(t => t.text).join('\n');
          return { resultText, durationMs: Date.now() - startTime, error: null };
        }

        // Execute read-only tools and feed results back
        const toolResults = [];
        for (const toolUse of toolUses) {
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
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: JSON.stringify({ error: err.message }),
              is_error: true,
            });
          }
        }

        messages.push({ role: 'assistant', content: response.content });
        messages.push({ role: 'user', content: toolResults });
      }

      return { resultText: 'Report generation hit iteration limit.', durationMs: Date.now() - startTime, error: null };
    } finally {
      await conn.release();
    }
  } catch (err) {
    console.error(`[Scheduler] Report generation failed for tenant ${tenantId}:`, err.message);
    return { resultText: null, durationMs: Date.now() - startTime, error: err.message };
  }
}

/**
 * Main scheduler tick — runs every hour.
 * Finds tenants whose report_hour matches the current hour in their timezone
 * and generates reports for them.
 */
async function schedulerTick() {
  try {
    // Get all enabled configs
    const configs = await adminSql`
      SELECT arc.tenant_id, arc.report_hour, arc.timezone, arc.custom_prompt,
             t.plan
      FROM agent_report_config arc
      JOIN tenants t ON t.id = arc.tenant_id
      WHERE arc.enabled = true AND t.plan = 'pro'
    `;

    if (configs.length === 0) return;

    for (const config of configs) {
      try {
        const currentHour = getCurrentHourInTimezone(config.timezone);

        // Skip if not the right hour
        if (currentHour !== config.report_hour) continue;

        const yesterday = getYesterdayInTimezone(config.timezone);

        // Check if report already exists for yesterday
        const [existing] = await adminSql`
          SELECT id FROM agent_reports
          WHERE tenant_id = ${config.tenant_id}
            AND report_date = ${yesterday}::date
            AND report_type = 'nightly'
        `;

        if (existing) continue; // Already generated

        console.log(`[Scheduler] Generating nightly report for tenant ${config.tenant_id} (${yesterday})`);

        const { resultText, durationMs, error } = await generateReport(
          config.tenant_id,
          config.custom_prompt,
        );

        if (resultText) {
          // Store the report
          await adminSql`
            INSERT INTO agent_reports (tenant_id, report_date, report_type, content_md, cost_usd)
            VALUES (${config.tenant_id}, ${yesterday}::date, 'nightly', ${resultText}, ${REPORT_BUDGET})
            ON CONFLICT (tenant_id, report_date, report_type) DO NOTHING
          `;

          // Log successful run
          await adminSql`
            INSERT INTO agent_runs (tenant_id, trigger_type, prompt_summary, model, cost_usd, duration_ms, status)
            VALUES (${config.tenant_id}, 'scheduled', 'Nightly report', ${REPORT_MODEL}, ${REPORT_BUDGET}, ${durationMs}, 'success')
          `;

          console.log(`[Scheduler] Report generated for tenant ${config.tenant_id} in ${durationMs}ms`);
        } else {
          // Log failed run
          await adminSql`
            INSERT INTO agent_runs (tenant_id, trigger_type, prompt_summary, model, duration_ms, status, error_message)
            VALUES (${config.tenant_id}, 'scheduled', 'Nightly report', ${REPORT_MODEL}, ${durationMs}, 'error', ${error || 'Empty result'})
          `;
        }
      } catch (err) {
        console.error(`[Scheduler] Error processing tenant ${config.tenant_id}:`, err.message);
        // Continue to next tenant — don't let one failure stop others
      }
    }
  } catch (err) {
    console.error('[Scheduler] Tick error:', err.message);
  }
}

/**
 * Initialize the scheduler. Call once at server startup.
 * Runs every hour at minute 0.
 */
export function initAgentScheduler() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('[Scheduler] ANTHROPIC_API_KEY not set — agent scheduler disabled');
    return;
  }

  // Run every hour at minute 0
  cron.schedule('0 * * * *', schedulerTick, {
    timezone: 'UTC',
  });

  console.log('[Scheduler] Agent report scheduler initialized (runs hourly)');
}

// Export for manual triggering (testing)
export { schedulerTick, generateReport };
