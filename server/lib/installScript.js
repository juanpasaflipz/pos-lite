/**
 * Renders the one-liner print-bridge installer served by
 * GET /api/print-jobs/install.sh?code=...
 *
 * The tenant copies a single command from the Printer Management screen:
 *
 *   curl -fsSL https://<tenant>.desktop.kitchen/api/print-jobs/install.sh?code=XXXX | bash
 *
 * and this script does the rest on the store's Mac: portable Node (no sudo),
 * bridge download, USB raw-passthrough CUPS queue, config.json with the
 * agent token embedded, LaunchAgent, and a local hardware test print.
 *
 * macOS only for now (that's what stores run). Keep it dependency-free.
 */

const NODE_VERSION = 'v20.19.0'; // LTS; only used when the Mac has no Node >= 18

export function renderInstallScript({ serverUrl, token }) {
  // Both values are server-generated (https URL + pb_hex token) — no user
  // input reaches this template, but quote defensively anyway.
  return `#!/bin/bash
# pos-lite print bridge — instalador automatico (macOS)
# Generado por ${serverUrl}
set -euo pipefail

SERVER_URL='${serverUrl}'
TOKEN='${token}'
DIR="$HOME/.pos-print-bridge"
QUEUE="termica"
LABEL="kitchen.desktop.print-bridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGDIR="$HOME/Library/Logs/print-bridge"
NODE_VERSION="${NODE_VERSION}"

say()  { printf '\\n\\033[1m==> %s\\033[0m\\n' "$1"; }
fail() { printf '\\n\\033[31mERROR: %s\\033[0m\\n' "$1"; exit 1; }

[ "$(uname -s)" = "Darwin" ] || fail "Este instalador es para macOS."

mkdir -p "$DIR" "$LOGDIR" "$HOME/Library/LaunchAgents"

# ---------- 1. Node (usa el del sistema si es >= 18; si no, uno portatil) ----------
say "Verificando Node..."
NODE_BIN="$(command -v node || true)"
NODE_OK=""
if [ -n "$NODE_BIN" ]; then
  MAJOR="$($NODE_BIN -e 'console.log(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
  [ "$MAJOR" -ge 18 ] && NODE_OK="yes"
fi
if [ -z "$NODE_OK" ]; then
  ARCH="$(uname -m)"; [ "$ARCH" = "x86_64" ] && ARCH="x64"
  NODE_DIR="$DIR/node-$NODE_VERSION-darwin-$ARCH"
  NODE_BIN="$NODE_DIR/bin/node"
  if [ ! -x "$NODE_BIN" ]; then
    say "Descargando Node portatil ($NODE_VERSION $ARCH)..."
    curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-darwin-$ARCH.tar.gz" -o "$DIR/node.tar.gz" \\
      || fail "No se pudo descargar Node. ¿Hay internet?"
    tar -xzf "$DIR/node.tar.gz" -C "$DIR"
    rm -f "$DIR/node.tar.gz"
  fi
  [ -x "$NODE_BIN" ] || fail "Node portatil no quedo instalado."
fi
say "Node listo: $NODE_BIN"

# ---------- 2. Descargar el bridge ----------
say "Descargando el puente de impresion..."
curl -fsSL "$SERVER_URL/api/print-jobs/bridge.js" -o "$DIR/bridge.js" \\
  || fail "No se pudo descargar bridge.js desde $SERVER_URL"

# ---------- 3. Cola CUPS para la impresora USB ----------
say "Buscando impresora termica USB..."
URI="$(lpinfo -v 2>/dev/null | awk '$1 == "direct" && $2 ~ /^usb:/ { print $2; exit }')"
[ -n "$URI" ] || fail "No se detecto impresora USB. Conectala por USB, enciendela y vuelve a correr el comando."
say "Impresora encontrada: $URI"

cat > "$DIR/raw-passthrough.ppd" <<'PPDEOF'
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

say "Creando cola de impresion \\"$QUEUE\\"..."
lpadmin -p "$QUEUE" -E -v "$URI" -P "$DIR/raw-passthrough.ppd" 2>&1 | grep -v -i 'deprecated' || true
cupsenable "$QUEUE" 2>/dev/null || true
cupsaccept "$QUEUE" 2>/dev/null || true
lpstat -p "$QUEUE" >/dev/null || fail "No se pudo crear la cola CUPS."

# ---------- 4. Config ----------
say "Escribiendo configuracion..."
cat > "$DIR/config.json" <<CFGEOF
{
  "server_url": "$SERVER_URL",
  "agent_token": "$TOKEN",
  "agent_id": "$(hostname -s | tr '[:upper:]' '[:lower:]')-bridge",
  "poll_ms": 3000,
  "printers": { "default": "usb:$QUEUE" }
}
CFGEOF

# ---------- 5. LaunchAgent (arranque automatico) ----------
say "Instalando servicio de arranque automatico..."
cat > "$PLIST" <<PLISTEOF
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
PLISTEOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

# ---------- 6. Prueba directa de hardware ----------
say "Imprimiendo ticket de prueba..."
printf '\\x1b@\\x1bt\\x02\\x1ba\\x01\\x1d!\\x11PUENTE INSTALADO\\x0a\\x1d!\\x00Impresora conectada\\x0a\\x1ba\\x00\\x1bd\\x03\\x1dVB\\x00' \\
  | lp -d "$QUEUE" -o raw -s || true

say "¡Listo!"
echo "  - El puente quedo corriendo y arrancara solo al encender la Mac."
echo "  - En el POS (Gestion de Impresoras) el estatus cambiara a Conectado en ~1 minuto."
echo "  - Prueba de punta a punta: boton 'Impresion de prueba' en el POS."
echo "  - Logs: tail -f $LOGDIR/bridge.log"
echo "  - Recomendado en esta Mac: inicio de sesion automatico y nunca dormir (Energia)."
`;
}
