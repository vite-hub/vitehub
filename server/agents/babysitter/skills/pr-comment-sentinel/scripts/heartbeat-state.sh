#!/usr/bin/env bash
set -euo pipefail

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  cat <<'USAGE'
Usage: heartbeat-state.sh [gh:owner/repo ...]

Prints one readiness JSON object per open PR authored by the current GitHub user.
Defaults to gh:vite-hub/vitehub and gh:quiverdk/portal.

Environment:
  PR_COMMENT_SENTINEL_WORKSPACE     Worktree root. Default: /home/workspace
  PR_COMMENT_SENTINEL_MERGE_REPOS   Space/comma-separated owner/repo values allowed to merge
  PR_COMMENT_SENTINEL_REPAIR_REPOS  Space/comma-separated owner/repo values allowed to repair
  PR_COMMENT_SENTINEL_COMMENT_REPOS Space/comma-separated owner/repo values allowed one @codex review nudge
  PR_COMMENT_SENTINEL_FULL_QUEUE_REPOS
                                    Repositories that admit existing heads despite NOT_BEFORE
  PR_COMMENT_SENTINEL_NOT_BEFORE     Optional ISO timestamp; older PR heads are grandfathered
USAGE
  exit 0
fi

repos=("$@")
if [ "${#repos[@]}" -eq 0 ]; then
  repos=("gh:vite-hub/vitehub" "gh:quiverdk/portal")
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
workspace="${PR_COMMENT_SENTINEL_WORKSPACE:-/home/workspace}"
merge_repos="${PR_COMMENT_SENTINEL_MERGE_REPOS:-}"
repair_repos="${PR_COMMENT_SENTINEL_REPAIR_REPOS:-}"
comment_repos="${PR_COMMENT_SENTINEL_COMMENT_REPOS:-}"
full_queue_repos="${PR_COMMENT_SENTINEL_FULL_QUEUE_REPOS:-}"
not_before="${PR_COMMENT_SENTINEL_NOT_BEFORE:-}"
error_file="$(mktemp)"
trap 'rm -f "$error_file"' EXIT

contains_repo() {
  local haystack="${1//,/ }"
  local needle="$2"
  local item
  for item in $haystack; do
    [ "${item#gh:}" = "$needle" ] && return 0
  done
  return 1
}

for repo_arg in "${repos[@]}"; do
  repo="${repo_arg#gh:}"
  merge_policy="disabled"
  repair_policy="disabled"
  comment_policy="disabled"
  contains_repo "$merge_repos" "$repo" && merge_policy="allowed"
  contains_repo "$repair_repos" "$repo" && repair_policy="allowed"
  contains_repo "$comment_repos" "$repo" && comment_policy="allowed"
  repo_not_before="$not_before"
  contains_repo "$full_queue_repos" "$repo" && repo_not_before=""
  repo_dir="${repo//\//-}"

  if ! pr_rows="$(
    gh pr list \
      --repo "$repo" \
      --author @me \
      --state open \
      --limit 100 \
      --json number,headRefOid \
      --jq '.[] | [.number, .headRefOid] | @tsv'
  )"; then
    jq -cn --arg repository "$repo" \
      '{repository:$repository, action:"observation-failed", blocker:"pr-list-failed"}' >&2
    continue
  fi

  while IFS=$'\t' read -r pr head; do
    [ -n "$pr" ] || continue
    worktree="$workspace/pr-comment-sentinel/$repo_dir/pr-$pr-$head"
    request_state="$workspace/pr-comment-sentinel-state/$repo_dir/pr-$pr-$head/codex-request.json"
    review_state="$workspace/pr-comment-sentinel-state/$repo_dir/pr-$pr-$head/review/result.json"
    fallback=""
    if [ -f "$review_state" ]; then
      fallback="$review_state"
    elif [ -f "$worktree/.pr-comment-sentinel-review.json" ]; then
      fallback="$worktree/.pr-comment-sentinel-review.json"
    elif [ -f "$worktree/.pr-comment-sentinel-review.status" ]; then
      fallback="$worktree/.pr-comment-sentinel-review.status"
    fi

    args=(
      --expected-head "$head"
      --merge "$merge_policy"
      --repair "$repair_policy"
      --comments "$comment_policy"
    )
    args+=(--not-before "$repo_not_before")
    [ ! -f "$request_state" ] || args+=(--codex-request "$request_state")
    [ -z "$fallback" ] || args+=(--fallback "$fallback")
    if snapshot="$($script_dir/pr-readiness.sh "${args[@]}" "$repo" "$pr" 2> "$error_file")"; then
      printf '%s\n' "$snapshot"
    else
      rc=$?
      error="$(cat "$error_file")"
      jq -cn \
        --arg repository "$repo" \
        --argjson number "$pr" \
        --arg head "$head" \
        --arg merge "$merge_policy" \
        --arg repair "$repair_policy" \
        --arg comments "$comment_policy" \
        --arg error "$error" \
        --argjson exitCode "$rc" \
        '{
          schema:1,
          repository:$repository,
          number:$number,
          head:$head,
          action:"wait-observation",
          blockers:["snapshot-failed"],
          policy:{merge:$merge, repair:$repair, comments:$comments},
          observation:{exitCode:$exitCode, error:$error}
        }'
    fi
  done <<< "$pr_rows"
done
