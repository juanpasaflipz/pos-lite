/**
 * POS Lite — Two-tier plan system ($350 MXN/mo Pro, Free forever)
 * Free: fully functional POS, no artificial caps
 * Pro: AI, delivery, CFDI, SMS loyalty, data export, banking
 */

export const PLAN_LIMITS = {
  free: {
    menuItems: Infinity,
    inventoryItems: Infinity,
    employees: Infinity,
    modifierGroups: Infinity,
    combos: Infinity,
    reports: { editVariables: false },
    printers: { functional: true, max: Infinity },
    ai: { mode: 'none', dailySuggestions: 0, monthlyAnalyses: 0 },
    delivery: { functional: false },
    permissions: { locked: false },
    loyalty: { locked: false, smsEnabled: false },
    branding: { canRename: true, watermark: true },
    banking: { locked: true },
    bankReconciliation: { locked: true },
    dataExport: { locked: true },
    cfdi: { locked: true },
  },
  pro: {
    menuItems: Infinity,
    inventoryItems: Infinity,
    employees: Infinity,
    modifierGroups: Infinity,
    combos: Infinity,
    reports: { editVariables: true },
    printers: { functional: true, max: Infinity },
    ai: { mode: 'full', dailySuggestions: Infinity, monthlyAnalyses: Infinity },
    delivery: { functional: true },
    permissions: { locked: false },
    loyalty: { locked: false, smsEnabled: true },
    branding: { canRename: true, watermark: false },
    banking: { locked: false },
    bankReconciliation: { locked: false },
    dataExport: { locked: false },
    cfdi: { locked: false },
  },
};

export const PLAN_TIERS = ['free', 'pro'];

export function getPlanLimits(plan) {
  return PLAN_LIMITS[plan] || PLAN_LIMITS.free;
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
