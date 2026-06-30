import { Capacitor } from '@capacitor/core';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';

type TapStrength = 'light' | 'medium' | 'heavy';

const isNative = Capacitor.isNativePlatform();

function webVibrate(ms: number) {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(ms);
    }
  } catch {
    // iOS WebView and some browsers don't expose vibrate — silent no-op.
  }
}

export function tap(strength: TapStrength = 'light') {
  if (isNative) {
    const style =
      strength === 'heavy' ? ImpactStyle.Heavy : strength === 'medium' ? ImpactStyle.Medium : ImpactStyle.Light;
    Haptics.impact({ style }).catch(() => {});
    return;
  }
  webVibrate(strength === 'heavy' ? 25 : strength === 'medium' ? 15 : 10);
}

export function selectionChanged() {
  if (isNative) {
    Haptics.selectionChanged().catch(() => {});
    return;
  }
  webVibrate(8);
}

export function success() {
  if (isNative) {
    Haptics.notification({ type: NotificationType.Success }).catch(() => {});
    return;
  }
  webVibrate(20);
}
