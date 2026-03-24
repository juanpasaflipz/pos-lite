import { adminSql } from '../../db/index.js';

// Platform fee rates by plan tier
const PLATFORM_FEE_RATES = {
  free: 0.01,    // 1.0%
  pro: 0.005,    // 0.5%
};

// Estimated processor fee rates for savings calculation
const PROCESSOR_RATES = {
  getnet: 0.018,   // ~1.8%
  stripe: 0.036,   // ~3.6%
  conekta: 0.034,  // ~3.4%
};

/**
 * Get the platform fee rate for a plan tier.
 */
export function getPlatformFeeRate(plan) {
  return PLATFORM_FEE_RATES[plan] || PLATFORM_FEE_RATES.free;
}

/**
 * Calculate platform fee for a transaction.
 */
export function calculatePlatformFee(amount, plan, processor = 'getnet') {
  const feeRate = getPlatformFeeRate(plan);
  const processorRate = PROCESSOR_RATES[processor] || 0;
  const platformFeeAmount = Math.round(amount * feeRate * 100) / 100;
  const processorFeeAmount = Math.round(amount * processorRate * 100) / 100;
  const netToMerchant = Math.round((amount - platformFeeAmount - processorFeeAmount) * 100) / 100;

  return {
    grossAmount: amount,
    processorFee: processorFeeAmount,
    processorFeeRate: processorRate,
    platformFeeRate: feeRate,
    platformFeeAmount,
    netToMerchant,
  };
}

/**
 * Record a platform fee entry in the ledger.
 */
export async function recordPlatformFee(tenantId, orderId, processor, amount, plan) {
  const fee = calculatePlatformFee(amount, plan, processor);

  await adminSql`
    INSERT INTO platform_fee_ledger (
      tenant_id, order_id, processor,
      gross_amount, processor_fee,
      platform_fee_rate, platform_fee_amount,
      net_to_merchant, plan_at_time
    ) VALUES (
      ${tenantId}, ${orderId}, ${processor},
      ${fee.grossAmount}, ${fee.processorFee},
      ${fee.platformFeeRate}, ${fee.platformFeeAmount},
      ${fee.netToMerchant}, ${plan}
    )
  `;

  // Upsert daily summary
  const today = new Date().toISOString().slice(0, 10);
  await adminSql`
    INSERT INTO platform_fee_daily_summary (
      tenant_id, summary_date, processor,
      transaction_count, gross_total, processor_fees,
      platform_fees, net_to_merchant
    ) VALUES (
      ${tenantId}, ${today}, ${processor},
      1, ${fee.grossAmount}, ${fee.processorFee},
      ${fee.platformFeeAmount}, ${fee.netToMerchant}
    )
    ON CONFLICT (tenant_id, summary_date, processor)
    DO UPDATE SET
      transaction_count = platform_fee_daily_summary.transaction_count + 1,
      gross_total = platform_fee_daily_summary.gross_total + EXCLUDED.gross_total,
      processor_fees = platform_fee_daily_summary.processor_fees + EXCLUDED.processor_fees,
      platform_fees = platform_fee_daily_summary.platform_fees + EXCLUDED.platform_fees,
      net_to_merchant = platform_fee_daily_summary.net_to_merchant + EXCLUDED.net_to_merchant
  `;

  return fee;
}

/**
 * Calculate upgrade savings for a tenant (how much they'd save on Pro).
 */
export async function calculateUpgradeSavings(tenantId, days = 30) {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const rows = await adminSql`
    SELECT
      COALESCE(SUM(gross_amount), 0) as total_volume,
      COALESCE(SUM(platform_fee_amount), 0) as total_fees,
      COALESCE(SUM(transaction_count), 0) as total_transactions
    FROM platform_fee_daily_summary
    WHERE tenant_id = ${tenantId}
      AND summary_date >= ${since.toISOString().slice(0, 10)}
  `;

  const { total_volume, total_fees, total_transactions } = rows[0];
  const volume = Number(total_volume);

  // Calculate what they'd pay on Pro
  const proFeeRate = PLATFORM_FEE_RATES.pro;
  const proFees = Math.round(volume * proFeeRate * 100) / 100;
  const savings = Math.round((Number(total_fees) - proFees) * 100) / 100;

  return {
    periodDays: days,
    totalVolume: volume,
    totalTransactions: Number(total_transactions),
    currentFees: Number(total_fees),
    proFees,
    monthlySavings: savings > 0 ? savings : 0,
  };
}

/**
 * Get fee summary for admin dashboard.
 */
export async function getFeeSummary(tenantId, startDate, endDate) {
  const rows = await adminSql`
    SELECT
      processor,
      COALESCE(SUM(transaction_count), 0) as transactions,
      COALESCE(SUM(gross_total), 0) as gross,
      COALESCE(SUM(processor_fees), 0) as processor_fees,
      COALESCE(SUM(platform_fees), 0) as platform_fees,
      COALESCE(SUM(net_to_merchant), 0) as net
    FROM platform_fee_daily_summary
    WHERE tenant_id = ${tenantId}
      AND summary_date >= ${startDate}
      AND summary_date <= ${endDate}
    GROUP BY processor
    ORDER BY gross DESC
  `;

  return rows.map(r => ({
    processor: r.processor,
    transactions: Number(r.transactions),
    gross: Number(r.gross),
    processorFees: Number(r.processor_fees),
    platformFees: Number(r.platform_fees),
    net: Number(r.net),
  }));
}

/**
 * Get platform-wide fee totals for super admin.
 */
export async function getPlatformFeeTotals(startDate, endDate) {
  const rows = await adminSql`
    SELECT
      COALESCE(SUM(transaction_count), 0) as transactions,
      COALESCE(SUM(platform_fees), 0) as platform_revenue,
      COALESCE(SUM(gross_total), 0) as gross_volume,
      COUNT(DISTINCT tenant_id) as active_tenants
    FROM platform_fee_daily_summary
    WHERE summary_date >= ${startDate}
      AND summary_date <= ${endDate}
  `;

  const r = rows[0];
  return {
    transactions: Number(r.transactions),
    platformRevenue: Number(r.platform_revenue),
    grossVolume: Number(r.gross_volume),
    activeTenants: Number(r.active_tenants),
  };
}
