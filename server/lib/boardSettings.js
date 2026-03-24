/** Valid board_settings keys (non-numeric settings fields) */
export const VALID_BOARD_KEYS = new Set([
  'showCombos', 'showLogo', 'showClock', 'showPrices', 'showQrCode',
  'qrCodeUrl', 'qrCodeLabel', 'slideDuration', 'footerText',
  'announcementText', 'showDescription', 'qrRequirePayment',
]);

/**
 * Normalize board_settings to a clean object, stripping corruption artifacts.
 * Handles: double-stringified strings, numeric character-index keys from
 * spreading a string in JS ({..."hello"} → {0:"h",1:"e",...}).
 */
export function cleanBoardSettings(value) {
  if (value === undefined || value === null) return {};
  // Unwrap string layers
  let data = value;
  while (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { return {}; }
  }
  if (typeof data !== 'object' || data === null) return {};
  // Strip numeric junk keys — only keep known settings keys
  const cleaned = {};
  for (const k of Object.keys(data)) {
    if (VALID_BOARD_KEYS.has(k)) cleaned[k] = data[k];
  }
  return cleaned;
}

/**
 * Convert board_settings to a clean JSON string for JSONB storage.
 */
export function toJsonbString(value) {
  return JSON.stringify(cleanBoardSettings(value));
}
