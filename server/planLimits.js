/**
 * POS Lite — Two-tier plan system (Pro paid, Free forever)
 *
 * Free = "la caja": full counter POS forever — unlimited products/modifiers/
 * combos/inventory, up to 3 employee PINs, one paired KDS device (kitchen
 * station), QR menu VIEW, loyalty stamps, last-7-days reports.
 * Pro = "lo que te hace vender más": self-service kiosk, QR table ORDERING,
 * unlimited employees + extra KDS stations (bar/expo), full report history +
 * cost variables + break-even, CFDI, AI, SMS loyalty, data export, banking.
 *
 * Repackaged 2026-07-23 (Juan): the original freemium split gave the growth
 * features away — kiosk/KDS/unlimited staff were free and Pro was mostly
 * compliance. Kiosk is now the flagship upgrade incentive; trial expiry
 * ("your kiosk turns off") is the conversion moment. Orders are NEVER
 * capped — a POS that stops selling mid-service is not a lever, it's churn.
 *
 * Freemium trial (2026-07): new self-serve signups keep plan='free' in the
 * DB but get full Pro for 14 days via tenants.trial_ends_at. Always resolve
 * access through effectivePlan(tenantRow) — never read tenant.plan directly
 * for gating. Expiry is implicit (the clock passes trial_ends_at), so there
 * is no downgrade job to run or fail.
 */

export const PLAN_LIMITS = {
  free: {
    menuItems: Infinity,
    inventoryItems: Infinity,
    employees: 3,
    modifierGroups: Infinity,
    combos: Infinity,
    reports: { editVariables: false },
    reportsHistoryDays: 7,
    printers: { functional: true, max: Infinity },
    ai: { mode: 'none', dailySuggestions: 0, monthlyAnalyses: 0 },
    kiosk: { functional: false },
    qrOrdering: { functional: false },
    kdsDevices: { max: 1, stations: ['kds'] },
    delivery: { functional: false },
    permissions: { locked: false },
    loyalty: { locked: false, smsEnabled: false },
    branding: { canRename: true, watermark: true },
    banking: { locked: true },
    bankReconciliation: { locked: true },
    dataExport: { locked: true },
    cfdi: { locked: true },
    inventoryTwoStage: { locked: true },
  },
  pro: {
    menuItems: Infinity,
    inventoryItems: Infinity,
    employees: Infinity,
    modifierGroups: Infinity,
    combos: Infinity,
    reports: { editVariables: true },
    reportsHistoryDays: Infinity,
    printers: { functional: true, max: Infinity },
    ai: { mode: 'full', dailySuggestions: Infinity, monthlyAnalyses: Infinity },
    kiosk: { functional: true },
    qrOrdering: { functional: true },
    kdsDevices: { max: Infinity, stations: ['kds', 'bar', 'expo'] },
    delivery: { functional: true },
    permissions: { locked: false },
    loyalty: { locked: false, smsEnabled: true },
    branding: { canRename: true, watermark: false },
    banking: { locked: false },
    bankReconciliation: { locked: false },
    dataExport: { locked: false },
    cfdi: { locked: false },
    inventoryTwoStage: { locked: false },
  },
};

export const PLAN_TIERS = ['free', 'pro'];

export function getPlanLimits(plan) {
  return PLAN_LIMITS[plan] || PLAN_LIMITS.free;
}

/** True while a signup's full-Pro trial window is still open. */
export function isTrialActive(tenant) {
  if (!tenant?.trial_ends_at) return false;
  const ends = new Date(tenant.trial_ends_at).getTime();
  return Number.isFinite(ends) && ends > Date.now();
}

/**
 * The plan a tenant should be treated as RIGHT NOW.
 * Paid 'pro' always wins; otherwise an active trial grants 'pro';
 * everything else (including unknown values) is 'free'.
 */
export function effectivePlan(tenant) {
  if (!tenant) return 'free';
  if (tenant.plan === 'pro') return 'pro';
  return isTrialActive(tenant) ? 'pro' : 'free';
}

export function getRequiredPlan(feature, subKey) {
  for (const tier of PLAN_TIERS) {
    const limits = PLAN_LIMITS[tier];
    const val = limits[feature];
    if (val === undefined) continue;

    if (subKey) {
      const sub = val?.[subKey];
      if (sub === true || (typeof sub === 'number' && sub > 0)) return tier;
      continue;
    }

    if (typeof val === 'number') { if (val > 0) return tier; continue; }

    if (typeof val === 'object') {
      if (val.locked === false || val.functional === true) return tier;
      if (!('locked' in val) && !('functional' in val)) {
        const hasUnlocked = Object.values(val).some(v =>
          v === true || (typeof v === 'number' && v > 0) || (typeof v === 'string' && !['mock', 'locked', 'lite'].includes(v))
        );
        if (hasUnlocked) return tier;
      }
      continue;
    }

    if (val === true) return tier;
  }
  return 'pro';
}

export function planUpgradeError(feature, currentPlan, extra) {
  return {
    error: 'PLAN_UPGRADE_REQUIRED',
    requiredPlan: getRequiredPlan(feature),
    feature,
    currentPlan,
    ...extra,
  };
}

export function checkLimit(plan, resource, currentCount) {
  const max = getPlanLimits(plan)[resource];
  if (typeof max !== 'number') return { allowed: true };
  return currentCount >= max
    ? { allowed: false, limit: max, current: currentCount, plan }
    : { allowed: true, limit: max, current: currentCount };
}

export function requirePlanFeature(feature) {
  return (req, res, next) => {
    const plan = req.tenant?.plan || 'free';
    const limits = getPlanLimits(plan);
    const featureLimits = limits[feature];
    if (featureLimits && (featureLimits.locked === true || featureLimits.functional === false)) {
      return res.status(403).json(planUpgradeError(feature, plan));
    }
    next();
  };
}
