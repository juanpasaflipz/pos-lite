#!/bin/bash
# Installs the pos-lite print bridge as a macOS LaunchAgent so it runs
# automatically at login and restarts if it crashes.
#
# Run from this directory on the Mac mini:
#   ./install-macos.sh
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
LABEL="kitchen.desktop.print-bridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGDIR="$HOME/Library/Logs/print-bridge"

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "ERROR: node not found. Install Node 18+ first (https://nodejs.org or: brew install node)"
  exit 1
fi

if [ ! -f "$DIR/config.json" ]; then
  echo "ERROR: $DIR/config.json not found."
  echo "Copy config.example.json to config.json and fill in server_url, agent_token and printer IP."
  exit 1
fi

mkdir -p "$LOGDIR" "$HOME/Library/LaunchAgents"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$DIR/bridge.js</string>
    <string>$DIR/config.json</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOGDIR/bridge.log</string>
  <key>StandardErrorPath</key><string>$LOGDIR/bridge.err.log</string>
</dict>
</plist>
EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

echo "Installed and started: $LABEL"
echo "Logs:    tail -f $LOGDIR/bridge.log"
echo "Stop:    launchctl unload $PLIST"
echo "Restart: launchctl unload $PLIST && launchctl load $PLIST"
