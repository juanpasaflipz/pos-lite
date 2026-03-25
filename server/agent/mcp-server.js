/**
 * POS Agent — MCP Server Factory
 *
 * Creates per-request MCP servers with tenant context captured in closures.
 * READ tools execute directly via existing handlers.
 * ACTION tools push to a shared pendingActions array (returned to caller).
 *
 * Two variants:
 *   createPosAgentServer(conn, tenantId) — full interactive (reads + actions)
 *   createReadOnlyPosServer(conn, tenantId) — reads only (for scheduled reports)
 */

import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { TOOL_HANDLERS } from './handlers.js';

// ==================== Zod Schemas ====================

const salesSummarySchema = {
  start_date: z.string().optional().describe('Start date (YYYY-MM-DD). Defaults to 7 days ago.'),
  end_date: z.string().optional().describe('End date (YYYY-MM-DD). Defaults to today.'),
};

const menuPerformanceSchema = {
  days: z.number().optional().describe('Number of days to analyze. Default 30.'),
  category_id: z.number().optional().describe('Optional: filter to a specific menu category.'),
};

const inventoryStatusSchema = {
  only_low_stock: z.boolean().optional().describe('If true, only return items at or below their low-stock threshold.'),
  category: z.string().optional().describe('Optional: filter by inventory category.'),
};

const salesByDayHourSchema = {
  weeks: z.number().optional().describe('Number of weeks of history to analyze. Default 4.'),
};

const deliveryPerformanceSchema = {
  days: z.number().optional().describe('Number of days to analyze. Default 30.'),
};

const wasteAnalysisSchema = {
  days: z.number().optional().describe('Number of days to analyze. Default 30.'),
};

const employeePerformanceSchema = {
  days: z.number().optional().describe('Number of days to analyze. Default 30.'),
};

const customerInsightsSchema = {
  days: z.number().optional().describe('Number of days to analyze. Default 90.'),
};

const expenseSummarySchema = {
  start_date: z.string().optional().describe('Start date (YYYY-MM-DD). Defaults to current month start.'),
  end_date: z.string().optional().describe('End date (YYYY-MM-DD). Defaults to today.'),
};

// Action tool schemas
const updateMenuItemPriceSchema = {
  item_id: z.number().describe('Menu item ID'),
  new_price: z.number().describe('New price in the tenant currency'),
  reason: z.string().describe('Brief explanation of why this price change is recommended'),
};

const toggleMenuItemSchema = {
  item_id: z.number().describe('Menu item ID'),
  active: z.boolean().describe('true to enable, false to disable (86 the item)'),
  reason: z.string().describe('Why this item should be toggled'),
};

const createPurchaseOrderSchema = {
  vendor_id: z.number().describe('Vendor ID to order from'),
  items: z.array(z.object({
    inventory_item_id: z.number(),
    quantity: z.number(),
    unit_cost: z.number().optional(),
  })).describe('Items to order'),
  notes: z.string().optional().describe('PO notes'),
};

const updateInventoryQuantitySchema = {
  item_id: z.number().describe('Inventory item ID'),
  new_quantity: z.number().describe('New quantity'),
  reason: z.string().describe('Reason for adjustment'),
};

const createPrepListSchema = {
  target_date: z.string().optional().describe('Date to prep for (YYYY-MM-DD). Defaults to tomorrow.'),
  safety_factor: z.number().optional().describe('Multiplier for safety stock (1.0 = exact forecast, 1.2 = 20% buffer). Default 1.15.'),
};

const sendLoyaltyCampaignSchema = {
  message: z.string().describe('SMS message text (max 160 chars)'),
  filter: z.enum(['all', 'inactive_30d', 'top_spenders', 'close_to_reward']).describe('Which customer segment to target'),
};

// ==================== Tool Descriptions (same as tools.js) ====================

const TOOL_DESCRIPTIONS = {
  get_sales_summary: 'Get sales summary for a date range: total revenue, order count, average ticket, top items, busiest hours.',
  get_menu_performance: 'Analyze menu item performance: sales volume, revenue, profit margins, BCG classification (stars, dogs, puzzles, cash cows).',
  get_inventory_status: 'Get current inventory levels, low-stock items, and estimated days until stockout based on usage velocity.',
  get_sales_by_day_and_hour: 'Get sales patterns by day of week and hour. Useful for forecasting prep needs and staffing.',
  get_delivery_performance: 'Analyze delivery platform performance: order volume, revenue, commissions, net profit per platform.',
  get_waste_analysis: 'Analyze waste patterns: top wasted items, waste by reason, cost of waste.',
  get_employee_performance: 'Get employee sales performance: orders processed, revenue, average ticket, tips.',
  get_customer_insights: 'Analyze loyalty customer data: top spenders, visit frequency, stamp redemption rates.',
  get_expense_summary: 'Get expense breakdown by category. Compare to revenue for profit margin analysis.',
  update_menu_item_price: 'Change the price of a menu item. Use when analysis shows a price adjustment is warranted.',
  toggle_menu_item: 'Enable or disable a menu item. Use to 86 items or re-enable when stock is replenished.',
  create_purchase_order: 'Create a purchase order for inventory restocking.',
  update_inventory_quantity: 'Adjust inventory quantity for corrections, receiving, or manual adjustments.',
  create_prep_list: 'Generate a prep list recommendation based on sales forecasts.',
  send_loyalty_campaign: 'Send an SMS campaign to loyalty customers.',
};

// ==================== Helper: wrap a handler into an MCP tool result ====================

