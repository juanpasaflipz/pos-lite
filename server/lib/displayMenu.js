const DEFAULT_DISPLAY_MENU_SETTINGS = {
  version: 1,
  tv: {
    enabled: false,
    layout: 'local_shop_split',
    menuCategoryIds: [],
    showPrices: true,
    showLogo: true,
    showTagline: true,
    footerText: '',
    rotationSeconds: 30,
    atmosphereMode: 'image_and_callout',
    activeAssetIds: [],
    seasonalCallout: {
      title: '',
      body: '',
      startsAt: null,
      endsAt: null,
    },
  },
  customerDisplay: {
    enabled: false,
    suggestiveSellingEnabled: true,
  },
  web: {
    enabled: false,
    allowOrdering: true,
  },
};

function asObject(value) {
  if (value === undefined || value === null) return {};

  let current = value;
  while (typeof current === 'string') {
    try {
      current = JSON.parse(current);
    } catch {
      return {};
    }
  }

  return typeof current === 'object' && current !== null ? current : {};
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function sanitizeIdList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .map((item) => Number(item))
      .filter((item) => Number.isInteger(item) && item > 0)
  )];
}

function sanitizeCallout(value) {
  const input = asObject(value);
  return {
    title: typeof input.title === 'string' ? input.title.trim() : '',
    body: typeof input.body === 'string' ? input.body.trim() : '',
    startsAt: typeof input.startsAt === 'string' && input.startsAt.trim() ? input.startsAt : null,
    endsAt: typeof input.endsAt === 'string' && input.endsAt.trim() ? input.endsAt : null,
  };
}

export function normalizeDisplayMenuSettings(value) {
  const input = asObject(value);
  const tvInput = asObject(input.tv);
  const customerInput = asObject(input.customerDisplay);
  const webInput = asObject(input.web);

  return {
    version: 1,
    tv: {
      enabled: tvInput.enabled !== undefined ? !!tvInput.enabled : DEFAULT_DISPLAY_MENU_SETTINGS.tv.enabled,
      layout: tvInput.layout === 'local_shop_split' ? tvInput.layout : DEFAULT_DISPLAY_MENU_SETTINGS.tv.layout,
      menuCategoryIds: sanitizeIdList(tvInput.menuCategoryIds),
      showPrices: tvInput.showPrices !== undefined ? !!tvInput.showPrices : DEFAULT_DISPLAY_MENU_SETTINGS.tv.showPrices,
      showLogo: tvInput.showLogo !== undefined ? !!tvInput.showLogo : DEFAULT_DISPLAY_MENU_SETTINGS.tv.showLogo,
      showTagline: tvInput.showTagline !== undefined ? !!tvInput.showTagline : DEFAULT_DISPLAY_MENU_SETTINGS.tv.showTagline,
      footerText: typeof tvInput.footerText === 'string' ? tvInput.footerText.trim() : DEFAULT_DISPLAY_MENU_SETTINGS.tv.footerText,
      rotationSeconds: clamp(tvInput.rotationSeconds, 10, 120, DEFAULT_DISPLAY_MENU_SETTINGS.tv.rotationSeconds),
      atmosphereMode: tvInput.atmosphereMode === 'image_and_callout'
        ? tvInput.atmosphereMode
        : DEFAULT_DISPLAY_MENU_SETTINGS.tv.atmosphereMode,
      activeAssetIds: Array.isArray(tvInput.activeAssetIds)
        ? [...new Set(tvInput.activeAssetIds.map((item) => String(item)).filter(Boolean))]
        : DEFAULT_DISPLAY_MENU_SETTINGS.tv.activeAssetIds,
      seasonalCallout: sanitizeCallout(tvInput.seasonalCallout),
    },
    customerDisplay: {
      enabled: customerInput.enabled !== undefined ? !!customerInput.enabled : DEFAULT_DISPLAY_MENU_SETTINGS.customerDisplay.enabled,
      suggestiveSellingEnabled: customerInput.suggestiveSellingEnabled !== undefined
        ? !!customerInput.suggestiveSellingEnabled
        : DEFAULT_DISPLAY_MENU_SETTINGS.customerDisplay.suggestiveSellingEnabled,
    },
    web: {
      enabled: webInput.enabled !== undefined ? !!webInput.enabled : DEFAULT_DISPLAY_MENU_SETTINGS.web.enabled,
      allowOrdering: webInput.allowOrdering !== undefined ? !!webInput.allowOrdering : DEFAULT_DISPLAY_MENU_SETTINGS.web.allowOrdering,
    },
  };
}

export function getDisplayMenuSettings(branding) {
  const brandingData = asObject(branding);
  return normalizeDisplayMenuSettings(brandingData.displayMenu);
}

export function setDisplayMenuSettings(branding, displayMenu) {
  const brandingData = asObject(branding);
  const currentSettings = getDisplayMenuSettings(brandingData);
  const incoming = asObject(displayMenu);
  const incomingTv = asObject(incoming.tv);
  return {
    ...brandingData,
    displayMenu: normalizeDisplayMenuSettings({
      ...currentSettings,
      ...incoming,
      tv: {
        ...currentSettings.tv,
        ...incomingTv,
        seasonalCallout: {
          ...currentSettings.tv.seasonalCallout,
          ...asObject(incomingTv.seasonalCallout),
        },
      },
      customerDisplay: {
        ...currentSettings.customerDisplay,
        ...asObject(incoming.customerDisplay),
      },
      web: {
        ...currentSettings.web,
        ...asObject(incoming.web),
      },
    }),
  };
}

export function isCalloutActive(callout, now = new Date()) {
  if (!callout?.title && !callout?.body) return false;

  const startsAt = callout.startsAt ? new Date(callout.startsAt) : null;
  const endsAt = callout.endsAt ? new Date(callout.endsAt) : null;

  if (startsAt && Number.isFinite(startsAt.getTime()) && startsAt > now) return false;
  if (endsAt && Number.isFinite(endsAt.getTime()) && endsAt < now) return false;

  return true;
}
