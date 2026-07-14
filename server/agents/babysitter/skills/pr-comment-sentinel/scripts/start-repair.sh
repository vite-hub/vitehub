#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: start-repair.sh owner/repo pr-number head < snapshot.json" >&2
  exit 64
fi

repo="${1#gh:}"
pr="$2"
head="$3"
snapshot="$(cat)"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/process-owner.sh"
workspace="${PR_COMMENT_SENTINEL_WORKSPACE:-/home/workspace}"
repo_dir="${repo//\//-}"
worktree="$workspace/pr-comment-sentinel/$repo_dir/pr-$pr-$head"
state_root="$workspace/pr-comment-sentinel-state/$repo_dir/pr-$pr-$head"

jq -e --arg repo "$repo" --argjson pr "$pr" --arg head "$head" \
  '.repository == $repo and .number == $pr and .head == $head and .action == "repair"' \
  <<< "$snapshot" >/dev/null

fingerprint="$(
  jq -c '{head, action, titleValid, mergeState, checks: .checks.failedDetails, threads: .reviewThreads.ids, review: .reviewEvidence, fallback: {createdAt: .fallback.createdAt, reason: .fallback.reason}}' \
    <<< "$snapshot" \
  | if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi \
  | awk '{print substr($1, 1, 16)}'
)"
control="$state_root/repair-$fingerprint"
pid_file="$control/pid"
prompt="$control/prompt.md"
schema="$control/schema.json"
output="$control/output.json"
status="$control/result.json"
error="$control/error"
snapshot_file="$control/snapshot.json"
mkdir -p "$control"

if [ -f "$status" ]; then
  jq -cn --arg worktree "$worktree" --arg control "$control" --arg fingerprint "$fingerprint" --slurpfile result "$status" \
    '{status:"completed", fingerprint:$fingerprint, worktree:$worktree, control:$control, result:$result[0]}'
  exit
fi

for candidate in "$state_root"/repair-*/pid; do
  [ -s "$candidate" ] || continue
  candidate_control="$(dirname "$candidate")"
  if running_pid="$(process_for_path "$candidate_control")"; then
    jq -cn --argjson pid "$running_pid" --arg worktree "$worktree" --arg control "$candidate_control" \
      '{status:"running", pid:$pid, worktree:$worktree, control:$control}'
    exit
  fi
done

review_pid="$state_root/review/pid"
legacy_review_pid="$worktree/.pr-comment-sentinel-review.pid"
if [ -s "$review_pid" ] && running_pid="$(process_for_path "$state_root/review")"; then
  jq -cn --argjson pid "$running_pid" --arg worktree "$worktree" \
    '{status:"waiting-review", pid:$pid, worktree:$worktree}'
  exit
elif [ -s "$legacy_review_pid" ] && pid_owns_path "$(cat "$legacy_review_pid")" "$worktree"; then
  jq -cn --argjson pid "$(cat "$legacy_review_pid")" --arg worktree "$worktree" \
    '{status:"waiting-review", pid:$pid, worktree:$worktree}'
  exit
fi

if [ -f "$error" ]; then
  error_epoch="$(stat -c %Y "$error" 2>/dev/null || stat -f %m "$error")"
  retry_seconds="${PR_COMMENT_SENTINEL_RETRY_SECONDS:-900}"
  retry_in="$((error_epoch + retry_seconds - $(date +%s)))"
  if [ "$retry_in" -gt 0 ]; then
    jq -cn --arg error "$error" --argjson retryInSeconds "$retry_in" --arg worktree "$worktree" \
      '{status:"failed", error:$error, retryInSeconds:$retryInSeconds, worktree:$worktree}'
    exit
  fi
fi

pr_json="$(gh pr view "$pr" --repo "$repo" --json baseRefOid,headRefName,headRefOid,title,url)"
observed_head="$(jq -r .headRefOid <<< "$pr_json")"
if [ "$observed_head" != "$head" ]; then
  jq -cn --arg expected "$head" --arg observed "$observed_head" \
    '{status:"head-changed", expected:$expected, observed:$observed}'
  exit
fi

base="$(jq -r .baseRefOid <<< "$pr_json")"
branch="$(jq -r .headRefName <<< "$pr_json")"
title="$(jq -r .title <<< "$pr_json")"
url="$(jq -r .url <<< "$pr_json")"

