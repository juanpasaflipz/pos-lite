#!/bin/bash
# Instala el driver "POSLite ESC/POS 80mm" (filtro propio en Python del
# sistema — sin dependencias) y crea/reemplaza la cola ghia-web para
# imprimir desde Chrome/Safari/cualquier app en la Mac del local.
#
# Uso:  sudo bash install-ghia-web.sh
set -euo pipefail

[ "$(id -u)" = "0" ] || { echo "Correlo con sudo:  sudo bash install-ghia-web.sh"; exit 1; }

DIR="/Library/Printers/POSLite"
mkdir -p "$DIR"

echo "==> Instalando filtro y PPD en $DIR"
cat > "$DIR/rastertoescpos.py" <<'FILTER_PY_EOF'
#!/usr/bin/env python3
"""rastertoescpos — CUPS raster (v2/v3) → ESC/POS GS v 0 raster.

For the GHIA GTP801 (Gainscha GP-80300 rebrand) and any 80mm Epson-ESC/POS
thermal printer. 203dpi, 576 dots (72 bytes) max width. Pure stdlib — runs
under macOS's sandboxed CUPS filter environment with /usr/bin/python3.

CUPS filter contract: argv = jobid user title copies options [file]
Input: CUPS raster on stdin (or file argv[6]). Output: ESC/POS on stdout.

- Accepts 8-bit gray (W or K) and 1-bit input, both endiannesses
- Threshold at 128 (crisp receipts, no dithering mush)
- Trims trailing blank rows per page (a 200mm Chrome page only feeds content)
- Feed + partial cut (GS V B) per page
"""

import sys
import os

MAX_BYTES_PER_LINE = 72  # 576 dots @ 203dpi on 80mm paper
HEADER_SIZE = 1796
CHUNK_ROWS = 256

# Bit-reverse-free packing helpers ------------------------------------------
# For 1-bit input we can operate on whole bytes; for 8-bit we pack manually.

_INVERT = bytes(255 - i for i in range(256))


def die(msg):
    sys.stderr.write("ERROR: rastertoescpos: %s\n" % msg)
    sys.exit(1)


def main():
    in_path = sys.argv[6] if len(sys.argv) > 6 else None
    try:
        if in_path:
            with open(in_path, "rb") as f:
                data = f.read()
        else:
            data = sys.stdin.buffer.read()
    except OSError as e:
        die("cannot read input: %s" % e)

    if len(data) < 4 + HEADER_SIZE:
        die("input too short (%d bytes) — not CUPS raster" % len(data))

    magic = data[0:4]
    if magic in (b"RaS2", b"RaS3"):
        endian = "big"
    elif magic in (b"2SaR", b"3SaR"):
        endian = "little"
    elif magic in (b"RaSt", b"tSaR"):
        die("CUPS raster v1 not supported (expected v2/v3)")
    else:
        die("bad magic %r — input is not CUPS raster" % magic)

    def u32(buf, off):
        return int.from_bytes(buf[off:off + 4], endian)

    out = bytearray()
    out += b"\x1b\x40"  # ESC @ init

    pos = 4
    pages = 0

    while pos + HEADER_SIZE <= len(data):
        h = data[pos:pos + HEADER_SIZE]
        width = u32(h, 372)
        height = u32(h, 376)
        bits_per_color = u32(h, 384)
        bits_per_pixel = u32(h, 388)
        bytes_per_line = u32(h, 392)
        color_space = u32(h, 400)
        pos += HEADER_SIZE

        if not width or not height or width > 4096 or height > 100000:
            die("implausible page header (w=%d h=%d)" % (width, height))
        if bits_per_pixel != bits_per_color or bits_per_color not in (1, 8):
            die("unsupported format: %d bits/color, %d bits/pixel" % (bits_per_color, bits_per_pixel))

        page_bytes = bytes_per_line * height
        if pos + page_bytes > len(data):
            die("truncated page data (need %d, have %d)" % (page_bytes, len(data) - pos))
        pixels = data[pos:pos + page_bytes]
        pos += page_bytes
        pages += 1

        # CUPS_CSPACE_W = 0 / SW = 18 (max = white) | CUPS_CSPACE_K = 3 (max = black)
        white_is_max = color_space != 3

        out_bpl = min((width + 7) // 8, MAX_BYTES_PER_LINE)
        out_width = min(width, out_bpl * 8)

        rows = []
        last_ink = -1

        if bits_per_color == 1:
            extra = out_bpl * 8 - out_width
            mask_last = (0xFF << extra) & 0xFF if extra > 0 else 0xFF
            for y in range(height):
                base = y * bytes_per_line
                raw = pixels[base:base + out_bpl]
                if len(raw) < out_bpl:
                    raw = raw + b"\x00" * (out_bpl - len(raw))
                row = bytearray(raw.translate(_INVERT) if white_is_max else raw)
                row[-1] &= mask_last
                rows.append(bytes(row))
                if any(row):
                    last_ink = y
        else:
            for y in range(height):
                base = y * bytes_per_line
                line = pixels[base:base + out_width]
                row = bytearray(out_bpl)
                ink = False
                for x, v in enumerate(line):
                    black = (v < 128) if white_is_max else (v >= 128)
                    if black:
                        row[x >> 3] |= 0x80 >> (x & 7)
                        ink = True
                rows.append(bytes(row))
                if ink:
                    last_ink = y

        if last_ink < 0:
            continue  # fully blank page — no paper wasted

        used = last_ink + 1
        y0 = 0
        while y0 < used:
            n = min(CHUNK_ROWS, used - y0)
            out += bytes((0x1D, 0x76, 0x30, 0x00,
                          out_bpl & 0xFF, (out_bpl >> 8) & 0xFF,
                          n & 0xFF, (n >> 8) & 0xFF))
            out += b"".join(rows[y0:y0 + n])
            y0 += n

        out += b"\x1b\x64\x04"          # ESC d 4 — feed past the tear bar
        out += b"\x1d\x56\x42\x00"      # GS V B 0 — partial cut
        sys.stderr.write("INFO: rastertoescpos: page %d: %dx%d dots (trimmed from %d)\n"
                         % (pages, out_width, used, height))

    if not pages:
        die("no pages found in raster stream")

    os.write(1, bytes(out))


if __name__ == "__main__":
    main()
FILTER_PY_EOF

cat > "$DIR/rastertoescpos" <<'WRAPPER_EOF'
#!/bin/bash
# CUPS ejecuta este wrapper (sandbox, usuario _lp): usa python3 del sistema.
for P in /usr/bin/python3 /opt/homebrew/bin/python3 /usr/local/bin/python3; do
  [ -x "$P" ] && exec "$P" /Library/Printers/POSLite/rastertoescpos.py "$@"
done
echo "ERROR: rastertoescpos: no encontre python3" >&2
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

chmod 755 "$DIR/rastertoescpos" "$DIR/rastertoescpos.py"
chmod 644 "$DIR/POSLite_ESCPOS.ppd"
chown -R root:wheel "$DIR"
rm -f "$DIR/rastertoescpos.js" 2>/dev/null || true

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
