#!/bin/bash
# Instala el driver "POSLite ESC/POS 80mm" (filtro propio, lenguaje ESC/POS
# verificado con la GTP801) y crea/reemplaza la cola ghia-web para imprimir
# desde Chrome/Safari/cualquier app en la Mac del local.
#
# Uso:  sudo bash install-ghia-web.sh
set -euo pipefail

[ "$(id -u)" = "0" ] || { echo "Correlo con sudo:  sudo bash install-ghia-web.sh"; exit 1; }

DIR="/Library/Printers/POSLite"
mkdir -p "$DIR"

echo "==> Instalando filtro y PPD en $DIR"
cat > "$DIR/rastertoescpos.js" <<'FILTER_JS_EOF'
#!/usr/bin/env node
/**
 * rastertoescpos — CUPS raster (v2/v3) → ESC/POS GS v 0 raster.
 *
 * Written for the GHIA GTP801 (Gainscha GP-80300 rebrand) and any 80mm
 * Epson-ESC/POS-compatible thermal printer. 203dpi, 576 dots (72 bytes) max.
 *
 * CUPS filter contract: argv = jobid user title copies options [file]
 * Input: CUPS raster on stdin (or file argv[6]). Output: ESC/POS on stdout.
 *
 * Features:
 *  - Accepts 8-bit gray (W or K) and 1-bit input, any endianness/sync v2-v3
 *  - Threshold at 128 (text/receipts want crisp black, not dithering mush)
 *  - Trims trailing blank rows per page, so a "200mm" page from Chrome only
 *    feeds as much paper as it has content
 *  - Feed + partial cut (GS V B) at the end of each page
 */

'use strict';

const fs = require('fs');

const MAX_BYTES_PER_LINE = 72; // 576 dots @ 203dpi on 80mm paper
const HEADER_SIZE = 1796;
const CHUNK_ROWS = 256;

function die(msg) {
  process.stderr.write(`ERROR: rastertoescpos: ${msg}\n`);
  process.exit(1);
}

// ---------- read all input ----------
const inputPath = process.argv[7]; // argv: [node, script, job, user, title, copies, options, file?]
let data;
try {
  data = inputPath ? fs.readFileSync(inputPath) : fs.readFileSync(0);
} catch (e) {
  die(`cannot read input: ${e.message}`);
}
if (data.length < 4 + HEADER_SIZE) die(`input too short (${data.length} bytes) — not CUPS raster`);

// ---------- sync word / endianness ----------
const magic = data.toString('latin1', 0, 4);
let littleEndian;
if (magic === 'RaS2' || magic === 'RaS3') littleEndian = false;
else if (magic === '2SaR' || magic === '3SaR') littleEndian = true;
else if (magic === 'RaSt' || magic === 'tSaR') die('CUPS raster v1 not supported (expected v2/v3)');
else die(`bad magic "${magic}" — input is not CUPS raster`);

const u32 = (buf, off) => (littleEndian ? buf.readUInt32LE(off) : buf.readUInt32BE(off));

// ---------- ESC/POS output ----------
const out = [];
out.push(Buffer.from([0x1b, 0x40])); // ESC @ init

let pos = 4;
let pages = 0;

while (pos + HEADER_SIZE <= data.length) {
  const h = data.subarray(pos, pos + HEADER_SIZE);
  const width = u32(h, 372);
  const height = u32(h, 376);
  const bitsPerColor = u32(h, 384);
  const bitsPerPixel = u32(h, 388);
  const bytesPerLine = u32(h, 392);
  const colorSpace = u32(h, 400);
  pos += HEADER_SIZE;

  if (!width || !height || width > 4096 || height > 100000) {
    die(`implausible page header (w=${width} h=${height}) — endianness/offset bug?`);
  }
  if (bitsPerPixel !== bitsPerColor || (bitsPerColor !== 1 && bitsPerColor !== 8)) {
    die(`unsupported format: ${bitsPerColor} bits/color, ${bitsPerPixel} bits/pixel (need 1 or 8-bit gray)`);
  }
  const pageBytes = bytesPerLine * height;
  if (pos + pageBytes > data.length) die(`truncated page data (need ${pageBytes}, have ${data.length - pos})`);
  const pixels = data.subarray(pos, pos + pageBytes);
  pos += pageBytes;
  pages++;

  // CUPS_CSPACE_W = 0 (max = white) | CUPS_CSPACE_SW = 18 | CUPS_CSPACE_K = 3 (max = black)
  const whiteIsMax = colorSpace !== 3;

  const outBytesPerLine = Math.min(Math.ceil(width / 8), MAX_BYTES_PER_LINE);
  const outWidth = Math.min(width, outBytesPerLine * 8);

  // ---- convert to 1-bit rows (1 = black), find last non-blank row ----
  const rows = [];
  let lastInk = -1;
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(outBytesPerLine);
    const base = y * bytesPerLine;
    let ink = false;
    if (bitsPerColor === 8) {
      for (let x = 0; x < outWidth; x++) {
        const v = pixels[base + x];
        const black = whiteIsMax ? v < 128 : v >= 128;
        if (black) {
          row[x >> 3] |= 0x80 >> (x & 7);
          ink = true;
        }
      }
    } else {
      // 1-bit input: bit set = max value (white for W, black for K)
      for (let b = 0; b < outBytesPerLine; b++) {
        const v = pixels[base + b] ?? 0;
        row[b] = whiteIsMax ? ~v & 0xff : v;
      }
      // mask bits beyond width in the final byte
      const extra = outBytesPerLine * 8 - outWidth;
      if (extra > 0) row[outBytesPerLine - 1] &= 0xff << extra;
      ink = row.some((v) => v !== 0);
    }
    rows.push(row);
    if (ink) lastInk = y;
  }

  if (lastInk < 0) continue; // fully blank page: no paper wasted

  // ---- emit in chunks: GS v 0 m xL xH yL yH data ----
  const usedRows = lastInk + 1;
  for (let y0 = 0; y0 < usedRows; y0 += CHUNK_ROWS) {
    const n = Math.min(CHUNK_ROWS, usedRows - y0);
    out.push(Buffer.from([
      0x1d, 0x76, 0x30, 0x00,
      outBytesPerLine & 0xff, (outBytesPerLine >> 8) & 0xff,
      n & 0xff, (n >> 8) & 0xff,
    ]));
    out.push(Buffer.concat(rows.slice(y0, y0 + n)));
  }

  out.push(Buffer.from([0x1b, 0x64, 0x04])); // ESC d 4 — feed past the tear bar
  out.push(Buffer.from([0x1d, 0x56, 0x42, 0x00])); // GS V B 0 — partial cut
  process.stderr.write(`INFO: rastertoescpos: page ${pages}: ${outWidth}x${usedRows} dots (trimmed from ${height})\n`);
}

