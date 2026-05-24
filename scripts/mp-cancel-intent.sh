#!/usr/bin/env bash
# Cancel a stuck MP Point payment intent.
# Usage:  ./scripts/mp-cancel-intent.sh <DEVICE_ID> <INTENT_ID>

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"
if [[ -z "${MP_ACCESS_TOKEN:-}" && -f "$ENV_FILE" ]]; then
  set -a; source "$ENV_FILE"; set +a
fi

DEVICE="${1:?Usage: $0 <device-id> <intent-id>}"
INTENT="${2:?Usage: $0 <device-id> <intent-id>}"

curl -sS -X DELETE \
  "https://api.mercadopago.com/point/integration-api/devices/$DEVICE/payment-intents/$INTENT" \
  -H "Authorization: Bearer $MP_ACCESS_TOKEN" \
  -w "\nHTTP %{http_code}\n"
