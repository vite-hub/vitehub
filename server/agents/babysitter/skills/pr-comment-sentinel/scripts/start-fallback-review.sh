#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: start-fallback-review.sh owner/repo pr-number head" >&2
  exit 64
fi

repo="${1#gh:}"
pr="$2"
head="$3"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/process-owner.sh"
workspace="${PR_COMMENT_SENTINEL_WORKSPACE:-/home/workspace}"
repo_dir="${repo//\//-}"
worktree="$workspace/pr-comment-sentinel/$repo_dir/pr-$pr-$head"
state_root="$workspace/pr-comment-sentinel-state/$repo_dir/pr-$pr-$head"
control="$state_root/review"
pid_file="$control/pid"
prompt="$control/prompt.md"
schema="$control/schema.json"
output="$control/output.json"
error="$control/error"
repair_state="$state_root"
mkdir -p "$control"

for repair_pid in "$repair_state"/repair-*/pid; do
  [ -s "$repair_pid" ] || continue
  repair_control="$(dirname "$repair_pid")"
  if running_pid="$(process_for_path "$repair_control")"; then
    jq -cn \
      --argjson pid "$running_pid" \
      --arg worktree "$worktree" \
      '{status:"waiting-repair", pid:$pid, worktree:$worktree}'
    exit
  fi
done

if [ -s "$pid_file" ] && running_pid="$(process_for_path "$control")"; then
  jq -cn \
    --argjson pid "$running_pid" \
    --arg worktree "$worktree" \
    '{status:"running", pid:$pid, worktree:$worktree}'
  exit
fi

if [ -f "$error" ]; then
  error_epoch="$(stat -c %Y "$error" 2>/dev/null || stat -f %m "$error")"
  retry_seconds="${PR_COMMENT_SENTINEL_RETRY_SECONDS:-900}"
  retry_in="$((error_epoch + retry_seconds - $(date +%s)))"
  if [ "$retry_in" -gt 0 ]; then
    jq -cn \
      --arg error "$error" \
      --argjson retryInSeconds "$retry_in" \
      --arg worktree "$worktree" \
      '{status:"failed", error:$error, retryInSeconds:$retryInSeconds, worktree:$worktree}'
    exit
  fi
fi

pr_json="$(gh pr view "$pr" --repo "$repo" --json baseRefOid,headRefOid,title,url)"
observed_head="$(jq -r .headRefOid <<< "$pr_json")"
[ "$observed_head" = "$head" ] || {
  jq -cn --arg expected "$head" --arg observed "$observed_head" \
    '{status:"head-changed", expected:$expected, observed:$observed}'
  exit 2
}
base="$(jq -r .baseRefOid <<< "$pr_json")"
title="$(jq -r .title <<< "$pr_json")"
url="$(jq -r .url <<< "$pr_json")"

if [ ! -e "$worktree/.git" ]; then
  mkdir -p "$(dirname "$worktree")"
  gh repo clone "$repo" "$worktree" -- --filter=blob:none --no-checkout >/dev/null
  git -C "$worktree" fetch --quiet origin "$base" "$head"
  git -C "$worktree" checkout --quiet --detach "$head"
fi

actual_head="$(git -C "$worktree" rev-parse HEAD)"
[ "$actual_head" = "$head" ] || {
  echo "existing checkout is at $actual_head, expected $head: $worktree" >&2
  exit 1
}

if git -C "$worktree" status --porcelain --untracked-files=all \
  | sed -E 's/^...//' \
  | grep -Ev '^\.pr-comment-sentinel-' \
  | grep -q .; then
  echo "source checkout is dirty: $worktree" >&2
  exit 1
fi

git -C "$worktree" cat-file -e "$base^{commit}" 2>/dev/null \
  || git -C "$worktree" fetch --quiet origin "$base"

jq -n '{
  type: "object",
  additionalProperties: false,
  required: ["verdict", "reason"],
  properties: {
    verdict: {type: "string", enum: ["no-major-issues", "needs-fix", "inconclusive"]},
    reason: {type: "string", minLength: 1, maxLength: 2000}
  }
}' > "$schema"

printf '%s\n' \
  "Review $url at exact head $head against base $base." \
  "PR title: $title" \
  "Inspect the complete base-to-head diff for correctness, regressions, security, missing tests, and mismatch with the PR intent." \
  "Run useful read-only checks when dependencies are already available. Do not install dependencies." \
  "Do not edit files, post comments, push, resolve threads, change PR state, or merge." \
  "Return only the JSON object required by the output schema. Use no-major-issues only when there is no material merge blocker; otherwise use needs-fix or inconclusive and explain why." \
  > "$prompt"

setsid "$script_dir/fallback-review-runner.sh" \
  "$worktree" "$head" "$control" "$prompt" "$schema" "$output" </dev/null >/dev/null 2>&1 &
pid=$!
printf '%s\n' "$pid" > "$pid_file"

kill -0 "$pid"
jq -cn \
    --argjson pid "$pid" \
    --arg worktree "$worktree" \
    --arg control "$control" \
  --arg model "${PR_COMMENT_SENTINEL_MODEL:-gpt-5.6-sol}" \
  --arg effort "${PR_COMMENT_SENTINEL_REASONING_EFFORT:-high}" \
  '{status:"started", pid:$pid, worktree:$worktree, control:$control, model:$model, reasoningEffort:$effort}'