if (!pages) die('no pages found in raster stream');

process.stdout.write(Buffer.concat(out));
FILTER_JS_EOF

cat > "$DIR/rastertoescpos" <<'WRAPPER_EOF'
#!/bin/bash
# CUPS corre este wrapper como usuario _lp: localiza node y ejecuta el filtro.
for N in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node /Users/*/.pos-print-bridge/node-*/bin/node; do
  [ -x "$N" ] && exec "$N" /Library/Printers/POSLite/rastertoescpos.js "$@"
done
echo "ERROR: rastertoescpos: no encontre node en esta Mac" >&2
exit 1
WRAPPER_EOF

cat > "$DIR/POSLite_ESCPOS.ppd" <<'PPD_EOF'
*PPD-Adobe: "4.3"
*FormatVersion: "4.3"
*FileVersion: "1.0"
*LanguageVersion: English
*LanguageEncoding: ISOLatin1
*PCFileName: "POSLITE.PPD"
*Manufacturer: "POSLite"
*Product: "(POSLite ESC/POS 80mm)"
*ModelName: "POSLite ESC/POS 80mm"
*ShortNickName: "POSLite ESC/POS 80mm"
*NickName: "POSLite ESC/POS 80mm (GHIA GTP801)"
*PSVersion: "(3010.000) 550"
*LanguageLevel: "3"
*ColorDevice: False
*DefaultColorSpace: Gray
*FileSystem: False
*Throughput: "8"
*LandscapeOrientation: Plus90
*VariablePaperSize: True
*TTRasterizer: Type42
*cupsVersion: 1.4
*cupsManualCopies: True
*cupsModelNumber: 0
*cupsFilter: "application/vnd.cups-raster 0 /Library/Printers/POSLite/rastertoescpos"

*OpenUI *PageSize/Media Size: PickOne
*OrderDependency: 10 AnySetup *PageSize
*DefaultPageSize: X72MMY200MM
*PageSize X72MMY100MM/72mm x 100mm:  "<</PageSize[204 283]/HWResolution[203 203]/cupsColorSpace 0/cupsBitsPerColor 8/ImagingBBox null>>setpagedevice"
*PageSize X72MMY150MM/72mm x 150mm:  "<</PageSize[204 425]/HWResolution[203 203]/cupsColorSpace 0/cupsBitsPerColor 8/ImagingBBox null>>setpagedevice"
*PageSize X72MMY200MM/72mm x 200mm (recibo):  "<</PageSize[204 567]/HWResolution[203 203]/cupsColorSpace 0/cupsBitsPerColor 8/ImagingBBox null>>setpagedevice"
*PageSize X72MMY300MM/72mm x 300mm:  "<</PageSize[204 850]/HWResolution[203 203]/cupsColorSpace 0/cupsBitsPerColor 8/ImagingBBox null>>setpagedevice"
*PageSize X72MMY400MM/72mm x 400mm (recibo largo):  "<</PageSize[204 1134]/HWResolution[203 203]/cupsColorSpace 0/cupsBitsPerColor 8/ImagingBBox null>>setpagedevice"
*CloseUI: *PageSize

