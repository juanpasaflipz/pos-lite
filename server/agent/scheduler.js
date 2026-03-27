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

const REPORT_BUDGET = 0.05; // $0.05 per scheduled report (direct API)
const BATCH_REPORT_BUDGET = 0.025; // $0.025 per batch report (50% off)
const REPORT_MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_BATCHES_URL = 'https://api.anthropic.com/v1/messages/batches';
const MAX_ITERATIONS = 12;
const BATCH_POLL_INTERVAL_MS = 30_000; // 30s between polls
const BATCH_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2h max wait

// Read-only tools only (no action tools in scheduled reports)
const READ_ONLY_TOOLS = AGENT_TOOLS
  .filter(t => t.category === 'read')
  .map(({ category, ...tool }) => tool);

const REPORT_SYSTEM_PROMPT = 'You are a restaurant business analyst. Generate clear, data-driven reports for restaurant owners. Always call data tools before writing the report — never guess at numbers.';

const BATCH_REPORT_SYSTEM_PROMPT = 'You are a restaurant business analyst. Generate a concise daily business report from the provided data. All numbers are pre-fetched and accurate — do not ask for more data.';

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
 * Pre-fetch all report data from the DB in parallel.
 * Returns a single JSON snapshot that can be stuffed into the prompt.
 */
async function prefetchReportData(conn, tenantId, yesterday) {
  const lastWeekDate = new Date(new Date(yesterday).getTime() - 7 * 86400000)
    .toISOString().slice(0, 10);

  const [sales, inventory, waste, menu, expenses, lastWeekSales] = await Promise.all([
    TOOL_HANDLERS.get_sales_summary({ input: { start_date: yesterday, end_date: yesterday }, conn }),
    TOOL_HANDLERS.get_inventory_status({ input: { only_low_stock: false }, conn }),
    TOOL_HANDLERS.get_waste_analysis({ input: { days: 1 }, conn }),
    TOOL_HANDLERS.get_menu_performance({ input: { days: 1 }, conn }),
    TOOL_HANDLERS.get_expense_summary({ input: { start_date: yesterday, end_date: yesterday }, conn }),
    TOOL_HANDLERS.get_sales_summary({ input: { start_date: lastWeekDate, end_date: lastWeekDate }, conn }),
  ]);

  return { yesterday, sales, last_week_sales: lastWeekSales, inventory, waste, menu, expenses };
}

/**
 * Build the batch prompt with pre-fetched data inline.
 */
function buildBatchPrompt(prefetchedData, customPrompt) {
  const dataBlock = JSON.stringify(prefetchedData);
  const instructions = customPrompt || `Write a report covering:
1. Revenue summary vs same day last week
2. Top 5 selling items and notable changes
3. Inventory alerts (low stock, trending toward stockout)
4. Waste summary if any was logged
5. One actionable recommendation for today

Be concise. Use bullet points. Lead with the most important insight. Format in markdown.`;

  return `Here is yesterday's data (pre-fetched, all numbers are accurate):

<data>
${dataBlock}
</data>

${instructions}`;
}

/**
 * Submit a batch of report requests to the Anthropic Batches API.
 */
async function submitReportBatch(batchRequests) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  const response = await fetch(ANTHROPIC_BATCHES_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ requests: batchRequests }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Batch API error: ${response.status} — ${error.slice(0, 300)}`);
  }

  return response.json();
}

/**
 * Poll a batch until processing_status === 'ended' or timeout.
 */
async function pollBatchCompletion(batchId) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const startTime = Date.now();

  while (Date.now() - startTime < BATCH_TIMEOUT_MS) {
    await new Promise(r => setTimeout(r, BATCH_POLL_INTERVAL_MS));

    const response = await fetch(`${ANTHROPIC_BATCHES_URL}/${batchId}`, {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Batch poll error: ${response.status} — ${error.slice(0, 200)}`);
    }

    const batch = await response.json();
    if (batch.processing_status === 'ended') return batch;

    console.log(`[Scheduler] Batch ${batchId}: ${batch.request_counts?.processing ?? '?'} processing, ${batch.request_counts?.succeeded ?? 0} succeeded`);
  }

  throw new Error(`Batch ${batchId} timed out after ${BATCH_TIMEOUT_MS / 60000} minutes`);
}

