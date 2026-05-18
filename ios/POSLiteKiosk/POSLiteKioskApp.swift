import SwiftUI
import UIKit

@main
struct POSLiteKioskApp: App {
    @State private var controller = KioskController()

    init() {
        UIApplication.shared.isIdleTimerDisabled = true
    }

    var body: some Scene {
        WindowGroup {
            KioskRootView(controller: controller)
                .preferredColorScheme(.dark)
                .persistentSystemOverlays(.hidden)
                .statusBarHidden(true)
        }
    }
}