*OpenUI *PageRegion/Page Region: PickOne
*OrderDependency: 10 AnySetup *PageRegion
*DefaultPageRegion: X72MMY200MM
*PageRegion X72MMY100MM/72mm x 100mm:  "<</PageSize[204 283]/HWResolution[203 203]/cupsColorSpace 0/cupsBitsPerColor 8/ImagingBBox null>>setpagedevice"
*PageRegion X72MMY150MM/72mm x 150mm:  "<</PageSize[204 425]/HWResolution[203 203]/cupsColorSpace 0/cupsBitsPerColor 8/ImagingBBox null>>setpagedevice"
*PageRegion X72MMY200MM/72mm x 200mm (recibo):  "<</PageSize[204 567]/HWResolution[203 203]/cupsColorSpace 0/cupsBitsPerColor 8/ImagingBBox null>>setpagedevice"
*PageRegion X72MMY300MM/72mm x 300mm:  "<</PageSize[204 850]/HWResolution[203 203]/cupsColorSpace 0/cupsBitsPerColor 8/ImagingBBox null>>setpagedevice"
*PageRegion X72MMY400MM/72mm x 400mm (recibo largo):  "<</PageSize[204 1134]/HWResolution[203 203]/cupsColorSpace 0/cupsBitsPerColor 8/ImagingBBox null>>setpagedevice"
*CloseUI: *PageRegion

*DefaultImageableArea: X72MMY200MM
*ImageableArea X72MMY100MM/72mm x 100mm:  "0 0 204 283"
*ImageableArea X72MMY150MM/72mm x 150mm:  "0 0 204 425"
*ImageableArea X72MMY200MM/72mm x 200mm (recibo):  "0 0 204 567"
*ImageableArea X72MMY300MM/72mm x 300mm:  "0 0 204 850"
*ImageableArea X72MMY400MM/72mm x 400mm (recibo largo):  "0 0 204 1134"

*DefaultPaperDimension: X72MMY200MM
*PaperDimension X72MMY100MM/72mm x 100mm:  "204 283"
*PaperDimension X72MMY150MM/72mm x 150mm:  "204 425"
*PaperDimension X72MMY200MM/72mm x 200mm (recibo):  "204 567"
*PaperDimension X72MMY300MM/72mm x 300mm:  "204 850"
*PaperDimension X72MMY400MM/72mm x 400mm (recibo largo):  "204 1134"

*MaxMediaWidth: "204"
*MaxMediaHeight: "3000"
*ParamCustomPageSize Width: 1 points 72 204
*ParamCustomPageSize Height: 2 points 85 3000
*ParamCustomPageSize WidthOffset: 3 points 0 0
*ParamCustomPageSize HeightOffset: 4 points 0 0
*ParamCustomPageSize Orientation: 5 int 0 0
*CustomPageSize True: "<</PageSize[5 -2]/HWResolution[203 203]/cupsColorSpace 0/cupsBitsPerColor 8/ImagingBBox null>>setpagedevice pop pop pop pop pop"
*HWMargins: 0 0 0 0

*OpenUI *ColorModel/Color Mode: PickOne
*OrderDependency: 10 AnySetup *ColorModel
*DefaultColorModel: Gray
*ColorModel Gray/Grayscale: "<</cupsColorSpace 0/cupsBitsPerColor 8/cupsColorOrder 0>>setpagedevice"
*CloseUI: *ColorModel

*DefaultResolution: 203dpi
*OpenUI *Resolution/Resolution: PickOne
*OrderDependency: 10 AnySetup *Resolution
*Resolution 203dpi/203 DPI: "<</HWResolution[203 203]>>setpagedevice"
*CloseUI: *Resolution
PPD_EOF

chmod 755 "$DIR/rastertoescpos" "$DIR/rastertoescpos.js"
chmod 644 "$DIR/POSLite_ESCPOS.ppd"
chown -R root:wheel "$DIR"

echo "==> Buscando impresora USB..."
URI="$(lpinfo -v 2>/dev/null | awk '$1 == "direct" && $2 ~ /^usb:/ { print $2; exit }')"
[ -n "$URI" ] || { echo "ERROR: no se detecto impresora USB. Conectala y reintenta."; exit 1; }
echo "    $URI"

echo "==> Creando cola ghia-web (reemplaza la anterior si existia)..."
lpadmin -p ghia-web -E -v "$URI" -P "$DIR/POSLite_ESCPOS.ppd" 2>&1 | grep -v -i 'deprecated' || true
cupsenable ghia-web 2>/dev/null || true
cupsaccept ghia-web 2>/dev/null || true
lpstat -p ghia-web >/dev/null || { echo "ERROR: la cola no se creo."; exit 1; }

echo "==> Impresion de prueba (cadena completa: texto -> PDF -> raster -> ESC/POS)..."
printf 'PRUEBA GHIA-WEB\nSi ves esto, Chrome ya puede imprimir.\n' | lp -d ghia-web -o media=X72MMY200MM -s || true

echo
echo "Listo. En Chrome elige Destination: ghia-web y Paper size: 72mm x 200mm."
echo "Si el ticket de prueba no salio en ~10 segundos, manda:  sudo tail -20 /var/log/cups/error_log"
