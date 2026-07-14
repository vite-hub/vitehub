---
name: pr-comment-sentinel
description: Converges authored pull requests by repairing actionable review feedback, failed checks, and branch blockers; substitutes exact-head Sol review when Codex is unavailable; and applies repository-specific ready or merge gates. Use for an autonomous PR heartbeat or review-fix loop.
---

# PR Comment Sentinel

The heartbeat is a convergence loop. Scripts own observation and final gates; one exact-head agent owns each review or repair lane.

## Heartbeat

Run one pass and exit:

```sh
PR_COMMENT_SENTINEL_REPAIR_REPOS='vite-hub/vitehub quiverdk/portal' \
PR_COMMENT_SENTINEL_MERGE_REPOS=vite-hub/vitehub \
PR_COMMENT_SENTINEL_COMMENT_REPOS='vite-hub/vitehub quiverdk/portal' \
PR_COMMENT_SENTINEL_FULL_QUEUE_REPOS=vite-hub/vitehub \
PR_COMMENT_SENTINEL_NOT_BEFORE=2026-07-10T06:00:00Z \
PR_COMMENT_SENTINEL_MAX_OWNERS=2 \
  scripts/run-heartbeat.sh gh:vite-hub/vitehub gh:quiverdk/portal
```

The timer supplies the next pass. A pass starts or reuses owners, records one ledger row per PR, and exits without polling.

## Actions

| Action | Response |
| --- | --- |
| `repair` | Reuse or start one write-capable owner for every actionable blocker on the exact head. |
| `request-review` | Re-snapshot, then post one exact `@codex review` command for the head. |
| `fallback-review` | Reuse or start one detached read-only reviewer for the exact head. |
| `mark-ready` | Re-snapshot, then mark ready only if the action is unchanged. |
| `merge` | Re-snapshot, then squash-merge only if the action and head are unchanged. |
| `ready-for-human-review` | Report ready; perform no merge. |
| `grandfathered`, `wait-*`, `head-changed`, `ignore` | Report the blocker; perform no mutation. |

## Invariants

- `pr-readiness.sh` is the single readiness authority and uses every visible check and current review thread.
- Repair and merge are independent permissions. Portal may repair but never inherits ViteHub merge permission.
- Comment permission authorizes only one exact `@codex review` command per head; a recoverable outbox binds its comment ID and reactions to that head, and all other PR chatter remains disabled.
- Full-queue permission admits existing heads for repositories owned through merge, while the activation boundary can still grandfather human-merge backlogs.
- Quota replies make the Codex lane unavailable, not permanently pending.
- A Codex command with no terminal signal for 15 minutes enters the same fallback lane.
- An activation boundary may grandfather existing PR heads while admitting new PRs and later commits.
- Fallback evidence must be observable, newer than the latest review command, and match the exact head.
- Failed workers cool down for 15 minutes before retrying, preventing two-minute failure storms.
- The queue runs at most two live owners by default; later PRs stay deferred until capacity opens.
- Owner liveness requires an exact PR state path in the process command; a reusable PID alone is not evidence.
- Repair owners may edit, test, push, rerun one first-attempt infrastructure failure, and resolve addressed threads. They never comment or merge.
- Review owners are read-only. Only the heartbeat may change draft state or perform the freshly gated merge action.
- Merge permission is repository-specific and every merge gets an immediate fresh snapshot plus `--match-head-commit`.
- One live owner may use an exact-head worktree; an orphaned exact-head repair resumes in place.
- A systemd heartbeat uses `KillMode=process` so detached owners survive the oneshot process.

## Fallback Model

Review and repair owners default to `gpt-5.6-sol` with `high` reasoning. Override with `PR_COMMENT_SENTINEL_MODEL` and `PR_COMMENT_SENTINEL_REASONING_EFFORT`.
