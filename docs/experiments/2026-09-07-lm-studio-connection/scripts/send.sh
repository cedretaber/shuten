#!/usr/bin/env bash
# 要求 JSON を送り、finish_reason・usage・content・reasoning の長さを表示する。
#   LM_STUDIO_URL=http://<host>:1234 ./send.sh <request.json> [response.json]
set -u
REQ="${1:?request json}"; OUT="${2:-/dev/stdout}"
URL="${LM_STUDIO_URL:-http://127.0.0.1:1234}/v1/chat/completions"
TMP=$(mktemp)
curl -s -m 900 -X POST "$URL" -H "Content-Type: application/json" -d @"$REQ" -o "$TMP" -w "http=%{http_code} time=%{time_total}s\n"
python3 - "$TMP" <<'PY'
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
if "error" in d: print("error:", d["error"]); sys.exit(0)
c = d["choices"][0]; m = c["message"]
print("finish_reason:", c["finish_reason"]); print("usage:", d.get("usage"))
print("reasoning chars:", len(m.get("reasoning_content") or ""))
print("content:", m.get("content"))
PY
[ "$OUT" != /dev/stdout ] && cp "$TMP" "$OUT"; rm -f "$TMP"
