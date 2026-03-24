/**
 * Capacitor plugin interface for Getnet Tap on Phone (Android NFC).
 * The native side is implemented in Java/Kotlin using the Getnet Tap on Phone SDK.
 * This TypeScript interface defines the bridge contract.
 */

export interface GetnetTapResult {
  success: boolean;
  paymentId: string;
  authorizationCode?: string;
  cardBrand?: string;
  cardLastFour?: string;
  amount: number;
  error?: string;
}

export interface GetnetTapPlugin {
  /**
   * Check if Tap on Phone is available on this device.
   * Returns false on iOS and devices without NFC.
   */
  isAvailable(): Promise<{ available: boolean }>;

  /**
   * Initialize the Getnet SDK with merchant credentials.
   */
  initialize(options: {
    merchantId: string;
    environment: 'sandbox' | 'production';
    clientId: string;
    clientSecret: string;
  }): Promise<{ success: boolean }>;

  /**
   * Start a Tap on Phone payment.
   * Opens the NFC reader UI and waits for card tap.
   */
  startPayment(options: {
    amount: number; // in centavos
    orderId: string;
    description?: string;
  }): Promise<GetnetTapResult>;

  /**
   * Cancel an in-progress Tap on Phone payment.
   */
  cancelPayment(): Promise<{ success: boolean }>;
}

/**
 * Get the Getnet Tap plugin from Capacitor.
 * Returns null if not available (web, iOS, or no plugin registered).
 */
export function getGetnetTapPlugin(): GetnetTapPlugin | null {
  const capacitor = (window as any).Capacitor;
  if (!capacitor?.isNativePlatform?.() || capacitor.getPlatform?.() !== 'android') {
    return null;
  }

  const plugins = capacitor.Plugins;
  return plugins?.GetnetTap || null;
}
