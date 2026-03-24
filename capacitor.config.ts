import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'kitchen.desktop.app',
  appName: 'Desktop Kitchen POS',
  webDir: 'dist',
  // No server.url — app loads from local dist/ for offline support.
  // API calls go to pos.desktop.kitchen via src/api/index.ts base URL detection.
  ios: {
    contentInset: 'always',
    allowsLinkPreview: false,
    scrollEnabled: false,
    preferredContentMode: 'mobile',
  },
  android: {
    overScrollMode: 'never',
    backgroundColor: '#ffffff',
  },
};

export default config;
