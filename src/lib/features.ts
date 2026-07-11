// Client feature flags, read from Vite env at build time.
//
// Vars must be VITE_-prefixed to reach the browser bundle. Menu photos default
// ON: the upload pipeline has a local-disk fallback, so it works without R2
// configured. Set VITE_FEATURE_MENU_PHOTOS=false to hide the in-app upload UI
// (a broken/unconfigured storage backend never blocks menu browsing regardless).

export const FEATURES = {
  menuPhotos:
    ((import.meta.env.VITE_FEATURE_MENU_PHOTOS as string | undefined) ?? 'true') !== 'false',
};
