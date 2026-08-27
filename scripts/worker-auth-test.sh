#!/usr/bin/env bash
# Substrate AUTH_OK test (Phase 0 gate).
# Usage: CLAUDE_CODE_OAUTH_TOKEN=<token> ./scripts/worker-auth-test.sh
set -euo pipefail

if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  echo "No token. Set CLAUDE_CODE_OAUTH_TOKEN." >&2
  exit 2
fi

cd "$(dirname "$0")/.."
exec docker compose --profile tools run --rm \
  -e "CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_CODE_OAUTH_TOKEN}" worker
