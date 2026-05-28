import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'kitchen.desktop.kiosk',
  appName: 'Desktop Kitchen Kiosk',
  webDir: 'dist-kiosk',
  android: {
    overScrollMode: 'never',
    backgroundColor: '#ffffff',
    allowMixedContent: false,
    webContentsDebuggingEnabled: false,
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 1200,
      backgroundColor: '#ffffff',
      androidSplashResourceName: 'splash',
      splashFullScreen: true,
      splashImmersive: true,
    },
  },
};

export default config;
