import { defineErrors } from "@vite-hub/runtime"

export const presetsErrorDiagnostics = /*#__PURE__*/ defineErrors({
  docs: "https://vitehub.dev/docs/agents/diagnostics",
  codes: {
    PRESETS_BABYSITTER_REPOSITORIES_INVALID: {
      why: 'Babysitter filter.repository.allow lists no "owner/name" repository.',
      fix: 'List repositories as "owner/name", or remove filter.repository.allow so the Babysitter serves every repository that its GitHub App can access.',
    },
    PRESETS_MERGE_DRAFT_AUTHORS_INVALID: {
      why: "Babysitter merge.markDraftsReady must be an array of GitHub logins.",
      fix: "Set merge.markDraftsReady to non-empty GitHub logins, such as [\"octocat\", \"renovate[bot]\"], or remove it.",
    },
    PRESETS_BABYSITTER_OPTION_INVALID: {
      why: ({ option, expected }: { option: string; expected: string }) => `Babysitter ${option} must be ${expected}.`,
      fix: ({ option, expected }: { option: string; expected: string }) => `Set ${option} to ${expected} in the Babysitter options, or leave it out to keep the default.`,
    },
    PRESETS_BABYSITTER_ENV_MISSING: {
      why: ({ variables }: { variables: string[] }) => `The Babysitter cannot start without ${variables.join(", ")}.`,
      fix: "Set each listed variable on the host, or declare it in env.server.github. Create the GitHub App, its private key and its webhook secret as the Babysitter guide's Minimal setup shows.",
    },
    PRESETS_GITHUB_APP_OWNER_MISSING: {
      why: "`createGitHubAppCredentials()` got `installationId` without `owner`. An installation belongs to one repository owner.",
      fix: "Pass `owner`, the repository owner of the installation, or map owners to installations in `installations`.",
    },
    PRESETS_BABYSITTER_PLACEMENT_CAPACITY: {
      why: ({ reason }: { reason: string }) => reason,
      fix: "The Babysitter retries the pull request after `retryAfterMs`. To run more passes at once, add hosts or slots to the placement.",
    },
    PRESETS_REVIEW_OUTCOME_INVALID: {
      why: "Review thread outcome must be one of fixed, disproved, declined, pre-existing, duplicate.",
      fix: "Set outcome to fixed, disproved, declined, pre-existing, or duplicate.",
    },
    PRESETS_REVIEW_REASON_REQUIRED: {
      why: ({ outcome }: { outcome: string }) => `A ${outcome} review thread needs a one-sentence reason.`,
      fix: "Pass a non-empty reason that explains the outcome. Only fixed may omit the reason.",
    },
    PRESETS_REVIEW_SEVERE_DECLINED: {
      why: "A valid P0 or P1 finding cannot be declined, whatever the review push budget.",
      fix: "Fix the finding in this pull request, or answer it as disproved, pre-existing or duplicate with the evidence. When the finding is valid but lower than P1, start the reason with that class, such as \"P2: ...\".",
    },
    PRESETS_REVIEW_MENTION_FORBIDDEN: {
      why: "Comments cannot contain GitHub mentions; use the guarded mention capability.",
      fix: "Remove rendered GitHub mentions from the reason. Use mentionOnPullRequest for an allowed notification.",
    },
    PRESETS_REVIEW_CURSOR_INVALID: {
      why: "GitHub returned an invalid review comment cursor.",
      fix: "Retry the operation to read the thread again. If the cursor is still missing or repeated, check the GitHub API response before resolving the thread.",
    },
    // GitHub pull request operation errors. The Babysitter agent's tool input, GitHub, or a concurrent push caused them.
    PRESETS_AUTO_MERGE_HEAD_UNCONFIRMED: {
      why: "GitHub did not confirm the expected pull request head.",
      fix: "Read the pull request again. If its head changed, stop this pass; the Babysitter starts a new pass for the new head.",
    },
    PRESETS_AUTO_MERGE_REF_CHANGED: {
      why: "Pull request ref changed during auto-merge admission.",
      fix: "Stop this pass. Someone pushed to the pull request or changed its base branch, and the Babysitter starts a new pass for the new head.",
    },
    PRESETS_AUTO_MERGE_UNCONFIRMED: {
      why: "GitHub did not confirm native auto-merge was enabled.",
      fix: "Turn on Allow auto-merge in the repository settings, check that the GitHub App has Pull requests: write permission, and request auto-merge again.",
    },
    PRESETS_CHECKS_READ_INCOMPLETE: {
      why: ({ warnings }: { warnings: string }) => `GitHub could not read every check: ${warnings}`,
      fix: "Give the GitHub App Checks: read and Commit statuses: read permission on the repository, then read the base checks again.",
    },
    PRESETS_COMMENT_MENTION_FORBIDDEN: {
      why: "Comments cannot contain GitHub mentions; use the guarded mention capability.",
      fix: "Remove the @mentions from the commentOnPullRequest body. Use mentionOnPullRequest to notify an allowed login.",
    },
    PRESETS_GITHUB_GRAPHQL_FAILED: {
      why: ({ errors }: { errors: string }) => errors || "GitHub could not complete the pull request operation.",
      fix: "Read the GitHub error in the message. Check that the GitHub App has Pull requests: write permission on the repository, then retry the operation.",
    },
    PRESETS_GITHUB_PAGINATION_INVALID: {
      why: ({ detail }: { detail: "omitted a pagination cursor" | "pagination did not advance" | "thread pagination did not advance" | "returned an invalid label cursor" | "returned an invalid review cursor" }) => `GitHub ${detail}.`,
      fix: "Retry the operation. If it fails again, check the GitHub status page; the Babysitter retries the pull request on its next pass.",
    },
    PRESETS_GITHUB_QUERY_FAILED: {
      why: "GitHub could not complete the pull request query.",
      fix: "Check that the GitHub App has Pull requests: read and Checks: read permission on the repository. The Babysitter retries the pull request on its next pass.",
    },
    PRESETS_GITHUB_RESPONSE_INVALID: {
      why: ({ part }: { part: "response" | "connection" | "feedback response" | "pull request list" | "string field" | "boolean field" }) => `GitHub returned an invalid ${part}.`,
      fix: "Retry later; the Babysitter retries the pull request on its next pass. If it keeps failing, check the GitHub status page and that the GitHub App can read the repository's pull requests.",
    },
    PRESETS_MENTION_BODY_MENTION: {
      why: "Mention body must not contain another mention.",
      fix: "Remove the other @mentions from the mentionOnPullRequest body. Call mentionOnPullRequest once for each allowed login.",
    },
    PRESETS_MENTION_LOGIN_NOT_ALLOWED: {
      why: "GitHub login is not in the configured mention allowlist.",
      fix: "Mention only a login from the Babysitter mentionAllowlist option, or add the login to mentionAllowlist.",
    },
    PRESETS_OPERATION_BASE_CHANGED: {
      why: "Pull request base changed; discard this base CI comparison.",
      fix: "Stop comparing with the base checks in this pass. The base branch no longer contains the assigned base commit, and the next pass gets a new base.",
    },
    PRESETS_OPERATION_BASE_MISSING: {
      why: "This worker has no assigned base commit for CI comparison.",
      fix: "Do not call readBaseCheckEvidence or readBaseCheckLogs in this pass. Use readCheckLogs for the checks of the pull request head.",
    },
    PRESETS_OPERATION_FILTER_MISMATCH: {
      why: "Pull request no longer matches the configured filter.",
      fix: "Stop this pass. The pull request changed and no longer matches the Babysitter filter option, so the Babysitter does not request auto-merge.",
    },
    PRESETS_OPERATION_HEAD_CHANGED: {
      why: "Pull request head changed; discard this worker's operations.",
      fix: "Stop this pass and do not push. Someone pushed to the pull request, and the Babysitter starts a new pass for the new head.",
    },
    PRESETS_OPERATION_PULL_REQUEST_CLOSED: {
      why: "Pull request is no longer open and ready for repair.",
      fix: "Stop this pass. The pull request was merged or closed; reopen it if the Babysitter must continue.",
    },
    PRESETS_OPERATION_UNAVAILABLE: {
      why: ({ operation }: { operation: "dependency refresh" | "host-owned commit" | "host-owned push" }) => `This worker has no ${operation} operation.`,
      fix: "Do not call that operation in this pass. The Babysitter gives it only when the install option or the pass allows it; report the change you need instead.",
    },
    PRESETS_PULL_REQUEST_BODY_CHANGED: {
      why: "Pull request body changed while validating the update; retry.",
      fix: "Call updatePullRequest again. Someone edited the pull request body at the same time.",
    },
    PRESETS_PULL_REQUEST_BODY_MENTION: {
      why: "Pull request bodies cannot add GitHub mentions; use the guarded mention capability.",
      fix: "Remove the new @mentions from the updatePullRequest body. Use mentionOnPullRequest to notify an allowed login.",
    },
    PRESETS_PULL_REQUEST_INPUT_EMPTY: {
      why: ({ name }: { name: string }) => `${name} must not be empty.`,
      fix: "Pass a non-empty value for the field that the message names.",
    },
    PRESETS_PULL_REQUEST_UPDATE_EMPTY: {
      why: "Provide a pull request title or body.",
      fix: "Pass title, body, or both to updatePullRequest.",
    },
    PRESETS_REPAIR_CONFLICTS_UNRESOLVED: {
      why: ({ files }: { files: string }) => `Resolve the remaining merge conflicts and call commitRepair with their file paths: ${files}`,
      fix: "Remove the conflict markers from each file that the message lists, then call commitRepair again with those file paths.",
    },
    PRESETS_REPAIR_INDEX_CHANGED: {
      why: "Repair index changed during dependency validation.",
      fix: "Do not run Git commands while commitRepair runs. Call commitRepair again.",
    },
    PRESETS_REPAIR_INPUT_MISSING: {
      why: "A repair message and explicit file paths are required.",
      fix: "Pass a non-empty message and the paths of the changed files to commitRepair.",
    },
    PRESETS_REPAIR_MERGE_CHANGED: {
      why: "Prepared merge metadata or index changed outside the host repair tools.",
      fix: "Do not run git add, git reset, git merge, or git commit yourself. Stage and commit the merge only with commitRepair.",
    },
    PRESETS_REPAIR_PATH_DIRECTORY: {
      why: "Repair paths must name individual files.",
      fix: "List each changed file in commitRepair paths, not its directory.",
    },
    PRESETS_REPAIR_PATH_INVALID: {
      why: "Repair paths must name files inside the assigned checkout.",
      fix: "Pass paths relative to the checkout root, such as src/index.ts, without .., .git, or a leading slash.",
    },
    PRESETS_REPAIR_STAGED_CHANGES: {
      why: "Repair checkout contains unrelated staged changes.",
      fix: "Do not stage files with git add. Pass the files to commit in commitRepair paths; commitRepair stages them.",
    },
    PRESETS_REVIEW_THREAD_NOT_FOUND: {
      why: "Review thread does not belong to this pull request.",
      fix: "Pass the ID of a review thread from this pull request to resolveReviewThread. Read the review threads again to get it.",
    },
    PRESETS_WORKFLOW_RUN_BASE_MISMATCH: {
      why: "Workflow run does not belong to this pull request's exact base commit.",
      fix: "Pass the ID of a workflow run from readBaseCheckEvidence to readBaseCheckLogs.",
    },
    PRESETS_WORKFLOW_RUN_HEAD_MISMATCH: {
      why: "Workflow run does not belong to this pull request head.",
      fix: "Pass the ID of a workflow run of the current pull request head to readCheckLogs.",
    },
    PRESETS_WORKFLOW_RUN_ID_INVALID: {
      why: "Expected a positive workflow run ID.",
      fix: "Pass the numeric workflow run ID from the check details URL, such as 1234567890.",
    },
    PRESETS_WORKSPACE_GIT_INVALID: {
      why: "Provider workspace must use an independent Git directory.",
      fix: "Pass a workspace directory whose .git is a directory, or that has no .git. Do not use a Git worktree or a submodule there.",
    },
    PRESETS_WORKSPACE_OVERLAPS_CHECKOUT: {
      why: "Provider workspace must be separate from prepared checkout.",
      fix: "Pass a workspace directory outside the checkout to prepareWorkspace(), and do not use a parent of the checkout.",
    },
    // Babysitter merge and review option errors.
    PRESETS_MERGE_BYPASS_CHECKS_INVALID: {
      why: "Babysitter merge.bypassInheritedChecks must map repositories to check names.",
      fix: "Set merge.bypassInheritedChecks to an object whose keys are owner/name repositories and whose values are arrays of non-empty required check names, such as { 'acme/app': ['ci'] }.",
    },
    PRESETS_DAILY_PUSH_BUDGET_SPENT: {
      why: ({ count, nextAt }: { count: number; nextAt: string }) => `Daily push budget spent: this PR has ${count} repair pushes in the last 24 hours, and the next push is allowed at ${nextAt}.`,
      fix: "Do not push or commit again in this pass. Reply to and resolve the remaining review threads, then report the current PR head as reviewedHead.",
    },
    PRESETS_BABYSITTER_MAIN_REPAIR_NEEDS_PREFIX: {
      why: "Babysitter mainRepair needs a mainRepairBranchPrefix: repair PRs are opened on branches with that prefix.",
      fix: "Set mainRepairBranchPrefix, such as \"repair-main-\", or set mainRepair to false.",
    },
    PRESETS_BABYSITTER_MINOR_ROUNDS_NEED_BUDGET: {
      why: "Babysitter minorReviewRounds needs a reviewPushBudget: settled rounds spend that budget.",
      fix: "Set reviewPushBudget to a positive integer, or set minorReviewRounds to false.",
    },
    PRESETS_DEPENDENCY_PATCH_MISSING: {
      why: ({ path }: { path: string }) => `Dependency patch ${path} does not exist in this checkout.`,
      fix: "Restore the patch file, or remove its entry from patchedDependencies.",
    },
    PRESETS_DEPENDENCY_REFRESH_LIMIT: {
      why: ({ limit }: { limit: number }) => `refreshDependencies already ran ${limit} time${limit === 1 ? "" : "s"} in this pass, the limit.`,
      fix: "Do not call refreshDependencies again. Read .git/vitehub-install.json for the last install result, then commit your dependency fixes and let hosted CI validate them, or report the install failure as the blocker.",
    },
    PRESETS_BABYSITTER_STACK_REPAIR_NEEDS_DIRECT_MERGE: {
      why: 'Babysitter repairStackChildren requires merge: "direct": only a direct merge stops a stack child from merging into its parent\'s branch.',
      fix: 'Set merge to "direct" or { strategy: "direct" }, or set repairStackChildren to false.',
    },
    PRESETS_REVIEW_COMMENT_MISSING: {
      why: "Review thread has no comment to answer.",
      fix: "Read the review thread again and use a thread that contains a review comment. Do not record an outcome until its reply can be posted.",
    },
    PRESETS_BABYSITTER_STATUS_INVALID: {
      why: "Babysitter status must be an object whose comment and checkRun fields are booleans.",
      fix: "Pass status: { comment?: boolean, checkRun?: boolean }, or leave status out to post both the activity comment and the babysitter check run.",
    },
    PRESETS_CHECK_LOG_SELECTION_INVALID: {
      why: ({ reason }: { reason: string }) => `readCheckLogs got an invalid line selection: ${reason}`,
      fix: "Pass tailLines from 1 to 1000 alone, or startLine with an optional endLine at most 999 lines after it.",
    },
    PRESETS_CHECK_LOG_START_PAST_END: {
      why: ({ startLine, totalLines }: { startLine: number, totalLines: number }) => `startLine ${startLine} is past the log's ${totalLines} lines.`,
      fix: "Pick a startLine from the totalLines of an earlier readCheckLogs result, or pass tailLines to read the end of the log.",
    },
  },
})
