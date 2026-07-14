#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 4 ]; then
  echo "usage: request-review.sh owner/repo pr-number head viewer" >&2
  exit 64
fi

repo="$1"
pr="$2"
head="$3"
viewer="$4"
workspace="${PR_COMMENT_SENTINEL_WORKSPACE:-/home/workspace}"
repo_dir="${repo//\//-}"
state_base="$workspace/pr-comment-sentinel-state/$repo_dir"
reconcile_seconds="${PR_COMMENT_SENTINEL_REQUEST_RECONCILE_SECONDS:-120}"

[[ "$reconcile_seconds" =~ ^[0-9]+$ ]] || { echo "invalid request reconcile interval" >&2; exit 64; }

write_marker() {
  local target_head="$1"
  local comment_id="$2"
  local requested_at="$3"
  local state_dir="$state_base/pr-$pr-$target_head"
  local tmp
  mkdir -p "$state_dir"
  tmp="$(mktemp "$state_dir/.codex-request.XXXXXX")"
  jq -n \
    --arg repository "$repo" \
    --argjson number "$pr" \
    --arg head "$target_head" \
    --arg author "$viewer" \
    --argjson commentId "$comment_id" \
    --arg requestedAt "$requested_at" \
    '{schema:1, phase:"posted", repository:$repository, number:$number, head:$head, author:$author, commentId:$commentId, requestedAt:$requestedAt}' \
    > "$tmp"
  mv "$tmp" "$state_dir/codex-request.json"
  printf '%s\n' "$state_dir/codex-request.json"
}

now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
mkdir -p "$state_base"

for intent in "$state_base"/pr-"$pr"-*/codex-request.json; do
  [ -f "$intent" ] || continue
  jq -e \
    --arg repository "$repo" \
    --argjson number "$pr" \
    '.schema == 1
     and .phase == "intent"
     and .repository == $repository
     and .number == $number
     and (.head | type == "string")
     and (.author | type == "string")
     and (.attemptedAt | type == "string")
     and (.attemptedAt | fromdateiso8601 | type == "number")' \
    "$intent" >/dev/null 2>&1 || continue

  attempted_at="$(jq -r .attemptedAt "$intent")"
  if ! comments="$(gh api --paginate "repos/$repo/issues/$pr/comments?since=$attempted_at" 2>/dev/null)"; then
    jq -cn '{status:"reconciling", blocker:"review-request-reconcile-failed"}'
    exit 0
  fi
  recovered="$(
    jq -sc \
      --arg viewer "$viewer" \
      --arg attemptedAt "$attempted_at" \
      'add
       | [.[] | select(.user.login == $viewer and .body == "@codex review" and .created_at >= $attemptedAt)]
       | sort_by(.created_at)
       | first // empty' \
      <<< "$comments"
  )"
  if [ -n "$recovered" ]; then
    intent_head="$(jq -r .head "$intent")"
    marker="$(write_marker "$intent_head" "$(jq -r .id <<< "$recovered")" "$(jq -r .created_at <<< "$recovered")")"
    [ "$marker" = "$intent" ] || rm -f "$intent"
    jq -cn --arg head "$intent_head" '{status:"recovered", head:$head}'
    exit 0
  fi

  age="$(jq -nr --arg now "$now" --arg attemptedAt "$attempted_at" '($now | fromdateiso8601) - ($attemptedAt | fromdateiso8601)')"
  if [ "$age" -lt "$reconcile_seconds" ]; then
    jq -cn --arg head "$(jq -r .head "$intent")" '{status:"reconciling", head:$head}'
    exit 0
  fi
  rm -f "$intent"
done

state_dir="$state_base/pr-$pr-$head"
intent="$state_dir/codex-request.json"
mkdir -p "$state_dir"
intent_tmp="$(mktemp "$state_dir/.codex-request.XXXXXX")"
jq -n \
  --arg repository "$repo" \
  --argjson number "$pr" \
  --arg head "$head" \
  --arg author "$viewer" \
  --arg attemptedAt "$now" \
  '{schema:1, phase:"intent", repository:$repository, number:$number, head:$head, author:$author, attemptedAt:$attemptedAt}' \
  > "$intent_tmp"
mv "$intent_tmp" "$intent"

if ! response="$(gh api --method POST "repos/$repo/issues/$pr/comments" -f body='@codex review')"; then
  jq -cn '{status:"failed", blocker:"review-request-command-failed"}'
  exit 0
fi

if ! jq -e '
  (.id | type == "number")
  and (.created_at | type == "string")
  and (.created_at | fromdateiso8601 | type == "number")
' <<< "$response" >/dev/null; then
  jq -cn '{status:"failed", blocker:"review-request-invalid-response"}'
  exit 0
fi

if ! head_after="$(gh pr view "$pr" --repo "$repo" --json headRefOid --jq .headRefOid)"; then
  jq -cn '{status:"failed", blocker:"review-request-head-check-failed"}'
  exit 0
fi

marker="$(write_marker "$head" "$(jq -r .id <<< "$response")" "$(jq -r .created_at <<< "$response")")"
[ "$marker" = "$intent" ] || rm -f "$intent"

if [ "$head_after" = "$head" ]; then
  jq -cn --arg head "$head_after" '{status:"requested", head:$head}'
else
  jq -cn --arg head "$head_after" '{status:"requested-head-changed", head:$head}'
fi
