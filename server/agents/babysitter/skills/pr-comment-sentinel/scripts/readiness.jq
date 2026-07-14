def latest: sort_by(.at) | last;

def conventional_title:
  test("^(feat|fix|docs|refactor|perf|test|build|ci|chore|revert)(\\([^)]+\\))?!?: .+");

def is_quota($bot):
  .author == $bot
  and (.body // "" | test("usage limits?.*code reviews?|code-review usage limits?"; "i"));

. as $input
| ($input.head.sha) as $head
| ($input.head.committedAt) as $head_at
| ($input.viewer) as $viewer
| ($input.codexBot) as $bot
| (($input.codexRequest // null)
   | if . != null and .head == $head then
       { id: .commentId, at: .requestedAt, author: $viewer, body: "@codex review", head: .head }
     else null
     end) as $command
| ([
    ($input.reviews[]?
      | select(.author == $bot and .head == $head and ($command == null or .submittedAt > $command.at))
      | {
          kind: "review",
          id,
          at: .submittedAt,
          favorable: (.body // "" | test("no (major )?issues|no issues found"; "i"))
        }),
    ($input.reactions[]?
      | select($command != null and .commentId == $command.id and .author == $bot and .content == "+1" and .createdAt > $command.at)
      | { kind: "thumbs_up", id, at: .createdAt, favorable: true }),
    ($input.comments[]?
      | select($command != null and is_quota($bot) and .createdAt > $command.at)
      | { kind: "quota", id, at: .createdAt, favorable: false })
  ] | latest) as $terminal
| (($command != null)
   and ($terminal == null)
   and (($input.collection.finishedAt | fromdateiso8601) - ($command.at | fromdateiso8601) >= ($input.policy.codexTimeoutSeconds // 900))) as $command_timed_out
| (if $terminal.kind == "quota" or $command_timed_out then "unavailable"
   elif $terminal.kind == "review" or $terminal.kind == "thumbs_up" then "reviewed"
   elif $command != null then "pending"
   else "missing"
   end) as $lane
| (($input.fallback // null) as $fallback
   | ($fallback != null
      and $fallback.observable == true
      and $fallback.head == $head
      and ($command == null or $fallback.createdAt > $command.at)) as $fresh
   | {
       value: $fallback,
       fresh: $fresh,
       admissible: ($fresh and ($lane == "unavailable" or $lane == "missing"))
     }) as $fallback
| ([$input.checks[]? | (.bucket // "unknown" | ascii_downcase)]) as $buckets
| (if ($buckets | length) == 0 then "missing"
   elif any($buckets[]; . == "fail" or . == "cancel") then "failed"
   elif any($buckets[]; . == "pending") then "pending"
   elif all($buckets[]; . == "pass" or . == "skipping") then "passed"
   else "unknown"
   end) as $checks_state
| ([$input.threads[]? | select((.isResolved | not) and (.isOutdated | not))] | length) as $unresolved
| ($input.author == $viewer) as $authored
| ($input.expectedHead == $head and $input.collection.headAfter == $head) as $head_stable
| ($input.title | conventional_title) as $title_valid
| (($input.policy.notBefore // "") as $not_before
   | ($not_before == ""
      or (($input.createdAt | fromdateiso8601) >= ($not_before | fromdateiso8601))
      or (($head_at | fromdateiso8601) >= ($not_before | fromdateiso8601)))) as $eligible
| (if $terminal.favorable == true then
     { source: (if $terminal.kind == "thumbs_up" then "codex-thumbs-up" else "codex-review" end), verdict: "no-major-issues", at: $terminal.at, admissible: true }
   elif $terminal.kind == "review" then
     { source: "codex-review", verdict: "needs-fix", at: $terminal.at, admissible: false }
   elif $fallback.admissible then
     { source: "fallback", verdict: ($fallback.value.verdict // "inconclusive"), at: $fallback.value.createdAt, admissible: ($fallback.value.verdict == "no-major-issues") }
   else
     { source: "none", verdict: "none", at: null, admissible: false }
   end) as $review
| ([$input.checks[]? | select((.bucket // "unknown" | ascii_downcase) == "fail" or (.bucket // "unknown" | ascii_downcase) == "cancel") | .name]) as $failed_checks
| ([$input.checks[]?
    | select((.bucket // "unknown" | ascii_downcase) == "fail" or (.bucket // "unknown" | ascii_downcase) == "cancel")
    | {name, link: (.link // null), completedAt: (.completedAt // null), workflow: (.workflow // null)}]) as $failed_check_details
| ([$input.checks[]? | select((.bucket // "unknown" | ascii_downcase) == "pending") | .name]) as $pending_checks
| ([$input.threads[]? | select((.isResolved | not) and (.isOutdated | not)) | .id]) as $unresolved_ids
| ([
    if ($authored | not) then "not-authored" else empty end,
    if ($head_stable | not) then "head-changed" else empty end,
    if ($eligible | not) then "before-activation" else empty end,
    if ($title_valid | not) then "invalid-title" else empty end,
    if $unresolved > 0 then "unresolved-review-threads" else empty end,
    if ($input.mergeState == "DIRTY" or $input.mergeState == "BEHIND") then ("merge-state-" + ($input.mergeState | ascii_downcase))
    elif $input.policy.merge == "allowed" and $input.mergeState != "CLEAN" then ("merge-state-" + ($input.mergeState | ascii_downcase))
    elif $input.policy.merge == "disabled" and $input.mergeState != "CLEAN" and $input.mergeState != "BLOCKED" then ("merge-state-" + ($input.mergeState | ascii_downcase))
    else empty end,
    if $checks_state != "passed" then ("checks-" + $checks_state) else empty end,
    if ($review.admissible | not) then
      (if $review.verdict == "needs-fix" then "review-needs-fix"
       elif $review.verdict == "inconclusive" then "review-inconclusive"
       elif $lane == "pending" then "codex-review-pending"
       elif $lane == "unavailable" then "fallback-review-required"
       elif $lane == "missing" then "review-missing"
       else "review-not-favorable"
       end)
    else empty end
  ]) as $blockers
| (if ($authored | not) then "ignore"
   elif ($head_stable | not) then "head-changed"
   elif ($eligible | not) then "grandfathered"
   elif $unresolved > 0 then (if $input.policy.repair == "allowed" then "repair" else "wait-feedback" end)
   elif ($title_valid | not) then (if $input.policy.repair == "allowed" then "repair" else "wait-title" end)
   elif ($input.mergeState == "DIRTY" or $input.mergeState == "BEHIND") then (if $input.policy.repair == "allowed" then "repair" else "wait-merge-state" end)
   elif $checks_state == "failed" then (if $input.policy.repair == "allowed" then "repair" else "wait-checks" end)
   elif $review.verdict == "needs-fix" then (if $input.policy.repair == "allowed" then "repair" else "wait-review-findings" end)
   elif $review.verdict == "inconclusive" then "wait-review-inconclusive"
   elif $lane == "missing" and $input.policy.comments == "allowed" and ($review.admissible | not) then "request-review"
   elif $lane == "unavailable" and ($fallback.fresh | not) then "fallback-review"
   elif $checks_state != "passed" then "wait-checks"
   elif $lane == "pending" then "wait-review"
   elif ($review.admissible | not) and ($lane == "unavailable" or $lane == "missing") then "fallback-review"
   elif ($review.admissible | not) then "wait-review"
   elif $input.draft then "mark-ready"
   elif $input.policy.merge == "allowed" and $input.mergeState == "CLEAN" then "merge"
   elif $input.policy.merge == "allowed" then "wait-merge-state"
   elif $input.mergeState == "CLEAN" or $input.mergeState == "BLOCKED" then "ready-for-human-review"
   else "wait-merge-state"
   end) as $action
| {
    schema: 1,
    repository: $input.repository,
    number: $input.number,
    title: $input.title,
    head: $head,
    expectedHead: $input.expectedHead,
    observedAt: $input.collection.finishedAt,
    headStable: $head_stable,
    authored: $authored,
    viewer: $viewer,
    eligible: $eligible,
    draft: $input.draft,
    titleValid: $title_valid,
    mergeState: $input.mergeState,
    policy: $input.policy,
    checks: {
      state: $checks_state,
      total: ($buckets | length),
      failed: $failed_checks,
      failedDetails: $failed_check_details,
      pending: $pending_checks
    },
    reviewThreads: { unresolved: $unresolved, ids: $unresolved_ids },
    codexLane: {
      state: $lane,
      timedOut: $command_timed_out,
      command: $command,
      terminal: $terminal
    },
    fallback: {
      present: ($fallback.value != null),
      fresh: $fallback.fresh,
      admissible: $fallback.admissible,
      verdict: ($fallback.value.verdict // null),
      reason: ($fallback.value.reason // null),
      head: ($fallback.value.head // null),
      createdAt: ($fallback.value.createdAt // null),
      observable: ($fallback.value.observable // false)
    },
    reviewEvidence: $review,
    blockers: $blockers,
    ready: ($action == "merge" or $action == "ready-for-human-review"),
    action: $action
  }
