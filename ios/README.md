# POS Lite Kiosk — iPad app

Thin SwiftUI shell that wraps the deployed kiosk web app (`<tenant>.desktop.kitchen/kiosk`) in a full-screen iPad WebView.

- **Min iPadOS:** 26.0 (uses native SwiftUI `WebView` from WebKit)
- **Device family:** iPad only
- **Orientation:** Landscape locked
- **Status bar / home indicator:** Hidden / auto-hidden

## Project generation

The Xcode project is generated from `project.yml` with [XcodeGen](https://github.com/yonaskolb/XcodeGen) so it stays out of source control.

```bash
brew install xcodegen
cd ios
xcodegen
open POSLiteKiosk.xcodeproj
```

Re-run `xcodegen` any time you add Swift files or edit `project.yml`.

## First run

1. Build & run on a real iPad (Simulator works too).
2. The app launches into "Kiosk URL not configured."
3. Tap **Open Settings** (or long-press the top-left corner for 3 seconds anytime to reveal settings).
4. Enter the full kiosk URL, e.g. `https://acme.desktop.kitchen/kiosk`.
5. Save → kiosk loads.

The URL persists in `UserDefaults` across launches.

## Hidden settings gesture

Anywhere in the kiosk, **long-press the top-left corner for 3 seconds** to open the settings sheet. Use this to switch tenants or recover from a misconfiguration without uninstalling.

## Kiosk lockdown (recommended)

For production deployment on a customer-facing iPad, enable **Guided Access** so customers can't exit the app:

1. Settings → Accessibility → Guided Access → On
2. Set a Guided Access passcode.
3. Open the Kiosk app.
4. Triple-click the top/side button → Start.

Triple-click + passcode exits Guided Access for staff.

For fleet deployment, use Apple Configurator or an MDM with **Single App Mode** instead — fully unattended, survives reboots, no passcode dance.

## What this app intentionally does NOT do

- No card-present payments (web Stripe/MP flows only). Escalate to a Capacitor wrap if hardware readers are needed.
- No native push notifications.
- No offline mode — the kiosk web app handles its own service worker.

## File layout

```
ios/
├── project.yml                       # XcodeGen spec
├── .gitignore                        # ignores generated .xcodeproj
└── POSLiteKiosk/
    ├── POSLiteKioskApp.swift          # @main, idle timer disable, scene
    ├── KioskRootView.swift            # WebView + hidden settings hotspot
    ├── KioskController.swift          # @Observable: URL state, WebPage, reload
    ├── SettingsSheet.swift            # URL editor
    ├── Info.plist                     # orientation, status bar, ATS
    ├── Assets.xcassets/               # AppIcon, AccentColor, LaunchBackground
    └── Preview Content/               # SwiftUI preview assets
```
