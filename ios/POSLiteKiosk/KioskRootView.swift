import SwiftUI
import WebKit

struct KioskRootView: View {
    @Bindable var controller: KioskController

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            if controller.kioskURL != nil {
                WebView(controller.page)
                    .webViewBackForwardNavigationGestures(.disabled)
                    .webViewMagnificationGestures(.disabled)
                    .webViewElementFullscreenBehavior(.disabled)
                    .webViewLinkPreviews(.disabled)
                    .ignoresSafeArea()
            } else {
                EmptyStateView { controller.isSettingsPresented = true }
            }

            HiddenSettingsHotspot {
                controller.isSettingsPresented = true
            }
        }
        .onAppear { controller.reload() }
        .sheet(isPresented: $controller.isSettingsPresented) {
            SettingsSheet(controller: controller)
        }
    }
}

private struct EmptyStateView: View {
    let openSettings: () -> Void

    var body: some View {
        VStack(spacing: 24) {
            Text("Kiosk URL not configured")
                .font(.title2.weight(.semibold))
                .foregroundStyle(.white)
            Button("Open Settings", action: openSettings)
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
        }
    }
}

private struct HiddenSettingsHotspot: View {
    let action: () -> Void

    var body: some View {
        VStack {
            HStack {
                Color.clear
                    .frame(width: 80, height: 80)
                    .contentShape(.rect)
                    .onLongPressGesture(minimumDuration: 3.0, perform: action)
                Spacer()
            }
            Spacer()
        }
        .ignoresSafeArea()
        .accessibilityHidden(true)
    }
}