function makeReadTool(name, description, schema, conn, tenantId) {
  return tool(name, description, schema, async (args) => {
    const result = await TOOL_HANDLERS[name]({ input: args, conn, tenantId });
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  });
}

function makeActionTool(name, description, schema, pendingActions) {
  return tool(name, description, schema, async (args) => {
    const pendingAction = {
      tool_use_id: `pending_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      tool_name: name,
      input: args,
      description: describeAction(name, args),
    };
    pendingActions.push(pendingAction);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          status: 'pending_approval',
          tool_name: name,
          input: args,
          description: pendingAction.description,
          message: 'This action requires owner approval. It will be executed when approved.',
        }),
      }],
    };
  });
}

// ==================== Action Descriptions ====================

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

// ==================== Factory: Full Interactive Server ====================

/**
 * Creates an MCP server with all READ + ACTION tools.
 * ACTION tools push to pendingActions instead of executing.
 *
 * @param {object} conn - Tenant-scoped Postgres connection
 * @param {string} tenantId
 * @returns {{ server: object, pendingActions: Array }}
 */
export function createPosAgentServer(conn, tenantId) {
  const pendingActions = [];

  const readTools = [
    makeReadTool('get_sales_summary', TOOL_DESCRIPTIONS.get_sales_summary, salesSummarySchema, conn, tenantId),
    makeReadTool('get_menu_performance', TOOL_DESCRIPTIONS.get_menu_performance, menuPerformanceSchema, conn, tenantId),
    makeReadTool('get_inventory_status', TOOL_DESCRIPTIONS.get_inventory_status, inventoryStatusSchema, conn, tenantId),
    makeReadTool('get_sales_by_day_and_hour', TOOL_DESCRIPTIONS.get_sales_by_day_and_hour, salesByDayHourSchema, conn, tenantId),
    makeReadTool('get_delivery_performance', TOOL_DESCRIPTIONS.get_delivery_performance, deliveryPerformanceSchema, conn, tenantId),
    makeReadTool('get_waste_analysis', TOOL_DESCRIPTIONS.get_waste_analysis, wasteAnalysisSchema, conn, tenantId),
    makeReadTool('get_employee_performance', TOOL_DESCRIPTIONS.get_employee_performance, employeePerformanceSchema, conn, tenantId),
    makeReadTool('get_customer_insights', TOOL_DESCRIPTIONS.get_customer_insights, customerInsightsSchema, conn, tenantId),
    makeReadTool('get_expense_summary', TOOL_DESCRIPTIONS.get_expense_summary, expenseSummarySchema, conn, tenantId),
  ];

  const actionTools = [
    makeActionTool('update_menu_item_price', TOOL_DESCRIPTIONS.update_menu_item_price, updateMenuItemPriceSchema, pendingActions),
    makeActionTool('toggle_menu_item', TOOL_DESCRIPTIONS.toggle_menu_item, toggleMenuItemSchema, pendingActions),
    makeActionTool('create_purchase_order', TOOL_DESCRIPTIONS.create_purchase_order, createPurchaseOrderSchema, pendingActions),
    makeActionTool('update_inventory_quantity', TOOL_DESCRIPTIONS.update_inventory_quantity, updateInventoryQuantitySchema, pendingActions),
    makeActionTool('create_prep_list', TOOL_DESCRIPTIONS.create_prep_list, createPrepListSchema, pendingActions),
    makeActionTool('send_loyalty_campaign', TOOL_DESCRIPTIONS.send_loyalty_campaign, sendLoyaltyCampaignSchema, pendingActions),
  ];

  const server = createSdkMcpServer({
    name: 'pos',
    tools: [...readTools, ...actionTools],
  });

  return { server, pendingActions };
}

// ==================== Factory: Read-Only Server (for scheduled reports) ====================

/**
 * Creates an MCP server with only READ tools.
 * Used by the nightly report scheduler — no actions possible.
 *
 * @param {object} conn - Tenant-scoped Postgres connection
 * @param {string} tenantId
 * @returns {{ server: object }}
 */
export function createReadOnlyPosServer(conn, tenantId) {
  const tools = [
    makeReadTool('get_sales_summary', TOOL_DESCRIPTIONS.get_sales_summary, salesSummarySchema, conn, tenantId),
    makeReadTool('get_menu_performance', TOOL_DESCRIPTIONS.get_menu_performance, menuPerformanceSchema, conn, tenantId),
    makeReadTool('get_inventory_status', TOOL_DESCRIPTIONS.get_inventory_status, inventoryStatusSchema, conn, tenantId),
    makeReadTool('get_sales_by_day_and_hour', TOOL_DESCRIPTIONS.get_sales_by_day_and_hour, salesByDayHourSchema, conn, tenantId),
    makeReadTool('get_delivery_performance', TOOL_DESCRIPTIONS.get_delivery_performance, deliveryPerformanceSchema, conn, tenantId),
    makeReadTool('get_waste_analysis', TOOL_DESCRIPTIONS.get_waste_analysis, wasteAnalysisSchema, conn, tenantId),
    makeReadTool('get_employee_performance', TOOL_DESCRIPTIONS.get_employee_performance, employeePerformanceSchema, conn, tenantId),
    makeReadTool('get_customer_insights', TOOL_DESCRIPTIONS.get_customer_insights, customerInsightsSchema, conn, tenantId),
    makeReadTool('get_expense_summary', TOOL_DESCRIPTIONS.get_expense_summary, expenseSummarySchema, conn, tenantId),
  ];

  const server = createSdkMcpServer({
    name: 'pos',
    tools,
  });

  return { server };
}
