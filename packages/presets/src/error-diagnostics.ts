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
    // Babysitter errors. The Babysitter options, the runtime options, the agent's tool input, or GitHub caused them.
    PRESETS_BABYSITTER_AGENT_INVALID: {
      why: "Babysitter runtime requires a configured Babysitter Agent Definition.",
      fix: "Pass the Agent Definition that you made with defineAgent({ extends: babysitter, ... }) as agent to createBabysitterRuntime().",
    },
    PRESETS_BABYSITTER_BASE_COMMIT_UNREADABLE: {
      why: "Conflict repair requires the exact live base branch commit.",
      fix: "Check that the base branch of the pull request still exists and that the GitHub App has Contents: read permission. The Babysitter retries the pull request on its next pass.",
    },
    PRESETS_BABYSITTER_DRIVER_UNSUPPORTED: {
      why: "Babysitter requires a Codex or Claude Code driver for its isolated Git checkout.",
      fix: "Set driver to \"codex\" or \"claude-code\" in the Babysitter options, and do not replace the driver of the Agent that extends babysitter.",
    },
    PRESETS_BABYSITTER_EXTERNAL_STATE_MISSING: {
      why: "Missing external pull-request state.",
      fix: "Check that the pull request of the wait still exists and that the GitHub App can read its repository. The Babysitter checks the wait again later.",
    },
    PRESETS_BABYSITTER_GITHUB_LIST_MISSING: {
      why: ({ path }: { path: string }) => `GitHub did not return a list for ${path}.`,
      fix: "Check that the GitHub App can read the repository that the path names. The Babysitter retries on its next pass; if it keeps failing, check the GitHub status page.",
    },
    PRESETS_BABYSITTER_IGNORE_AUTHORS_INVALID: {
      why: "[vitehub] Babysitter ignoreFeedbackAuthors must list GitHub logins.",
      fix: "Set ignoreFeedbackAuthors in the Babysitter options to an array of GitHub logins, such as [\"renovate[bot]\"], without empty strings.",
    },
    PRESETS_BABYSITTER_INSTALL_COMMAND_FAILED: {
      why: ({ output }: { output: string }) => output || "Dependency installation failed.",
      fix: "Run the install.command of the Babysitter options in a checkout of the pull request and fix the failure that the output shows. The pull request waits and retries.",
    },
    PRESETS_BABYSITTER_LIFECYCLE_LABELS_CONFLICT: {
      why: "[vitehub] Configure Babysitter lifecycle labels or filter.labels, not both.",
      fix: "Keep lifecycle.labels or filter.labels in the Babysitter options and remove the other one.",
    },
    PRESETS_BABYSITTER_MERGE_QUEUE_QUERY_FAILED: {
      why: ({ errors }: { errors: string }) => `GitHub merge queue query failed: ${errors}`,
      fix: "Read the GitHub error in the message and check that the GitHub App has Pull requests: read permission. The Babysitter retries the merge on its next pass.",
    },
    PRESETS_BABYSITTER_NO_FINDINGS_PREFIX_EMPTY: {
      why: "[vitehub] Babysitter noFindingsReviews cannot contain an empty prefix.",
      fix: "Remove the empty string from noFindingsReviews in the Babysitter options, or give each entry the text that starts a no-findings review.",
    },
    PRESETS_BABYSITTER_TOOL_FIELD_INVALID: {
      why: ({ key, expected }: { key: string, expected: string }) => `${key} must be ${expected}.`,
      fix: "Pass the field that the message names as a string in the tool input. Only a body may be empty.",
    },
    PRESETS_BABYSITTER_TOOL_FIELD_MISSING: {
      why: ({ key }: { key: string }) => `Missing ${key}.`,
      fix: "Add the field that the message names to the tool input.",
    },
    PRESETS_BABYSITTER_TOOL_PATHS_MISSING: {
      why: "Expected explicit repair paths.",
      fix: "Pass paths to commitRepair as an array of file path strings, such as { message: \"fix: lint\", paths: [\"src/index.ts\"] }.",
    },
    PRESETS_BABYSITTER_TOOL_RUN_ID_MISSING: {
      why: "Expected a run ID.",
      fix: "Pass runId as a number, the workflow run ID from the check details URL, to readCheckLogs or readBaseCheckLogs.",
    },
    PRESETS_BABYSITTER_TOOL_UPDATE_EMPTY: {
      why: "Expected a title or body.",
      fix: "Pass title, body, or both to updatePullRequest.",
    },
    PRESETS_BABYSITTER_WAKE_REPOSITORY_UNKNOWN: {
      why: "External wake repository is outside the configured repositories.",
      fix: "Wait only on pull requests and checks in repositories that the Babysitter serves, or add the repository to filter.repository.allow and install the GitHub App on it.",
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
