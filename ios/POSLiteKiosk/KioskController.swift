import Foundation
import Observation
import WebKit

@MainActor
@Observable
final class KioskController {
    private static let urlDefaultsKey = "kiosk.url"

    var kioskURLString: String {
        didSet {
            UserDefaults.standard.set(kioskURLString, forKey: Self.urlDefaultsKey)
        }
    }

    var isSettingsPresented: Bool = false
    var lastLoadError: String?

    let page: WebPage

    init() {
        self.kioskURLString = UserDefaults.standard.string(forKey: Self.urlDefaultsKey) ?? ""

        var config = WebPage.Configuration()
        config.defaultNavigationPreferences.allowsContentJavaScript = true
        self.page = WebPage(configuration: config)
    }

    var kioskURL: URL? {
        let trimmed = kioskURLString.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        return URL(string: trimmed)
    }

    func reload() {
        guard let url = kioskURL else { return }
        lastLoadError = nil
        Task { @MainActor in
            do {
                for try await _ in page.load(url) { }
            } catch {
                self.lastLoadError = error.localizedDescription
            }
        }
    }
}
