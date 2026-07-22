#!/bin/bash
# Creates a RAW CUPS queue for a USB thermal printer on macOS so the print
# bridge can send ESC/POS bytes through it untouched (`lp -o raw`).
#
# Run from this directory on the Mac, with the printer connected by USB
# and powered on:
#   ./setup-usb-macos.sh [queue-name]        (default queue name: termica)
set -euo pipefail

QUEUE="${1:-termica}"

echo "Looking for USB printers..."
# lpinfo -v lists connection URIs; USB printers show as usb://...
URIS=$(lpinfo -v 2>/dev/null | awk '$1 == "direct" && $2 ~ /^usb:/ { print $2 }')

if [ -z "$URIS" ]; then
  echo "ERROR: no USB printer detected."
  echo "  - Is the printer powered on and connected by USB?"
  echo "  - Try another cable/port, then re-run this script."
  echo "  - To check manually: lpinfo -v   (look for a line starting with 'direct usb://')"
  exit 1
fi

COUNT=$(echo "$URIS" | wc -l | tr -d ' ')
URI=$(echo "$URIS" | head -1)
if [ "$COUNT" -gt 1 ]; then
  echo "Multiple USB printers found:"
  echo "$URIS" | sed 's/^/  - /'
  echo "Using the first one. To use another, run:"
  echo "  lpadmin -p $QUEUE -E -v '<uri>' -m raw"
fi

echo "Found: $URI"
echo "Creating raw queue \"$QUEUE\"..."

# -m raw passes bytes through with no filtering (required for ESC/POS).
# macOS prints a deprecation warning for raw queues — it still works.
lpadmin -p "$QUEUE" -E -v "$URI" -m raw 2>&1 | grep -v -i 'deprecated' || true
cupsenable "$QUEUE" 2>/dev/null || true
cupsaccept "$QUEUE" 2>/dev/null || true

echo
lpstat -p "$QUEUE" || { echo "ERROR: queue was not created."; exit 1; }

echo
echo "Done. Next steps:"
echo "  1. Hardware test (should print a ticket):"
echo "       node test-printer.js usb:$QUEUE"
echo "  2. Point the bridge at it — in config.json:"
echo "       \"printers\": { \"default\": \"usb:$QUEUE\" }"
