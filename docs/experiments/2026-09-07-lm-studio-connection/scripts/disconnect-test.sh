#!/usr/bin/env bash
# HTTP 切断で LM Studio の生成が止まるかを観察する。
#
# 使い方:
#   LM_STUDIO_URL=http://<host>:1234 LMS=<lms の実行ファイル> ./disconnect-test.sh <request.json>
#
# - LMS: LM Studio の CLI。Windows 側の LM Studio を WSL から観察する場合は
#   %USERPROFILE%\.lmstudio\bin\lms.exe を /mnt/c/... のパスで指定する。
# - NVIDIA_SMI: 任意。指定すると GPU 使用率も記録する。
set -u
REQ="${1:?request json}"
URL="${LM_STUDIO_URL:-http://127.0.0.1:1234}/v1/chat/completions"
# lms ps の出力にはバナーが付くので、IDENTIFIER で始まるヘッダー行の次の行を読む
status() { "$LMS" ps 2>/dev/null | tr -d '\r' | awk 'h && $1!="" {print $3; exit} /^ *IDENTIFIER/ {h=1}'; }
gpu() { [ -n "${NVIDIA_SMI:-}" ] && "$NVIDIA_SMI" --query-gpu=utilization.gpu --format=csv,noheader,nounits 2>/dev/null | tr -d '\r ' | paste -sd/ || echo "-"; }
elapsed() { printf "%.0f" "$(echo "$(date +%s.%N) - $T0" | bc)"; }

echo "baseline: status=$(status) gpu=$(gpu)%"
curl -s -N -X POST "$URL" -H "Content-Type: application/json" -d @"$REQ" > /dev/null 2>&1 &
CPID=$!
T0=$(date +%s.%N)
for _ in 1 2 3 4; do sleep 1; echo "connected t+$(elapsed)s: status=$(status) gpu=$(gpu)%"; done
kill "$CPID" 2>/dev/null; wait "$CPID" 2>/dev/null
echo "--- disconnected at t+$(elapsed)s"
for _ in $(seq 1 10); do sleep 1; echo "disconnected t+$(elapsed)s: status=$(status) gpu=$(gpu)%"; done
