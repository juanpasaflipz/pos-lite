/**
 * POS Agent — Tool Definitions for Claude
 *
 * Two categories:
 *   READ tools  → gather data, no side effects, no confirmation needed
 *   ACTION tools → mutate state, require owner approval before execution
 *
 * Each tool maps to a handler that runs SQL against the tenant-scoped connection.
 */

// ==================== TOOL DEFINITIONS (sent to Claude) ====================

export const AGENT_TOOLS = [
  // ────────────────── READ TOOLS ──────────────────

  {
    name: 'get_sales_summary',
    description: 'Get sales summary for a date range: total revenue, order count, average ticket, top items, busiest hours. Use this to understand overall business performance.',
    input_schema: {
      type: 'object',
      properties: {
        start_date: { type: 'string', description: 'Start date (YYYY-MM-DD). Defaults to 7 days ago.' },
        end_date: { type: 'string', description: 'End date (YYYY-MM-DD). Defaults to today.' },
      },
      required: [],
    },
    category: 'read',
  },

  {
    name: 'get_menu_performance',
    description: 'Analyze menu item performance: sales volume, revenue, profit margins (if cost data exists), trend vs previous period. Identifies stars, dogs, puzzles, and cash cows.',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Number of days to analyze. Default 30.' },
        category_id: { type: 'number', description: 'Optional: filter to a specific menu category.' },
      },
      required: [],
    },
    category: 'read',
  },

  {
    name: 'get_inventory_status',
    description: 'Get current inventory levels, items below low-stock threshold, items with no recent movement, and estimated days until stockout based on recent usage velocity.',
    input_schema: {
      type: 'object',
      properties: {
        only_low_stock: { type: 'boolean', description: 'If true, only return items at or below their low-stock threshold.' },
        category: { type: 'string', description: 'Optional: filter by inventory category.' },
      },
      required: [],
    },
    category: 'read',
  },

  {
    name: 'get_sales_by_day_and_hour',
    description: 'Get sales patterns broken down by day of week and hour. Useful for forecasting prep needs, staffing, and identifying peak/slow periods.',
    input_schema: {
      type: 'object',
      properties: {
        weeks: { type: 'number', description: 'Number of weeks of history to analyze. Default 4.' },
      },
      required: [],
    },
    category: 'read',
  },

  {
    name: 'get_delivery_performance',
    description: 'Analyze delivery platform performance: order volume, revenue, commissions paid, net profit per platform, average delivery times.',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Number of days to analyze. Default 30.' },
      },
      required: [],
    },
    category: 'read',
  },

  {
    name: 'get_waste_analysis',
    description: 'Analyze waste patterns: top wasted items, waste by reason (spoilage, prep error, expired), cost of waste, trends over time.',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Number of days to analyze. Default 30.' },
      },
      required: [],
    },
    category: 'read',
  },

  {
    name: 'get_employee_performance',
    description: 'Get employee sales performance: orders processed, revenue generated, average ticket size, speed. Useful for scheduling and recognition.',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Number of days to analyze. Default 30.' },
      },
      required: [],
    },
    category: 'read',
  },

  {
    name: 'get_customer_insights',
    description: 'Analyze loyalty customer data: top spenders, visit frequency, referral effectiveness, stamp redemption rates.',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Number of days to analyze. Default 90.' },
      },
      required: [],
    },
    category: 'read',
  },

  {
    name: 'get_expense_summary',
    description: 'Get expense breakdown by category for a period. Compare to revenue for profit margin analysis.',
    input_schema: {
      type: 'object',
      properties: {
        start_date: { type: 'string', description: 'Start date (YYYY-MM-DD). Defaults to current month start.' },
        end_date: { type: 'string', description: 'End date (YYYY-MM-DD). Defaults to today.' },
      },
      required: [],
    },
    category: 'read',
  },

  // ────────────────── ACTION TOOLS (require confirmation) ──────────────────

  {
    name: 'update_menu_item_price',
    description: 'Change the price of a menu item. Use when analysis shows a price adjustment is warranted (margin too low, demand-based pricing, competitive adjustment).',
    input_schema: {
      type: 'object',
      properties: {
        item_id: { type: 'number', description: 'Menu item ID' },
        new_price: { type: 'number', description: 'New price in the tenant currency' },
        reason: { type: 'string', description: 'Brief explanation of why this price change is recommended' },
      },
      required: ['item_id', 'new_price', 'reason'],
    },
    category: 'action',
  },

  {
    name: 'toggle_menu_item',
    description: 'Enable or disable a menu item. Use to 86 items that are out of stock, or re-enable items when stock is replenished.',
    input_schema: {
      type: 'object',
      properties: {
        item_id: { type: 'number', description: 'Menu item ID' },
        active: { type: 'boolean', description: 'true to enable, false to disable (86 the item)' },
        reason: { type: 'string', description: 'Why this item should be toggled' },
      },
      required: ['item_id', 'active', 'reason'],
    },
    category: 'action',
  },

  {
    name: 'create_purchase_order',
    description: 'Create a purchase order for inventory restocking. Use when inventory analysis shows items need reordering.',
    input_schema: {
      type: 'object',
      properties: {
        vendor_id: { type: 'number', description: 'Vendor ID to order from' },
        items: {
          type: 'array',
          description: 'Items to order',
          items: {
            type: 'object',
            properties: {
              inventory_item_id: { type: 'number' },
              quantity: { type: 'number' },
              unit_cost: { type: 'number' },
            },
            required: ['inventory_item_id', 'quantity'],
          },
        },
        notes: { type: 'string', description: 'PO notes' },
      },
      required: ['vendor_id', 'items'],
    },
    category: 'action',
  },

  {
    name: 'update_inventory_quantity',
    description: 'Adjust inventory quantity. Use for corrections, receiving deliveries, or manual adjustments.',
    input_schema: {
      type: 'object',
      properties: {
        item_id: { type: 'number', description: 'Inventory item ID' },
        new_quantity: { type: 'number', description: 'New quantity' },
        reason: { type: 'string', description: 'Reason for adjustment' },
      },
      required: ['item_id', 'new_quantity', 'reason'],
    },
    category: 'action',
  },

  {
    name: 'create_prep_list',
    description: 'Generate a prep list recommendation. Returns a structured list of items and quantities to prep, based on sales forecasts. This is displayed to the kitchen team.',
    input_schema: {
      type: 'object',
      properties: {
        target_date: { type: 'string', description: 'Date to prep for (YYYY-MM-DD). Defaults to tomorrow.' },
        safety_factor: { type: 'number', description: 'Multiplier for safety stock (1.0 = exact forecast, 1.2 = 20% buffer). Default 1.15.' },
      },
      required: [],
    },
    category: 'action',
  },

  {
    name: 'send_loyalty_campaign',
    description: 'Send an SMS campaign to loyalty customers. Use for promotions, re-engagement, or announcements.',
    input_schema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'SMS message text (max 160 chars)' },
        filter: {
          type: 'string',
          enum: ['all', 'inactive_30d', 'top_spenders', 'close_to_reward'],
          description: 'Which customer segment to target',
        },
      },
      required: ['message', 'filter'],
    },
    category: 'action',
  },
];

// Build the tools array in Claude API format (without category)
export const CLAUDE_TOOLS = AGENT_TOOLS.map(({ category, ...tool }) => tool);

// Quick lookup: is this tool an action (needs confirmation)?
export const ACTION_TOOLS = new Set(
  AGENT_TOOLS.filter(t => t.category === 'action').map(t => t.name)
);