if [ ! -e "$worktree/.git" ]; then
  mkdir -p "$(dirname "$worktree")"
  gh repo clone "$repo" "$worktree" -- --filter=blob:none --no-checkout >/dev/null
  git -C "$worktree" fetch --quiet origin "$base" "$head"
  git -C "$worktree" checkout --quiet --detach "$head"
fi

git -C "$worktree" cat-file -e "$base^{commit}" 2>/dev/null \
  || git -C "$worktree" fetch --quiet origin "$base"
git_common_dir="$(git -C "$worktree" rev-parse --path-format=absolute --git-common-dir)"
exclude="$git_common_dir/info/exclude"
mkdir -p "$(dirname "$exclude")"
grep -qxF '/.pr-comment-sentinel-*' "$exclude" 2>/dev/null \
  || printf '%s\n' '/.pr-comment-sentinel-*' >> "$exclude"
actual_head="$(git -C "$worktree" rev-parse HEAD)"
if [ "$actual_head" != "$head" ]; then
  repair_state_present=false
  for prior_control in "$state_root"/repair-*; do
    if [ -f "$prior_control/error" ] || [ -f "$prior_control/pid" ] || [ -f "$prior_control/prompt.md" ]; then
      repair_state_present=true
      break
    fi
  done
  if ! git -C "$worktree" merge-base --is-ancestor "$head" "$actual_head" \
    || [ "$repair_state_present" != true ]; then
    echo "repair checkout is at $actual_head, expected $head or an orphaned descendant: $worktree" >&2
    exit 1
  fi
fi

printf '%s\n' "$snapshot" > "$snapshot_file"
jq -n '{
  type: "object",
  additionalProperties: false,
  required: ["status", "reason", "checks"],
  properties: {
    status: {type: "string", enum: ["pushed", "rerun", "resolved", "blocked"]},
    reason: {type: "string", minLength: 1, maxLength: 2000},
    checks: {type: "array", items: {type: "string"}}
  }
}' > "$schema"

printf '%s\n' \
  "Converge $url at authorized head $head toward merge readiness." \
  "Repository: $repo" \
  "PR: $pr" \
  "PR title: $title" \
  "PR branch: $branch" \
  "Read /home/workspace/onmax/skills/skills/pr-refiner/SKILL.md before acting." \
  "Read repository instructions and inspect the complete PR intent and base-to-head diff." \
  "Use $snapshot_file as the triggering snapshot, then re-read the live head, unresolved review threads, reviews, and every failed or cancelled check with its logs." \
  "When the triggering review evidence is a fallback finding, treat its recorded reason as a candidate finding and validate it against the exact diff before editing." \
  "Own every actionable blocker on this PR head in one bounded pass: address valid review feedback, repair code or branch failures with the smallest patch, correct blocking PR metadata such as a non-conventional title, run focused checks, push to the existing PR branch, and resolve only the threads the pushed change actually addresses." \
  "For a transient external CI failure, inspect the run attempt. If attempt 1 failed for infrastructure rather than code, rerun only the failed jobs once and stop without editing. Never create a rerun loop." \
  "If the live PR head differs from $head, stop as blocked without changing anything." \
  "Post no PR or issue comments. Do not merge, close, approve, or change draft state. Do not force-push." \
  "Return only the JSON required by the output schema. Use pushed after a verified branch push, rerun after submitting one bounded failed-job rerun, resolved after a metadata or thread-only repair, and blocked only with the exact remaining blocker." \
  > "$prompt"

setsid "$script_dir/repair-runner.sh" \
  "$worktree" "$repo" "$pr" "$head" "$control" "$prompt" "$schema" "$output" \
  </dev/null >/dev/null 2>&1 &
pid=$!
printf '%s\n' "$pid" > "$pid_file"

kill -0 "$pid"
jq -cn \
  --argjson pid "$pid" \
  --arg worktree "$worktree" \
  --arg control "$control" \
  --arg fingerprint "$fingerprint" \
  --arg model "${PR_COMMENT_SENTINEL_MODEL:-gpt-5.6-sol}" \
  --arg effort "${PR_COMMENT_SENTINEL_REASONING_EFFORT:-high}" \
  '{status:"started", pid:$pid, worktree:$worktree, control:$control, fingerprint:$fingerprint, model:$model, reasoningEffort:$effort}'
