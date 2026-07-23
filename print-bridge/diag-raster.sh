#!/bin/bash
# Diagnostico: ¿que modo grafico entiende la impresora?
# Imprime 3 patrones etiquetados A, B, C por la cola raw (termica).
# El patron correcto se ve como un RECTANGULO NEGRO solido de ~5cm x 3mm.
# Uso:  bash diag-raster.sh [cola]     (default: termica)
set -euo pipefail
QUEUE="${1:-termica}"

python3 - <<'PYEOF' > /tmp/diag-raster.bin
import sys, os
out = bytearray()
out += b"\x1b\x40"                      # init
def label(s):
    out.extend(b"\x1b\x61\x00")         # left
    out.extend(s.encode("ascii") + b"\x0a")

# --- A: GS v 0 (raster bit image), 48 bytes x 24 filas, todo negro
label("A: GS v 0")
out += bytes((0x1D,0x76,0x30,0x00, 48,0, 24,0)) + b"\xff" * (48*24)
out += b"\x0a\x0a"

# --- B: ESC * m=33 (bit image columna, 24 puntos), 384 columnas negras
label("B: ESC * 33")
out += b"\x1b\x33\x18"                  # line spacing 24 dots
out += bytes((0x1B,0x2A,33, 0x80,0x01)) + b"\xff" * (384*3)
out += b"\x0a"
out += b"\x1b\x32"                      # default spacing
out += b"\x0a"

# --- C: GS v 0 en bloques de 8 filas (por si limita yL)
label("C: GS v 0 x8")
for _ in range(3):
    out += bytes((0x1D,0x76,0x30,0x00, 48,0, 8,0)) + b"\xff" * (48*8)
out += b"\x0a\x0a"

label("FIN")
out += b"\x1b\x64\x04\x1d\x56\x42\x00"  # feed + cut
os.write(1, bytes(out))
PYEOF

lp -d "$QUEUE" -o raw /tmp/diag-raster.bin
echo "Enviado a $QUEUE. Mira el papel: ¿cuales de A, B, C salieron como rectangulo negro solido?"
