#!/bin/bash
# Deploy OpsHub worker to Cloudflare

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/opshub"

if ! command -v wrangler &> /dev/null; then
  echo "Installing wrangler..."
  npm install -g wrangler
fi

echo "Deploying OpsHub worker..."
exec npx wrangler deploy --config wrangler.jsonc "$@"
