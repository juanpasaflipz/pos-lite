#!/usr/bin/env bash
# Turn a fresh Raspberry Pi OS (Bookworm or later, with desktop) into a
# permanent KDS kiosk pointed at a tenant's kitchen display.
#
# Usage (on the Pi, after first boot + WiFi):
#   curl -fsSL https://raw.githubusercontent.com/juanpasaflipz/pos-lite/master/scripts/setup-pi-kds.sh | bash -s -- <tenant-subdomain>
#
# Example:
#   curl -fsSL .../setup-pi-kds.sh | bash -s -- juanbertos
#
# Or clone the repo and run locally:
#   bash setup-pi-kds.sh juanbertos
#
# What it does:
#   - Installs Chromium + unclutter (hides idle mouse cursor)
#   - Disables screen blanking, DPMS, and screensaver
#   - Creates a Wayland/X11 autostart entry that launches Chromium in
#     kiosk mode at https://<tenant>.desktop.kitchen/#/kitchen
#   - Survives reboots
#
# Re-run safely: idempotent.

set -euo pipefail

TENANT="${1:-}"
if [[ -z "$TENANT" ]]; then
  echo "Usage: $0 <tenant-subdomain>" >&2
  echo "Example: $0 juanbertos" >&2
  exit 1
fi

KDS_URL="https://${TENANT}.desktop.kitchen/#/kitchen"

echo "==> Installing chromium + unclutter"
sudo apt-get update -qq
sudo apt-get install -y --no-install-recommends chromium-browser unclutter

echo "==> Disabling screen blanking via raspi-config (non-interactive)"
sudo raspi-config nonint do_blanking 1 || true

# Detect session type: Wayland (default on Pi5 / Bookworm with labwc) vs X11.
SESSION_TYPE="x11"
if [[ -d "$HOME/.config/wayfire" ]] || pgrep -x labwc >/dev/null 2>&1 || pgrep -x wayfire >/dev/null 2>&1; then
  SESSION_TYPE="wayland"
fi
echo "==> Detected session: $SESSION_TYPE"

# Chromium flags for a hardened kitchen-wall kiosk.
# --kiosk:                       fullscreen, no chrome
# --noerrdialogs:                no "Aw, snap" dialogs
# --disable-infobars:            no "Chrome is being controlled by..."
# --disable-session-crashed-bubble: no "Restore?" prompt after crash
# --disable-features=Translate:  no translation popup
# --check-for-update-interval:   never silently update mid-shift
# --start-fullscreen:            fullscreen on launch
# --overscroll-history-navigation=0: stop accidental back-swipes
# --password-store=basic:        no gnome-keyring prompt on launch
CHROMIUM_FLAGS=(
  --kiosk
  --noerrdialogs
  --disable-infobars
  --disable-session-crashed-bubble
  --disable-features=Translate
  --check-for-update-interval=31536000
  --start-fullscreen
  --overscroll-history-navigation=0
  --password-store=basic
  --autoplay-policy=no-user-gesture-required
  "$KDS_URL"
)

# Wrapper script — easier to edit later than the autostart entry.
WRAPPER="$HOME/kds-launch.sh"
echo "==> Writing launcher: $WRAPPER"
cat > "$WRAPPER" <<EOF
#!/usr/bin/env bash
# KDS kiosk launcher. Edit the URL below to repoint at a different tenant.
KDS_URL="$KDS_URL"

# Hide idle mouse cursor after 0.1s of inactivity.
unclutter -idle 0.1 -root &

# Belt-and-braces: also tell X11 to ignore screen-blanking timers.
# Harmless on Wayland.
xset s off 2>/dev/null || true
xset -dpms 2>/dev/null || true
xset s noblank 2>/dev/null || true

# Clear any stale "Chromium didn't shut down cleanly" flags so the
# infobar doesn't appear after a power-cycle.
sed -i 's/"exited_cleanly":false/"exited_cleanly":true/' "\$HOME/.config/chromium/Default/Preferences" 2>/dev/null || true
sed -i 's/"exit_type":"[^"]*"/"exit_type":"Normal"/' "\$HOME/.config/chromium/Default/Preferences" 2>/dev/null || true

exec chromium-browser ${CHROMIUM_FLAGS[*]}
EOF
chmod +x "$WRAPPER"

# Autostart entry. Bookworm/Wayland uses ~/.config/autostart for .desktop
# files; older X11 LXDE looks at ~/.config/lxsession/LXDE-pi/autostart.
# Write both — whichever the session uses will fire, the other is ignored.
mkdir -p "$HOME/.config/autostart"
AUTOSTART_DESKTOP="$HOME/.config/autostart/kds.desktop"
echo "==> Writing autostart entry: $AUTOSTART_DESKTOP"
cat > "$AUTOSTART_DESKTOP" <<EOF
[Desktop Entry]
Type=Application
Name=KDS Kiosk
Exec=$WRAPPER
X-GNOME-Autostart-enabled=true
NoDisplay=false
Terminal=false
EOF

# Legacy LXDE autostart (X11 sessions only — harmless on Wayland).
LXDE_AUTOSTART_DIR="$HOME/.config/lxsession/LXDE-pi"
mkdir -p "$LXDE_AUTOSTART_DIR"
LXDE_AUTOSTART="$LXDE_AUTOSTART_DIR/autostart"
if ! grep -qF "$WRAPPER" "$LXDE_AUTOSTART" 2>/dev/null; then
  echo "==> Appending to LXDE autostart: $LXDE_AUTOSTART"
  {
    echo "@xset s off"
    echo "@xset -dpms"
    echo "@xset s noblank"
    echo "@$WRAPPER"
  } >> "$LXDE_AUTOSTART"
fi

echo ""
echo "==============================================="
echo "  KDS kiosk configured for: $TENANT"
echo "  URL: $KDS_URL"
echo ""
echo "  Reboot now to launch:"
echo "    sudo reboot"
echo ""
echo "  To change tenants later, edit:"
echo "    $WRAPPER"
echo "==============================================="
