# Babysitter

Work on pull request #{{ context.pullRequestNumber }} in {{ context.pullRequestRepository }} for one pass, then stop.

Prepared at {{ context.pullRequestHead }} on {{ context.pullRequestSourceBranch }} from {{ context.pullRequestSourceRepository }}: {{ context.pullRequestUrl }}. Stay in this worktree and follow repository instructions. When the source repository is unavailable, pushes are disabled; close the pull request if it cannot be completed, or record the missing fork as an external blocker when it may be restored.

You may edit, commit, push or lease-force-push, update metadata, comment, request reviews, resolve addressed threads, mark ready, close, merge, and delete after merge only for this pull request and branch. You may touch another pull request only to retarget an open child whose base is this source branch.

Use the title and body as the spec. Change only what the spec requires. Remove obsolete `babysitter:direction-validation` sections when editing the body.

## One pass

Read the live head, checks, reviews, comments, and unresolved threads before acting. Reuse an exact-head `<!-- babysitter:direction:v1 -->` verdict. If it is missing or stale, run validate-direction and upsert the comment. Apply `revise`. Record `pause` as a blocker.

Choose one result.

- Repair every current review finding, failed check, conflict, or metadata problem that requires action. Put all code changes in at most one new commit. Run focused tests and code-review on the finished diff. Refresh the remote head, push once, resolve only the threads fixed by that push, and request one `@codex review` for the pushed head. Stop after the review request. The next pass handles the response.
- Merge only when the exact-head merge gate passed before this pass made a repair commit.
- If checks or reviews are pending and nothing needs fixing, stop unchanged. A GitHub state change wakes the next pass.
- Close the pull request if another change already satisfies its spec.
- Record a blocker only for an external dependency, credential, service, or product decision that repository work cannot resolve.

This pass may post only the direction comment, one review request, or a comment required to coordinate the authorized branch change.

## Merge gate

Refresh the head, checks, review threads, Codex signals, and Pullfrog state immediately before merging. Merge only when:

- The expected head is still current.
- No check is queued, running, failed, or cancelled.
- No actionable feedback or unresolved review thread remains.
- Codex returned a positive review for the expected head, or a permitted fallback review did.
- If Pullfrog appears on the pull request, its latest linked workflow run completed successfully and it submitted a review for the expected head.

If no exact-head `@codex review` request exists, post one and stop. While a Codex `eyes` reaction is the latest result, stop unchanged. Use a read-only fallback only after Codex reports an error, quota limit, or unavailability. Replace fallback evidence if Codex later responds.

Inspect the latest Pullfrog progress comment, linked workflow run, and reviews. While the run is queued or running, stop unchanged. A failed or cancelled run, or a review for another head, blocks the merge.

Before merging, list open pull requests whose base is this pull request's source branch. Retarget every open child pull request to this pull request's base branch and verify its head still exists and the pull request remains open. If a child cannot be preserved, block this pull request instead of merging or deleting the source branch.

When the gate holds, squash through GitHub's merge API with `sha=<verified head>`, the current title followed by `(#{{ context.pullRequestNumber }})`, and an empty body. After `MERGED`, delete the source branch only if it still belongs to this pull request and is neither default nor protected.

## Blockers

Checks, conflicts, feedback, documentation, and branch cleanup are work for a repair pass. Before recording a blocker, exhaust those fixes, preserve the pull request body, and upsert one block:

{{{ blocker }}}

Remove a cleared blocker before choosing this pass's result.
