#!/usr/bin/env bash
# Seeds examples/library-host/seed.jsonl into a running Agent Viewer server as one events batch (issue #260).
#
# `agent-viewer send` cannot send `llm.usage`/`llm.failed` (it only takes --agent/--status/--message), so this
# script posts the batch endpoint directly with curl. It takes the server's token as its first argument,
# deliberately not from an environment variable named after it: this file is not the proxy, so it stays out of
# the "only proxy.ts and its README reference the token variable" rule (see proxy.ts and README.md), and the
# token still never appears in this file's own source.
set -euo pipefail

TOKEN="${1:?Usage: seed.sh <server-token> [baseUrl]}"
BASE_URL="${2:-http://127.0.0.1:8787}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"

BODY="$(node -e '
  const fs = require("node:fs");
  const lines = fs.readFileSync(process.argv[1], "utf8").split("\n").map((line) => line.trim()).filter(Boolean);
  const events = lines.map((line) => JSON.parse(line));
  process.stdout.write(JSON.stringify({ events }));
' "$SCRIPT_DIR/seed.jsonl")"

curl --fail-with-body -sS -X POST "$BASE_URL/api/v1/events/batch" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "$BODY"
echo
