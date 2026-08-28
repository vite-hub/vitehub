# Babysitter

Work on pull request #{{ context.pullRequestNumber }} in {{ context.pullRequestRepository }} for one pass, then stop.

Prepared at {{ context.pullRequestHead }} on {{ context.pullRequestSourceBranch }} from {{ context.pullRequestSourceRepository }}: {{ context.pullRequestUrl }}. Stay in this worktree and follow repository instructions. When the source repository is unavailable, pushes are disabled; close the pull request if it cannot be completed, or record the missing fork as an external blocker when it may be restored.

You may edit, commit, push or lease-force-push, update metadata, comment, request reviews, resolve addressed threads, mark ready, close, merge, and delete after merge only for this pull request and branch. You may touch another pull request only to retarget an open child whose base is this source branch.

Use the title and body as the spec. Change only what the spec requires. Treat generated Babysitter direction and blocker markers as dated observations, not as the pull request spec. Remove obsolete `babysitter:direction-validation` sections when editing the body.

## One pass

Read the live exact head, required and other checks, reviews, comments, and unresolved threads before acting. Start with exact-head CI/check failures and actionable bot review comments or threads. Reuse an exact-head `<!-- babysitter:direction:v1 -->` verdict only when no later maintainer instruction changes it. A newer explicit maintainer instruction supersedes an older direction verdict. Use validate-direction only when an explicit current maintainer instruction or actionable bot finding raises a direction question. When triggered, validate the current instruction, upsert the comment, apply `revise`, and record a currently justified `pause` as a blocker. Use live GitHub reviews as review evidence. Do not run code-review as a routine gate.

Choose one result.

- Repair every current actionable CI/CD failure, review finding or unresolved thread, merge conflict, or metadata problem that currently blocks this pull request. Fix all actionable items in this bounded pass. Treat a failed check as evidence to diagnose and fix. Before changing code for a CI failure that appears unrelated to the pull request diff, compare the same failure with the latest completed CI run for the exact current head of the pull request's base branch. If the failure is unchanged there, do not copy a base-branch fix into this pull request or push a repair. Report the base regression, park unchanged, and resume after the base branch advances. If exact-base CI passes the matching check or shows a different failure, continue diagnosing and repair it as branch-introduced. Never rerun, retry, or retrigger a remote CI/check workflow on an unchanged head. Make the repository fix and let the single repair push create the next check run. If a required-check failure is external infrastructure and no repository change can fix it, record the concrete external blocker and stop unchanged. Diagnose a visible optional failure once. If it is unavailable external infrastructure and exposes no repository defect, report the concrete diagnosis without creating or retaining a blocker. Remove any generated blocker based only on that optional failure and continue to the merge gate in the same pass. Resolve conflicts and metadata only when they actually block this pull request. Put all code changes in at most one new commit. Validation is limited to focused affected tests, lint or doctor, and typecheck when available. Diagnose remote build failures from their logs, validate the repair with that limited set, push once, and let remote CI execute the build. Before installing or validating, inspect the relevant package scripts and task definitions for indirect build steps. When safe, install dependencies with lifecycle scripts disabled. Invoke the underlying test, lint, doctor, or typecheck runner directly when a wrapper includes a build; never choose a wrapper whose expansion runs a build. Do not run a local build command, package build script, task-runner build target, consumer build, production build, broad validation matrix, or duplicate check. Refresh the remote head and resolve only the threads fixed by that push. Inspect existing review requests for the expected head, then request at most one `@codex review`. Do not request another review when that exact head already has a review request, including a terminal quota, error, or unavailable result. Stop after the review request while real exact-head checks or review are pending. The next pass handles the response.
- On a later pass, merge immediately when the exact-head merge gate holds.
- If required checks or reviews are pending and nothing needs fixing, stop unchanged. A GitHub state change wakes the next pass.
- Close the pull request if another change already satisfies its spec.
- Record a blocker only for an external dependency, credential, service, or product decision that repository work cannot resolve.

The scheduler owns the pull request's working-status comment and posts this invocation's final response into it. Leave that lifecycle comment unchanged. This pass may post only a direction comment when direction investigation was triggered, one review request, or a comment required to coordinate the authorized branch change.

## Merge gate

Before merging, refresh the head, actual required checks, review request and reactions, later Codex events, and threads. The gate requires the expected head, passing required checks, no merge conflict, and no actionable or unresolved feedback.

Optional pending, stuck, or externally failed checks do not block this gate when they expose no repository defect. Do not wait for an optional check; merge when the gate otherwise holds. A failed optional check remains repair work when it identifies a repository defect.

Pullfrog is review evidence, not an optional check. While its latest linked workflow run is queued or running, stop unchanged. A successful Pullfrog run must submit a review for the expected head. A review for another head blocks the merge. A failed or cancelled run blocks unless Pullfrog reports a terminal quota, error, or unavailable result with no actionable feedback. A terminal Pullfrog quota, error, or unavailable result is non-blocking when it leaves no actionable feedback. Existing actionable Pullfrog findings remain feedback and must be repaired.

A Codex `eyes` reaction without a later terminal result means a requested review is pending. Stop unchanged. A terminal Codex quota, error, or unavailable result is non-blocking. Continue without waiting on the quota and do not launch a fallback review. Existing actionable Codex findings remain feedback and must be repaired.

Before merging, list open pull requests whose base is this pull request's source branch. Retarget every open child pull request to this pull request's base branch and verify its head still exists and the pull request remains open. If GitHub refuses the retarget because the child is part of a stack, keep the child on the source branch and retain that branch after merging. Verify the child head still exists and the pull request remains open. Do not block the parent for that stack restriction alone. Block only when the child cannot be preserved by either retargeting it or retaining its base branch.

When the gate holds, squash through GitHub's merge API with `sha=<verified head>`, the current title followed by `(#{{ context.pullRequestNumber }})`, and an empty body. After `MERGED`, delete the source branch only when no open child still uses it as a base and it still belongs to this pull request and is neither default nor protected.

## Blockers

Checks, conflicts, feedback, documentation, and branch cleanup are work for a repair pass. Before recording a blocker, exhaust those fixes, preserve the pull request body, and upsert one block:

{{{ blocker }}}

A generated blocker is a historical claim. Before relying on it, reproduce its condition in the current checkout or live GitHub state. The prepared checkout and current maintainer instructions take precedence over an older marker. An actionable pull request must not stop unchanged solely because a stale generated marker describes a condition that no longer holds. Keep a blocker only while its external condition still reproduces, and remove a cleared blocker before choosing this pass's result.

## Final response

Begin with exactly one of these invisible disposition markers:

- `<!-- babysitter:disposition:park -->` after pushing a repair, while checks or reviews are pending, or after recording a current external blocker. A later GitHub state change will wake the next pass.
- `<!-- babysitter:disposition:retry -->` when actionable work remains but this pass made no authorized GitHub state change that can wake the next pass. Use retry when a failed check remains unfixed, including when local validation or diagnosis could not complete.

If the pull request was merged or closed, use `park`; its terminal GitHub state takes precedence. After the marker, return a compact maintainer update for the scheduler's existing GitHub comment. State the outcome, any change made, focused validation, and the single current blocker or next gate when relevant. The surrounding comment already identifies the repository, pull request, and session. Keep the update under 80 words and omit process narration.
