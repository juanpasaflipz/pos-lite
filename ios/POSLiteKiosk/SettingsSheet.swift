import SwiftUI

struct SettingsSheet: View {
    @Bindable var controller: KioskController
    @Environment(\.dismiss) private var dismiss

    @State private var draft: String = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(
                        "https://demo.desktop.kitchen/kiosk",
                        text: $draft
                    )
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                } header: {
                    Text("Kiosk URL")
                } footer: {
                    Text("Full URL to the tenant kiosk, e.g. https://acme.desktop.kitchen/kiosk")
                }

                if let error = controller.lastLoadError {
                    Section("Last load error") {
                        Text(error)
                            .font(.footnote.monospaced())
                            .foregroundStyle(.red)
                    }
                }

                Section {
                    Button("Reload kiosk") {
                        controller.reload()
                        dismiss()
                    }
                    .disabled(URL(string: draft.trimmingCharacters(in: .whitespacesAndNewlines)) == nil)
                }
            }
            .navigationTitle("Kiosk Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        controller.kioskURLString = draft.trimmingCharacters(in: .whitespacesAndNewlines)
                        controller.reload()
                        dismiss()
                    }
                    .disabled(draft == controller.kioskURLString)
                }
            }
            .onAppear { draft = controller.kioskURLString }
        }
    }
}
