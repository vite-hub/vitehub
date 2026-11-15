import { defineErrors } from "@vite-hub/runtime"

export const presetsErrorDiagnostics = /*#__PURE__*/ defineErrors({
  docs: "https://vitehub.dev/docs/agents/diagnostics",
  codes: {
    PRESETS_BABYSITTER_REPOSITORIES_INVALID: {
      why: 'Babysitter filter.repository.allow lists no "owner/name" repository.',
      fix: 'List repositories as "owner/name", or remove filter.repository.allow so the Babysitter serves every repository that its GitHub App can access.',
    },
    // Labeller errors. The options of an Agent that extends labeller, or the Agent passed to cleanupLabeller(), caused them.
    PRESETS_LABELLER_ACTIONS_INVALID: {
      why: "[vitehub] Labeller actions must be an object.",
      fix: "Set the Labeller actions option to an object keyed by declared label names, such as { Receipts: { archive: true } }, or leave it out.",
    },
    PRESETS_LABELLER_ACTION_FLAG_INVALID: {
      why: ({ name, key }: { name: string, key: string }) => `[vitehub] Labeller ${name} ${key} must be a boolean.`,
      fix: "Set archive, read, star, and trash to true or false in the rule or action that the message names, or leave them out.",
    },
    PRESETS_LABELLER_ACTION_INVALID: {
      why: ({ label }: { label: string }) => `[vitehub] Labeller action "${label}" must be an object.`,
      fix: "Set the action that the message names to an object, such as { archive: true, read: true }.",
    },
    PRESETS_LABELLER_ACTION_LABEL_UNDECLARED: {
      why: ({ label }: { label: string }) => `[vitehub] Labeller action "${label}" refers to an undeclared label.`,
      fix: "Add the label that the message names to the Labeller labels option, or remove its entry from actions.",
    },
    PRESETS_LABELLER_BODY_LIMIT_INVALID: {
      why: ({ max }: { max: number }) => `[vitehub] Labeller bodyLimit must be an integer from 1 to ${max}.`,
      fix: "Set the Labeller bodyLimit option to a whole number of characters from 1 to 100000, or leave it out to keep the default.",
    },
    PRESETS_LABELLER_CLEANUP_AGENT_INVALID: {
      why: "[vitehub] cleanupLabeller() expects an Agent that extends labeller.",
      fix: "Pass the Agent Definition that you made with defineAgent({ extends: labeller, ... }) to cleanupLabeller(), such as the default export of server/agents/inbox.ts.",
    },
    PRESETS_LABELLER_CLEANUP_INVALID: {
      why: "[vitehub] Labeller cleanup must be an object.",
      fix: "Set the Labeller cleanup option to an object of rules, such as { promotions: { label: \"Promotions\", olderThan: 14 } }, or leave it out.",
    },
    PRESETS_LABELLER_CLEANUP_LABEL_NAME_INVALID: {
      why: ({ name }: { name: string }) => `[vitehub] Labeller cleanup rule "${name}" needs a label name without quotes, backslashes, or control characters.`,
      fix: "Rename the label of the cleanup rule that the message names, in labels and in the rule, without quotes, backslashes, or control characters.",
    },
    PRESETS_LABELLER_CLEANUP_LABEL_UNDECLARED: {
      why: ({ name }: { name: string }) => `[vitehub] Labeller cleanup rule "${name}" refers to an undeclared label.`,
      fix: "Set label of the cleanup rule that the message names to a name from the Labeller labels option.",
    },
    PRESETS_LABELLER_CLEANUP_OLDER_THAN_INVALID: {
      why: ({ name }: { name: string }) => `[vitehub] Labeller cleanup rule "${name}" needs olderThan as a positive whole number of days.`,
      fix: "Set olderThan of the cleanup rule that the message names to a whole number of days, such as 14.",
    },
    PRESETS_LABELLER_LABELS_INVALID: {
      why: "[vitehub] Labeller labels must be an object.",
      fix: "Set the Labeller labels option to an object keyed by label name, such as { Work: { description: \"Work mail\" } }.",
    },
    PRESETS_LABELLER_LABEL_COUNT_INVALID: {
      why: "[vitehub] Labeller labels must contain between 1 and 254 labels.",
      fix: "Declare from 1 to 254 labels in the labels option of the Agent that extends labeller.",
    },
    PRESETS_LABELLER_LABEL_NAME_INVALID: {
      why: ({ name }: { name: string }) => `[vitehub] Labeller label "${name}" is reserved or invalid.`,
      fix: "Rename the label that the message names. Use 1 to 225 characters without control characters, and do not use a Gmail system label such as INBOX, SPAM, or NONE.",
    },
    PRESETS_LABELLER_LABEL_SETTINGS_INVALID: {
      why: ({ name }: { name: string }) => `[vitehub] Labeller label "${name}" must be an object.`,
      fix: "Set the label that the message names to an object, such as { description: \"Purchases and invoices\" }.",
    },
    PRESETS_LABELLER_MIN_CONFIDENCE_INVALID: {
      why: "[vitehub] Labeller minConfidence must be between 0 and 1.",
      fix: "Set the Labeller minConfidence option to a number from 0 to 1, such as 0.6, or leave it out to keep the default.",
    },
    PRESETS_LABELLER_OPTION_NOT_BOOLEAN: {
      why: ({ key }: { key: string }) => `[vitehub] Labeller ${key} must be a boolean.`,
      fix: "Set the Labeller option that the message names to true or false, or leave it out to keep the default.",
    },
    PRESETS_LABELLER_PATTERN_INVALID: {
      why: ({ max }: { max: number }) => `[vitehub] Labeller patterns must be non-empty strings of at most ${max} characters.`,
      fix: "Give each rule pattern as a non-empty string of at most 256 characters, or a non-empty array of such strings.",
    },
    PRESETS_LABELLER_REGEX_ESCAPE_INVALID: {
      why: "[vitehub] Labeller regex patterns may only escape literal regex characters.",
      fix: "Escape only literal regex characters in the pattern, such as \\. or \\/. Classes such as \\d and back-references such as \\1 are not supported.",
    },
    PRESETS_LABELLER_REGEX_FLAGS_INVALID: {
      why: "[vitehub] Labeller regex patterns use only bounded syntax and the i, m, s, and u flags.",
      fix: "Write the regex pattern as /source/flags with at most 256 source characters and only the i, m, s, and u flags, such as /invoice/i.",
    },
    PRESETS_LABELLER_REGEX_INVALID: {
      why: "[vitehub] Labeller regex pattern is invalid.",
      fix: "Fix the regex pattern of the rule so that new RegExp() accepts it, or use a plain string pattern.",
    },
    PRESETS_LABELLER_REGEX_SYNTAX_UNSUPPORTED: {
      why: "[vitehub] Labeller regex patterns may not use repetition or grouping.",
      fix: "Remove (), [], {}, *, +, and ? from the regex pattern, or list several plain patterns in an array instead.",
    },
    PRESETS_LABELLER_RULES_INVALID: {
      why: "[vitehub] Labeller rules must be an object.",
      fix: "Set the Labeller rules option to an object keyed by rule name, such as { receipts: { subject: \"invoice\", label: \"Receipts\" } }, or leave it out.",
    },
    PRESETS_LABELLER_RULE_HEADER_INVALID: {
      why: ({ name }: { name: string }) => `[vitehub] Labeller rule "${name}" has an invalid header name.`,
      fix: "Use non-empty header names of at most 1000 characters in the header field of the rule that the message names, such as { \"List-Id\": \"news\" }.",
    },
    PRESETS_LABELLER_RULE_INVALID: {
      why: ({ name }: { name: string }) => `[vitehub] Labeller rule "${name}" must be an object.`,
      fix: "Set the rule that the message names to an object with match fields and a label, such as { from: \"billing@\", label: \"Receipts\" }.",
    },
    PRESETS_LABELLER_RULE_LABEL_MISSING: {
      why: ({ name }: { name: string }) => `[vitehub] Labeller rule "${name}" must declare a label before enabling actions.`,
      fix: "Add label to the rule that the message names, or remove its archive, read, star, and trash actions.",
    },
    PRESETS_LABELLER_RULE_LABEL_UNDECLARED: {
      why: ({ name }: { name: string }) => `[vitehub] Labeller rule "${name}" refers to an undeclared label.`,
      fix: "Set label of the rule that the message names to a name from the Labeller labels option, or add that label to labels.",
    },
    PRESETS_LABELLER_RULE_NESTING_TOO_DEEP: {
      why: "[vitehub] Labeller rules may nest at most eight not clauses.",
      fix: "Nest at most eight not clauses in one rule. Split the rule into several rules instead.",
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
