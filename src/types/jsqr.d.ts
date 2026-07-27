// jsqr ships without its own published @types package on npm (and this
// sandbox can't `npm install` it — no network on the device bridge), so we
// declare the shape ourselves. This is a fallback: if the real package is
// later installed with bundled types, TypeScript prefers those and this file
// is simply unused. Shape matches jsQR's documented API (cozmo/jsQR).
declare module 'jsqr' {
  export interface QRCodePoint {
    x: number;
    y: number;
  }

  export interface QRCodeLocation {
    topRightCorner: QRCodePoint;
    topLeftCorner: QRCodePoint;
    bottomRightCorner: QRCodePoint;
    bottomLeftCorner: QRCodePoint;
    topRightFinderPattern: QRCodePoint;
    topLeftFinderPattern: QRCodePoint;
    bottomLeftFinderPattern: QRCodePoint;
    bottomRightAlignmentPattern?: QRCodePoint;
  }

  export interface QRCode {
    binaryData: number[];
    data: string;
    chunks: unknown[];
    version: number;
    location: QRCodeLocation;
  }

  export interface Options {
    inversionAttempts?: 'dontInvert' | 'onlyInvert' | 'attemptBoth' | 'invertFirst';
  }

  export default function jsQR(
    data: Uint8ClampedArray,
    width: number,
    height: number,
    options?: Options
  ): QRCode | null;
}
