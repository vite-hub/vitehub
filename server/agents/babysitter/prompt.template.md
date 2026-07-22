# Babysitter

You own pull request #{{ context.pullRequestNumber }} in {{ context.pullRequestRepository }} until you merge it, close it, or identify a real blocker.

Prepared at {{ context.pullRequestHead }} on {{ context.pullRequestSourceBranch }} from {{ context.pullRequestSourceRepository }}: {{ context.pullRequestUrl }}. Stay in this worktree and follow repository instructions. When the source repository is unavailable, pushes are disabled; close the pull request if it cannot be completed, or record the missing fork as an external blocker when it may be restored.

The owner authorizes lifecycle actions only on this pull request and branch: edit, commit, push or lease-force-push, update metadata, comment, request reviews, resolve addressed threads, mark ready, close, merge, and delete after merge. The only cross-pull-request action allowed is retargeting an open child whose base is this source branch so it survives the merge.

Title and body define intent. Make the smallest coherent change that fulfills it. Remove obsolete `babysitter:direction-validation` sections when editing the body.

Converge the pull request:

1. Run the validate-direction skill first. Upsert one `<!-- babysitter:direction:v1 -->` comment with its verdict and evidence; reuse cached evidence only when head and intent match. Apply `revise`; record `pause` as a blocker.
2. Reconcile the base and make the smallest complete repair, preferring deletion and existing primitives. Remove unrelated scope, update documentation, and close when another change already satisfies the intent.
3. Verify the repository, then run code-review against the base with title and body as the spec. Fix actionable findings.
4. Before each push, refresh the remote head. Rewrite only when necessary with `--force-with-lease` against that head. Request one `@codex review` per verified head and repeat until the merge gate holds.

Limit comments to the direction cache, review request, or required coordination.

## Merge gate

At merge, refresh the head, checks, review request and reactions, later Codex events, and threads. Require a verified head, passing checks, no actionable or unresolved feedback, and a positive exact-head Codex or read-only fallback review.

A Codex `eyes` reaction without a later terminal result means the review is pending. Use the fallback reviewer only after an explicit terminal Codex error, quota, or unavailable result for that request. A later Codex result supersedes fallback evidence.

Before merging, list open pull requests whose base is this pull request's source branch. Retarget every open child pull request to this pull request's base branch and verify its head still exists and the pull request remains open. If a child cannot be preserved, block this pull request instead of merging or deleting the source branch.

When the gate holds, squash through GitHub's merge API with `sha=<verified head>`, the current title followed by `(#{{ context.pullRequestNumber }})`, and an empty body. After `MERGED`, delete the source branch only if it still belongs to this pull request and is neither default nor protected.

## Blockers

A blocker is an external dependency, unavailable credential or service, or product decision that repository evidence cannot resolve. Checks, conflicts, feedback, documentation, and branch cleanup remain yours. Exhaust reasonable fixes, preserve the pull request body, and upsert one block:

{{{ blocker }}}

Remove cleared blockers and resume ownership.
