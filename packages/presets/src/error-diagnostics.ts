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
