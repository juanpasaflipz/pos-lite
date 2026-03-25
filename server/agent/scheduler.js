/**
 * POS Agent — Nightly Report Scheduler
 *
 * Runs every hour via node-cron. For each eligible tenant:
 *   1. Check if current hour matches their configured report_hour in their timezone
 *   2. Check if a report already exists for yesterday
 *   3. Generate a read-only agent report using the SDK
 *   4. Store in agent_reports table, log to agent_runs
 */

import cron from 'node-cron';
import { adminSql, tenantSql, tenantContext } from '../db/index.js';
import { createReadOnlyPosServer } from './mcp-server.js';

const REPORT_BUDGET = 0.05; // $0.05 per scheduled report
const REPORT_MODEL = 'claude-sonnet-4-6';

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
 * Generate a nightly report for a single tenant.
 */
async function generateReport(tenantId, customPrompt) {
  const startTime = Date.now();

  try {
    // Reserve a connection and set tenant context
    const conn = await tenantSql.reserve();
    try {
      await conn`SELECT set_config('app.tenant_id', ${tenantId}, true)`;

      const { server: posServer } = createReadOnlyPosServer(conn, tenantId);

      const prompt = customPrompt || NIGHTLY_REPORT_PROMPT;
      let resultText = '';

      const { query } = await import('@anthropic-ai/claude-agent-sdk');

      for await (const message of query({
        prompt,
        options: {
          model: REPORT_MODEL,
          systemPrompt: 'You are a restaurant business analyst. Generate clear, data-driven reports for restaurant owners. Always call data tools before writing the report — never guess at numbers.',
          mcpServers: { pos: posServer },
          allowedTools: ['mcp__pos__*'],
          maxBudgetUsd: REPORT_BUDGET,
          maxTurns: 12,
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          settingSources: [],
        },
      })) {
        if ('result' in message) {
          resultText = message.result;
        }
      }

      const durationMs = Date.now() - startTime;

      return { resultText, durationMs, error: null };
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
