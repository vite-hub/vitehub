#!/usr/bin/env bash
set -euo pipefail

[ "$#" -eq 6 ] || exit 64

worktree="$1"
head="$2"
control="$3"
prompt="$4"
schema="$5"
output="$6"
log="$control/worker.log"
status="$control/result.json"
tmp_status="$control/result.json.tmp"
error="$control/error"
model="${PR_COMMENT_SENTINEL_MODEL:-gpt-5.6-sol}"
effort="${PR_COMMENT_SENTINEL_REASONING_EFFORT:-high}"

rm -f "$output" "$tmp_status" "$error"

set +e
codex exec \
  --ephemeral \
  --sandbox read-only \
  --model "$model" \
  --config "model_reasoning_effort=\"$effort\"" \
  --cd "$worktree" \
  --output-schema "$schema" \
  --output-last-message "$output" \
  - < "$prompt" > "$log" 2>&1
rc=$?
set -e

if [ "$rc" -ne 0 ] || ! jq -e \
  '.verdict == "no-major-issues" or .verdict == "needs-fix" or .verdict == "inconclusive"' \
  "$output" >/dev/null 2>&1; then
  printf 'worker failed with exit %s; see %s\n' "$rc" "$log" > "$error"
  exit 1
fi

jq -n \
  --arg head "$head" \
  --arg reviewedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg model "$model" \
  --arg effort "$effort" \
  --slurpfile result "$output" \
  '{
    schema: 1,
    verdict: $result[0].verdict,
    head: $head,
    reviewedAt: $reviewedAt,
    reason: $result[0].reason,
    model: $model,
    reasoningEffort: $effort
  }' > "$tmp_status"

mv "$tmp_status" "$status"
