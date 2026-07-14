#!/usr/bin/env bash
set -euo pipefail

[ "$#" -eq 8 ] || exit 64

worktree="$1"
repo="$2"
pr="$3"
authorized_head="$4"
control="$5"
prompt="$6"
schema="$7"
output="$8"
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
  --dangerously-bypass-approvals-and-sandbox \
  --model "$model" \
  --config "model_reasoning_effort=\"$effort\"" \
  --cd "$worktree" \
  --output-schema "$schema" \
  --output-last-message "$output" \
  - < "$prompt" > "$log" 2>&1
rc=$?
set -e

if [ "$rc" -ne 0 ] || ! jq -e '
  (.status == "pushed" or .status == "rerun" or .status == "resolved" or .status == "blocked")
  and (.reason | type == "string" and length > 0)
  and (.checks | type == "array")
' "$output" >/dev/null 2>&1; then
  printf 'worker failed with exit %s; see %s\n' "$rc" "$log" > "$error"
  exit 1
fi

observed_head="$(gh pr view "$pr" --repo "$repo" --json headRefOid --jq .headRefOid)"
result_status="$(jq -r .status "$output")"
if [ "$result_status" = "pushed" ] && [ "$observed_head" = "$authorized_head" ]; then
  printf 'worker reported pushed but PR head did not change; see %s\n' "$log" > "$error"
  exit 1
fi

jq -n \
  --arg authorizedHead "$authorized_head" \
  --arg head "$observed_head" \
  --arg completedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg model "$model" \
  --arg effort "$effort" \
  --slurpfile result "$output" \
  '{
    schema: 1,
    status: $result[0].status,
    authorizedHead: $authorizedHead,
    head: $head,
    completedAt: $completedAt,
    reason: $result[0].reason,
    checks: $result[0].checks,
    model: $model,
    reasoningEffort: $effort
  }' > "$tmp_status"

mv "$tmp_status" "$status"
