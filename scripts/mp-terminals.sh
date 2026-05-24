#!/usr/bin/env bash
#
# MP Point terminal helper.
#
# Usage:
#   MP_ACCESS_TOKEN=APP_USR-... ./scripts/mp-terminals.sh list
#   MP_ACCESS_TOKEN=APP_USR-... ./scripts/mp-terminals.sh set-pdv <DEVICE_ID>
#   MP_ACCESS_TOKEN=APP_USR-... ./scripts/mp-terminals.sh set-standalone <DEVICE_ID>
#
# Get the access token from pos-lite Account → MP (it's the OAuth'd token
# stored in tenant_credentials), or from your MP developer panel.

set -euo pipefail

# Auto-load .env from repo root if MP_ACCESS_TOKEN isn't already exported.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"
if [[ -z "${MP_ACCESS_TOKEN:-}" && -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a
fi

API="https://api.mercadopago.com/point/integration-api/devices"
TOKEN="${MP_ACCESS_TOKEN:-}"

if [[ -z "$TOKEN" ]]; then
  echo "error: MP_ACCESS_TOKEN env var is required" >&2
  exit 1
fi

cmd="${1:-list}"

case "$cmd" in
  list)
    curl -sf -H "Authorization: Bearer $TOKEN" "$API" | jq '.devices[] | {id, operating_mode, pos_id, store_id, external_pos_id}'
    ;;
  set-pdv|set-standalone)
    device_id="${2:-}"
    if [[ -z "$device_id" ]]; then
      echo "error: device id required. Run '$0 list' first." >&2
      exit 1
    fi
    mode=$([[ "$cmd" == "set-pdv" ]] && echo "PDV" || echo "STANDALONE")
    tmp_body=$(mktemp)
    http_code=$(curl -sS -o "$tmp_body" -w "%{http_code}" -X PATCH "$API/$device_id" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      -d "{\"operating_mode\":\"$mode\"}" || echo "000")
    echo "HTTP $http_code"
    cat "$tmp_body"
    echo
    rm -f "$tmp_body"
    if [[ "$http_code" =~ ^2 ]]; then
      echo "✔ Set $device_id → $mode"
    else
      echo "✘ Failed (HTTP $http_code)"
      exit 1
    fi
    ;;
  *)
    echo "usage: $0 {list|set-pdv <id>|set-standalone <id>}" >&2
    exit 1
    ;;
esac
