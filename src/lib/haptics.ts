// Haptic feedback utilities
// Uses navigator.vibrate as a web fallback.
// When @capacitor/haptics is installed, swap to native APIs.

function vibrate(pattern: number | number[]) {
  if (typeof navigator !== 'undefined' && navigator.vibrate) {
    navigator.vibrate(pattern);
  }
}

export async function tapFeedback() {
  vibrate(10);
}

export async function successFeedback() {
  vibrate([10, 50, 10]);
}

export async function errorFeedback() {
  vibrate([50, 30, 50]);
}
