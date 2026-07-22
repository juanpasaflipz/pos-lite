#!/bin/bash
# Creates a pass-through CUPS queue for a USB thermal printer on macOS so the
# print bridge can send ESC/POS bytes through it untouched (`lp -o raw`).
#
# Recent macOS removed raw queues (`lpadmin -m raw`), so this installs a
# minimal pass-through PPD instead: its cupsFilter line maps raw jobs to "-"
# (no filter), which is the supported way to get byte-exact output.
#
# Run from this directory on the Mac, with the printer connected by USB
# and powered on:
#   ./setup-usb-macos.sh [queue-name]        (default queue name: termica)
set -euo pipefail

QUEUE="${1:-termica}"
DIR="$(cd "$(dirname "$0")" && pwd)"
PPD="$DIR/raw-passthrough.ppd"

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
  echo "  lpadmin -p $QUEUE -E -v '<uri>' -P $PPD"
fi

echo "Found: $URI"
echo "Writing pass-through PPD: $PPD"

cat > "$PPD" <<'PPDEOF'
*PPD-Adobe: "4.3"
*FormatVersion: "4.3"
*FileVersion: "1.1"
*LanguageVersion: English
*LanguageEncoding: ISOLatin1
*PCFileName: "RAW.PPD"
*Manufacturer: "Generic"
*Product: "(Generic Raw Printer)"
*ModelName: "Generic Raw Printer"
*ShortNickName: "Raw Printer"
*NickName: "Generic Raw Printer (pass-through)"
*PSVersion: "(2001.000) 0"
*LanguageLevel: "2"
*ColorDevice: False
*DefaultColorSpace: Gray
*FileSystem: False
*Throughput: "8"
*LandscapeOrientation: Plus90
*TTRasterizer: Type42
*cupsVersion: 1.0
*cupsManualCopies: True
*cupsModelNumber: 0
*cupsFilter: "application/vnd.cups-raw 0 -"
*OpenUI *PageSize/Page Size: PickOne
*OrderDependency: 10 AnySetup *PageSize
*DefaultPageSize: X80MM
*PageSize X80MM/80mm Roll: ""
*CloseUI: *PageSize
*OpenUI *PageRegion/Page Region: PickOne
*OrderDependency: 10 AnySetup *PageRegion
*DefaultPageRegion: X80MM
*PageRegion X80MM/80mm Roll: ""
*CloseUI: *PageRegion
*DefaultImageableArea: X80MM
*ImageableArea X80MM/80mm Roll: "0 0 226 720"
*DefaultPaperDimension: X80MM
*PaperDimension X80MM/80mm Roll: "226 720"
PPDEOF

echo "Creating queue \"$QUEUE\"..."
# macOS warns that printer drivers (PPDs) are deprecated — it still works.
lpadmin -p "$QUEUE" -E -v "$URI" -P "$PPD" 2>&1 | grep -v -i 'deprecated' || true
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
