import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'kitchen.desktop.poslite',
  appName: 'POS Lite',
  webDir: 'dist',
  // No server.url — app loads from local dist/ for offline support.
  // API calls go to pos.desktop.kitchen via src/api/index.ts base URL detection.
  plugins: {
    SplashScreen: {
      launchAutoHide: true,
      autoHideDelay: 300,
    },
    StatusBar: {},
    Keyboard: {
      resize: 'body',
    },
  },
  ios: {
    contentInset: 'always',
    allowsLinkPreview: false,
    scrollEnabled: false,
    preferredContentMode: 'mobile',
  },
  android: {
    overScrollMode: 'never',
    backgroundColor: '#0a0a0a',
  },
};

export default config;
