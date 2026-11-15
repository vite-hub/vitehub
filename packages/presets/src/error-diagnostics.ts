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
    // Babysitter pass and inbox errors. The agent's tool input, the repair Sandbox, the host data directory, or GitHub caused them.
    PRESETS_BABYSITTER_CHECKOUT_POOL_REPLACED: {
      why: ({ path }: { path: string }) => `[vitehub] Refusing to clean replaced Babysitter checkout pool: ${path}`,
      fix: "Stop every other process that uses the Babysitter data directory, remove the directory that the message names, and start the Babysitter again.",
    },
    PRESETS_BABYSITTER_CHECKOUT_POOL_UNSAFE: {
      why: ({ root }: { root: string }) => `[vitehub] Refusing to clean unsafe Babysitter checkout pool: ${root}`,
      fix: "Replace the path that the message names with a real directory, or remove it. The Babysitter keeps its checkout pool there and does not follow symbolic links.",
    },
    PRESETS_BABYSITTER_GITHUB_CURSOR_INVALID: {
      why: ({ kind }: { kind: "review thread pagination" | "open pull request" }) => `Invalid ${kind} cursor`,
      fix: "Retry later; the Babysitter reads the pull requests again on its next pass. If it keeps failing, check the GitHub status page.",
    },
    PRESETS_BABYSITTER_GITHUB_HEAD_MISSING: {
      why: "GitHub returned no pull request head.",
      fix: "Check that the head branch or fork of the pull request still exists. Restore it, or close the pull request.",
    },
    PRESETS_BABYSITTER_GITHUB_QUERY_FAILED: {
      why: ({ query, errors }: { query: "review thread" | "open pull request", errors: string }) => `GitHub ${query} query failed: ${errors}`,
      fix: "Read the GitHub error in the message and check that the GitHub App has Pull requests: read permission on the repository. The Babysitter retries on its next pass.",
    },
    PRESETS_BABYSITTER_INBOX_STORAGE_MISSING: {
      why: "PullRequestInbox requires exactly one of path or storage.",
      fix: "Set inboxPath, a private node:sqlite file, or inboxStorage, such as agentState.extension(\"babysitter\"), in the createBabysitterRuntime() options.",
    },
    PRESETS_BABYSITTER_PROMPT_TOO_LARGE: {
      why: ({ characters, bytes, limit }: { characters: number, bytes: number, limit: number }) => `GitHubPullRequest prompt exceeds transport safety limit: ${characters} characters, ${bytes} UTF-8 bytes; limit ${limit}. All review/comment bodies were retained. No truncated prompt was sent.`,
      fix: "Shorten or hide the longest comments and review bodies on the pull request, or split it into smaller pull requests. The Babysitter does not cut feedback.",
    },
    PRESETS_DEPENDENCY_CHECKS_INCOMPLETE: {
      why: ({ warnings }: { warnings: string }) => `Dependency checks are incomplete: ${warnings}`,
      fix: "Give the GitHub App Checks: read and Commit statuses: read permission on the repository of the dependency. The Babysitter checks the wait again later.",
    },
    PRESETS_FEEDBACK_CHANGED: {
      why: "Feedback changed during pagination. Read again from offset zero.",
      fix: "Call readFeedback again with offset 0 and no version, then continue with the new version.",
    },
    PRESETS_FEEDBACK_NOT_FOUND: {
      why: "Feedback is absent or deleted from the assigned PR snapshot.",
      fix: "Pass to readFeedback the id and kind of a comment, review, or review comment from the pull request context of this pass.",
    },
    PRESETS_FEEDBACK_OFFSET_INVALID: {
      why: "Feedback offset exceeds the body length.",
      fix: "Pass an offset that is at most the body length, such as next.offset of the last readFeedback result.",
    },
    PRESETS_FEEDBACK_VERSION_MISSING: {
      why: "Continue with the version returned by the first feedback read.",
      fix: "Pass next.version from the last readFeedback result together with next.offset.",
    },
    PRESETS_SANDBOX_BUNDLE_MISSING: {
      why: "The repair Sandbox bundle is unavailable.",
      fix: "Call commitRepair or pushRepair again. If it fails again, check that the Sandbox provider can read files from the Sandbox workspace.",
    },
    PRESETS_SANDBOX_COMMIT_EXPORT_FAILED: {
      why: ({ stderr }: { stderr: string }) => `Cannot export the repair Sandbox commit: ${stderr}`,
      fix: "Commit the repair in the Sandbox checkout on top of the assigned head, without rewriting earlier commits, then call commitRepair or pushRepair again.",
    },
    PRESETS_SANDBOX_COMMIT_MISSING: {
      why: "The repair Sandbox did not return a commit SHA.",
      fix: "Check that the Sandbox workspace is a Git checkout with a commit at HEAD, then call commitRepair or pushRepair again.",
    },
    PRESETS_SANDBOX_HEAD_CHANGED: {
      why: "The repair Sandbox HEAD changed during export.",
      fix: "Do not commit in the Sandbox while commitRepair or pushRepair runs. Call it again.",
    },
    PRESETS_SANDBOX_REPAIR_DESTINATION_CHANGED: {
      why: "Repair destination parent changed during transfer.",
      fix: "Do not move or link directories in the checkout while commitRepair runs. Call commitRepair again.",
    },
    PRESETS_SANDBOX_REPAIR_DESTINATION_OUTSIDE: {
      why: "Repair destination parent must stay inside the checkout.",
      fix: "Remove the symbolic link in the parent path of the repair file, so that the file stays inside the checkout.",
    },
    PRESETS_SANDBOX_REPAIR_FILE_MISSING: {
      why: "The repair Sandbox file disappeared during transfer.",
      fix: "Do not delete repair files while commitRepair runs. Call commitRepair again with the files that exist.",
    },
    PRESETS_SANDBOX_REPAIR_PARENT_INVALID: {
      why: "Repair Sandbox parent must be a regular directory.",
      fix: "Replace the file or symbolic link in the parent path of the repair file with a directory in the Sandbox checkout.",
    },
    PRESETS_SANDBOX_REPAIR_PATH_DIRECTORY: {
      why: "Repair paths must name individual files.",
      fix: "List each changed file in the repair paths, not its directory.",
    },
    PRESETS_SANDBOX_REPAIR_PATH_INVALID: {
      why: "Repair paths must name files inside the assigned checkout.",
      fix: "Pass repair paths relative to the checkout root, such as src/index.ts, without .., .git, or a leading slash.",
    },
    PRESETS_SANDBOX_SYNC_FAILED: {
      why: ({ stderr }: { stderr: string }) => `Cannot synchronize repair Sandbox files: ${stderr}`,
      fix: "Read the Sandbox error in the message, check that the repair files are readable in the Sandbox, and call commitRepair again.",
    },
    // Review thread errors.
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
