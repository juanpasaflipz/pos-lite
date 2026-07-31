/**
 * Central AI model routing — the one place model names live.
 *
 * Two tiers, chosen per task (2026-07 pricing, USD per 1M tokens):
 *   fast  = claude-haiku-4-5   ($1 in / $5 out)  — 3× cheaper than Sonnet,
 *           multimodal, plenty for structured/extraction tasks. This is the
 *           tier tenant-facing volume runs on so per-order AI cost stays
 *           negligible as the fleet grows.
 *   smart = claude-sonnet-4-6  ($3 in / $15 out) — reserved for low-volume,
 *           high-stakes work: sentinel triage (diagnoses money-adjacent
 *           incidents; a misdiagnosis costs more than the tokens saved) and
 *           the owner agent chat (open-ended reasoning over live data).
 *
 * Every model choice is env-overridable WITHOUT a deploy-time code change:
 *   AI_MODEL_FAST / AI_MODEL_SMART           — swap a whole tier
 *   AI_MODEL_<TASK> (e.g. AI_MODEL_KIOSK_SUGGESTIONS) — pin one task
 *
 * Open-weight models (DeepSeek/Qwen/Llama via a hosted provider) were
 * evaluated 2026-07-22: 3–10× cheaper than Haiku on paper, but they speak
 * the OpenAI wire format (every call site here posts Anthropic
 * /v1/messages), the cheap hosted ones lack vision (receipt scanning), and
 * at current fleet size the absolute savings are a few dollars a month.
 * Revisit when kiosk-suggestion volume makes the fast tier a real line
 * item — the swap then is: add an OpenAI-format adapter for that one call
 * site and set AI_MODEL_KIOSK_SUGGESTIONS.
 */

export const AI_TIERS = {
  fast: process.env.AI_MODEL_FAST || 'claude-haiku-4-5',
  smart: process.env.AI_MODEL_SMART || 'claude-sonnet-4-6',
};

const TASK_TIER = {
  kiosk_suggestions: 'fast', // per-order upsell — the highest-volume call site
  menu_parse: 'fast',        // onboarding wizard: free-text menu → items
  menu_translate: 'fast',    // ES→EN write-through cache on menu writes
  recipe_parse: 'fast',      // free-text recipe → ingredient links
  receipt_vision: 'fast',    // expense receipt photo → structured expense (needs vision)
  voice_intent: 'fast',      // WhatsApp voice ops → intent classification
  inventory_attrs: 'fast',   // shelf-life/category inference from an item name
  // Cold start for an unseen delivery-export layout: reads column NAMES and a
  // few sample cells, returns which column is which. Once any tenant confirms
  // a layout it goes in the shared registry (migration 0102) and this never
  // fires for that format again — so volume is per-format, not per-upload.
  sales_import_mapping: 'fast',
  sentinel_triage: 'smart',  // incident diagnosis — money-adjacent, low volume
  agent_chat: 'smart',       // owner-facing agent — open-ended, low volume
};

/**
 * Resolve the model for a task. Unknown tasks get the smart tier —
 * failing expensive is safer than failing dumb.
 */
export function modelFor(task) {
  const override = process.env[`AI_MODEL_${String(task).toUpperCase()}`];
  if (override) return override;
  return AI_TIERS[TASK_TIER[task]] || AI_TIERS.smart;
}
