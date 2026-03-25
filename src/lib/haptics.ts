// Haptic feedback utilities
// Uses @capacitor/haptics on native, navigator.vibrate as web fallback.

let HapticsPlugin: any = null;
let isNative = false;

try {
  const cap = (window as any).Capacitor;
  isNative = !!cap?.isNativePlatform?.();
} catch {}

if (isNative) {
  import('@capacitor/haptics').then((mod) => {
    HapticsPlugin = mod.Haptics;
  }).catch(() => {});
}

function vibrate(pattern: number | number[]) {
  if (typeof navigator !== 'undefined' && navigator.vibrate) {
    navigator.vibrate(pattern);
  }
}

export async function tapFeedback() {
  if (HapticsPlugin) {
    try {
      await HapticsPlugin.impact({ style: 'light' });
      return;
    } catch {}
  }
  vibrate(10);
}

export async function successFeedback() {
  if (HapticsPlugin) {
    try {
      await HapticsPlugin.notification({ type: 'success' });
      return;
    } catch {}
  }
  vibrate([10, 50, 10]);
}

export async function errorFeedback() {
  if (HapticsPlugin) {
    try {
      await HapticsPlugin.notification({ type: 'error' });
      return;
    } catch {}
  }
  vibrate([50, 30, 50]);
}