/**
 * Stream batch results (JSONL) and store each report.
 * tenantMap: { custom_id → { tenant_id, yesterday, startTime } }
 */
async function processBatchResults(batchId, tenantMap) {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  const response = await fetch(`${ANTHROPIC_BATCHES_URL}/${batchId}/results`, {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Batch results error: ${response.status} — ${error.slice(0, 200)}`);
  }

  const text = await response.text();
  const lines = text.split('\n').filter(l => l.trim());

  let successCount = 0;
  let errorCount = 0;

  for (const line of lines) {
    try {
      const result = JSON.parse(line);
      const meta = tenantMap[result.custom_id];
      if (!meta) {
        console.error(`[Scheduler] Unknown custom_id in batch result: ${result.custom_id}`);
        continue;
      }

      const durationMs = Date.now() - meta.startTime;

      if (result.result?.type === 'succeeded') {
        const message = result.result.message;
        const reportText = message.content
          .filter(c => c.type === 'text')
          .map(c => c.text)
          .join('\n');

        if (reportText) {
          await adminSql`
            INSERT INTO agent_reports (tenant_id, report_date, report_type, content_md, cost_usd)
            VALUES (${meta.tenant_id}, ${meta.yesterday}::date, 'nightly', ${reportText}, ${BATCH_REPORT_BUDGET})
            ON CONFLICT (tenant_id, report_date, report_type) DO NOTHING
          `;

          await adminSql`
            INSERT INTO agent_runs (tenant_id, trigger_type, prompt_summary, model, cost_usd, duration_ms, status)
            VALUES (${meta.tenant_id}, 'scheduled', 'Nightly report (batch)', ${REPORT_MODEL}, ${BATCH_REPORT_BUDGET}, ${durationMs}, 'success')
          `;

          successCount++;
          console.log(`[Scheduler] Batch report stored for tenant ${meta.tenant_id}`);
        }
      } else {
        const errorMsg = result.result?.error?.message || result.result?.type || 'Unknown batch error';
        await adminSql`
          INSERT INTO agent_runs (tenant_id, trigger_type, prompt_summary, model, duration_ms, status, error_message)
          VALUES (${meta.tenant_id}, 'scheduled', 'Nightly report (batch)', ${REPORT_MODEL}, ${durationMs}, 'error', ${errorMsg})
        `;
        errorCount++;
        console.error(`[Scheduler] Batch report failed for tenant ${meta.tenant_id}: ${errorMsg}`);
      }
    } catch (parseErr) {
      console.error(`[Scheduler] Failed to parse batch result line:`, parseErr.message);
      errorCount++;
    }
  }

  return { successCount, errorCount };
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
 *
 * For 1 tenant: uses direct API (faster, no batch overhead).
 * For 2+ tenants: pre-fetches data and submits a single batch (50% cheaper).
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

    // Filter to tenants eligible right now (correct hour, no existing report)
    const eligible = [];
    for (const config of configs) {
      try {
        const currentHour = getCurrentHourInTimezone(config.timezone);
        if (currentHour !== config.report_hour) continue;

        const yesterday = getYesterdayInTimezone(config.timezone);

        const [existing] = await adminSql`
          SELECT id FROM agent_reports
          WHERE tenant_id = ${config.tenant_id}
            AND report_date = ${yesterday}::date
            AND report_type = 'nightly'
        `;

        if (existing) continue;

        eligible.push({ ...config, yesterday });
      } catch (err) {
        console.error(`[Scheduler] Error checking tenant ${config.tenant_id}:`, err.message);
      }
    }

    if (eligible.length === 0) return;

    // Single tenant — use direct API for speed (batches have minimum latency)
    if (eligible.length === 1) {
      const config = eligible[0];
      console.log(`[Scheduler] Generating nightly report for tenant ${config.tenant_id} (${config.yesterday}) — direct API`);

      const { resultText, durationMs, error } = await generateReport(
        config.tenant_id,
        config.custom_prompt,
      );

      if (resultText) {
        await adminSql`
          INSERT INTO agent_reports (tenant_id, report_date, report_type, content_md, cost_usd)
          VALUES (${config.tenant_id}, ${config.yesterday}::date, 'nightly', ${resultText}, ${REPORT_BUDGET})
          ON CONFLICT (tenant_id, report_date, report_type) DO NOTHING
        `;
        await adminSql`
          INSERT INTO agent_runs (tenant_id, trigger_type, prompt_summary, model, cost_usd, duration_ms, status)
          VALUES (${config.tenant_id}, 'scheduled', 'Nightly report', ${REPORT_MODEL}, ${REPORT_BUDGET}, ${durationMs}, 'success')
        `;
        console.log(`[Scheduler] Report generated for tenant ${config.tenant_id} in ${durationMs}ms`);
      } else {
        await adminSql`
          INSERT INTO agent_runs (tenant_id, trigger_type, prompt_summary, model, duration_ms, status, error_message)
          VALUES (${config.tenant_id}, 'scheduled', 'Nightly report', ${REPORT_MODEL}, ${durationMs}, 'error', ${error || 'Empty result'})
        `;
      }
      return;
    }

    // Multiple tenants — batch flow (50% cheaper)
    console.log(`[Scheduler] Batch report generation for ${eligible.length} tenants`);
    const startTime = Date.now();
    const batchRequests = [];
    const tenantMap = {}; // custom_id → metadata

    for (const config of eligible) {
      let conn;
      try {
        conn = await tenantSql.reserve();
        await conn`SELECT set_config('app.tenant_id', ${config.tenant_id}, true)`;

        const data = await prefetchReportData(conn, config.tenant_id, config.yesterday);
        const prompt = buildBatchPrompt(data, config.custom_prompt);
        const customId = `tenant_${config.tenant_id}`;

        batchRequests.push({
          custom_id: customId,
          params: {
            model: REPORT_MODEL,
            max_tokens: 4096,
            system: BATCH_REPORT_SYSTEM_PROMPT,
            messages: [{ role: 'user', content: prompt }],
          },
        });

        tenantMap[customId] = {
          tenant_id: config.tenant_id,
          yesterday: config.yesterday,
          startTime,
        };

        console.log(`[Scheduler] Pre-fetched data for tenant ${config.tenant_id}`);
      } catch (err) {
        console.error(`[Scheduler] Pre-fetch failed for tenant ${config.tenant_id}:`, err.message);
        await adminSql`
          INSERT INTO agent_runs (tenant_id, trigger_type, prompt_summary, model, duration_ms, status, error_message)
          VALUES (${config.tenant_id}, 'scheduled', 'Nightly report (batch)', ${REPORT_MODEL}, ${Date.now() - startTime}, 'error', ${`Pre-fetch failed: ${err.message}`})
        `;
      } finally {
        if (conn) await conn.release();
      }
    }

    if (batchRequests.length === 0) {
      console.log('[Scheduler] No batch requests to submit (all pre-fetches failed)');
      return;
    }

    // Submit batch
    const batch = await submitReportBatch(batchRequests);
    console.log(`[Scheduler] Batch submitted: ${batch.id} (${batchRequests.length} requests)`);

    // Poll until complete
    const completedBatch = await pollBatchCompletion(batch.id);
    console.log(`[Scheduler] Batch ${batch.id} completed: ${completedBatch.request_counts?.succeeded ?? 0} succeeded, ${completedBatch.request_counts?.errored ?? 0} errored`);

    // Process results
    const { successCount, errorCount } = await processBatchResults(batch.id, tenantMap);
    console.log(`[Scheduler] Batch results processed: ${successCount} reports stored, ${errorCount} errors`);
  } catch (err) {
    console.error('[Scheduler] Tick error:', err.message);
  }
}

// ==================== Demo Reset (daily 4am UTC) ====================

async function resetDemoTenant() {
  try {
    const configs = await adminSql`SELECT * FROM demo_config WHERE active = true`;
    if (configs.length === 0) return;

    // Dynamic import to avoid circular dependency
    const { resetDemoTenantData } = await import('../routes/sales-demo.js');

    for (const config of configs) {
      try {
        await resetDemoTenantData(config.tenant_id, config.data_volume);
        await adminSql`UPDATE demo_config SET last_reset_at = NOW() WHERE tenant_id = ${config.tenant_id}`;
        console.log(`[Scheduler] Demo tenant ${config.tenant_id} reset successfully`);
      } catch (err) {
        console.error(`[Scheduler] Demo reset failed for ${config.tenant_id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[Scheduler] Demo reset tick error:', err.message);
  }
}

// ==================== Commission Calculation (monthly, 1st at 2am UTC) ====================

const PLAN_PRICES = { pro: 350 }; // MXN per month

async function calculateMonthlyCommissions() {
  try {
    const now = new Date();
    const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    const activeCommissions = await adminSql`
      SELECT sc.*, t.plan
      FROM sales_commissions sc
      JOIN tenants t ON t.id = sc.tenant_id
      WHERE sc.active = true AND t.active = true AND t.plan = 'pro'
        AND (sc.end_date IS NULL OR sc.end_date >= CURRENT_DATE)
    `;

    let count = 0;
    for (const sc of activeCommissions) {
      const mrrAmount = PLAN_PRICES[sc.plan] || PLAN_PRICES.pro;
      const commissionAmount = (mrrAmount * Number(sc.commission_percent)) / 100;

      try {
        await adminSql`
          INSERT INTO commission_payouts (rep_id, commission_id, tenant_id, period, mrr_amount, commission_amount, status)
          VALUES (${sc.rep_id}, ${sc.id}, ${sc.tenant_id}, ${period}, ${mrrAmount}, ${commissionAmount}, 'earned')
          ON CONFLICT (commission_id, period) DO NOTHING
        `;
        count++;
      } catch (err) {
        console.error(`[Scheduler] Commission calc failed for sc.id=${sc.id}:`, err.message);
      }
    }

    if (count > 0) {
      console.log(`[Scheduler] Calculated ${count} commission payouts for period ${period}`);
    }
  } catch (err) {
    console.error('[Scheduler] Commission calc tick error:', err.message);
  }
}

// ==================== Platform Monitoring (every 6h) ====================

async function platformMonitoringTick() {
  try {
    const { runPlatformMonitoring } = await import('../routes/admin-agent.js');
    const alertCount = await runPlatformMonitoring();
    if (alertCount > 0) {
      console.log(`[Scheduler] Platform monitoring created ${alertCount} alert(s)`);
    }
  } catch (err) {
    console.error('[Scheduler] Platform monitoring tick error:', err.message);
  }
}

/**
 * Initialize the scheduler. Call once at server startup.
 * Runs every hour at minute 0.
 */
export function initAgentScheduler() {
  // Nightly reports (requires ANTHROPIC_API_KEY)
  if (process.env.ANTHROPIC_API_KEY) {
    cron.schedule('0 * * * *', schedulerTick, { timezone: 'UTC' });
    console.log('[Scheduler] Agent report scheduler initialized (runs hourly)');
  } else {
    console.log('[Scheduler] ANTHROPIC_API_KEY not set — agent reports disabled');
  }

  // Demo tenant reset — daily at 4am UTC
  cron.schedule('0 4 * * *', resetDemoTenant, { timezone: 'UTC' });

  // Monthly commission calculation — 1st of month at 2am UTC
  cron.schedule('0 2 1 * *', calculateMonthlyCommissions, { timezone: 'UTC' });

  // Platform monitoring — every 6 hours
  cron.schedule('0 */6 * * *', platformMonitoringTick, { timezone: 'UTC' });

  console.log('[Scheduler] Sales schedulers initialized (demo reset, commissions, monitoring)');
}

// Export for manual triggering (testing)
export { schedulerTick, generateReport, resetDemoTenant, calculateMonthlyCommissions };
