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
    // Babysitter errors. The Babysitter options, the runtime options, the agent's tool input, or GitHub caused them.
    PRESETS_BABYSITTER_AGENT_INVALID: {
      why: "Babysitter runtime requires a configured Babysitter Agent Definition.",
      fix: "Pass the Agent Definition that you made with defineAgent({ extends: babysitter, ... }) as agent to createBabysitterRuntime().",
    },
    PRESETS_BABYSITTER_BASE_COMMIT_UNREADABLE: {
      why: "Conflict repair requires the exact live base branch commit.",
      fix: "Check that the base branch of the pull request still exists and that the GitHub App has Contents: read permission. The Babysitter retries the pull request on its next pass.",
    },
    PRESETS_BABYSITTER_DIRECT_MERGE_CLAIM_LOST: {
      why: "The direct merge claim of this pull request changed before the Babysitter could record that GitHub enqueued the merge.",
      fix: "Let the Babysitter retry the pull request on its next pass. If this repeats, check that only one Babysitter runtime uses the inbox database.",
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
    // GitHub install and host errors. A pull request's dependency files, the GitHub credentials, or a checkout input caused them.
    PRESETS_CHECKOUT_CLEANUP_FAILED: {
      why: ({ checkout }: { checkout: string }) => `[vitehub] Could not locate disposable checkout for cleanup: ${checkout}`,
      fix: "Check that no other process moves or deletes the checkout directory while a pass runs, then remove the directory that the message names.",
    },
    PRESETS_COREPACK_MISSING: {
      why: "Babysitter host installation requires Corepack in PATH. Install Corepack on the trusted host; Node 25 and newer do not bundle it.",
      fix: "Run `npm install --global corepack` on the Babysitter host and check that `corepack --version` works in the PATH of the host process. The pull request waits and retries.",
    },
    PRESETS_DEPENDENCIES_NOT_CURRENT: {
      why: "Dependency inputs changed or installation failed. Call refreshDependencies and rerun validation before committing.",
      fix: "Call refreshDependencies, read .git/vitehub-install.json for the install result, and run validation again before you commit.",
    },
    PRESETS_DEPENDENCY_GIT_HOST_LOCAL: {
      why: "Host-local Git dependencies are not allowed.",
      fix: "Replace the git: or git+file: dependency in the pull request with a registry version or an https:// tarball URL.",
    },
    PRESETS_DEPENDENCY_GIT_UNSUPPORTED: {
      why: "Git dependencies require preparation inside the provider sandbox.",
      fix: "Replace the Git dependency in the pull request with a registry version, a pkg.pr.new URL, or a GitHub archive or release tarball URL.",
    },
    PRESETS_DEPENDENCY_HOST_UNTRUSTED: {
      why: "Dependency downloads require a trusted HTTPS registry or forge.",
      fix: "Download the dependency over https:// from registry.npmjs.org, registry.yarnpkg.com, pkg.pr.new, github.com, or codeload.github.com, with no port and no credentials in the URL.",
    },
    PRESETS_DEPENDENCY_INPUTS_CHANGED: {
      why: "Dependency inputs changed during installation. Call refreshDependencies again before validation.",
      fix: "Do not edit package.json, lockfiles, or workspace files while the install runs. Call refreshDependencies again, then run validation.",
    },
    PRESETS_DEPENDENCY_INPUT_SYMLINK: {
      why: "Dependency inputs must not be symbolic links.",
      fix: "Replace the symbolic link with a regular file for each package.json, lockfile, .npmrc, .yarnrc.yml, and pnpm-workspace.yaml in the checkout.",
    },
    PRESETS_DEPENDENCY_PATCHES_INVALID: {
      why: "Dependency patches must be a path mapping.",
      fix: "Set patchedDependencies to an object that maps each package to a patch file path in the checkout, such as { \"pkg@1.0.0\": \"patches/pkg.patch\" }.",
    },
    PRESETS_DEPENDENCY_PATCH_NOT_FILE: {
      why: "Dependency patches must be regular files.",
      fix: "Point each patchedDependencies entry at a regular patch file in the checkout, not a directory or a special file.",
    },
    PRESETS_DEPENDENCY_PATCH_PATH_INVALID: {
      why: "Dependency patches must reference checkout files.",
      fix: "Set each patchedDependencies value to a patch file path string, or to { path } with that string.",
    },
    PRESETS_DEPENDENCY_PATH_HOST_LOCAL: {
      why: "Host-local dependency paths are not allowed.",
      fix: "Use a relative path inside the checkout, such as ./packages/lib. Do not use ~, //, a drive letter, or backslashes.",
    },
    PRESETS_DEPENDENCY_PATH_OUTSIDE: {
      why: "Host-local dependency paths must stay inside the checkout.",
      fix: "Change the file:, link:, portal:, or workspace path so that it resolves to a directory inside the checkout.",
    },
    PRESETS_DEPENDENCY_PROTOCOL_UNSUPPORTED: {
      why: "Unsupported dependency source protocol; downloads require a trusted HTTPS registry or forge.",
      fix: "Use a registry version or one of the npm:, workspace:, catalog:, file:, link:, portal:, or https: protocols for the dependency.",
    },
    PRESETS_DEPENDENCY_SYMLINK_OUTSIDE: {
      why: "Host-local dependency symlinks must stay inside the checkout.",
      fix: "Remove the symbolic link that points outside the checkout, or point it at a directory inside the checkout.",
    },
    PRESETS_DEPENDENCY_URL_INVALID: {
      why: "Dependency downloads require a trusted HTTPS URL with forward slashes.",
      fix: "Write the dependency URL as https://host/path with forward slashes and no backslashes.",
    },
    PRESETS_GITHUB_APP_CREDENTIALS_INCOMPLETE: {
      why: "GitHub App appId, installationId, and privateKey must be configured together.",
      fix: "Return appId, installationId, and privateKey together from the credentials() option of createGitHubHost(), or return only token.",
    },
    PRESETS_GITHUB_APP_NUMBER_INVALID: {
      why: ({ name }: { name: string }) => `${name} must be a positive integer.`,
      fix: "Set appId and installationId to the numeric IDs from the GitHub App settings and its installation, such as VITEHUB_GITHUB_APP_ID=123456.",
    },
    PRESETS_GITHUB_APP_REQUEST_FAILED: {
      why: ({ status }: { status: number }) => `GitHub App request /app failed with ${status}.`,
      fix: "Check that VITEHUB_GITHUB_APP_ID and VITEHUB_GITHUB_PRIVATE_KEY belong to the same GitHub App and that the key is not revoked. Read error.cause for the GitHub response.",
    },
    PRESETS_GITHUB_APP_RESPONSE_INVALID: {
      why: "GitHub App request /app returned a response that the host cannot read.",
      fix: "Retry later. If it fails again, read error.cause for the GitHub response and check the GitHub status page.",
    },
    PRESETS_GITHUB_APP_TOKEN_FAILED: {
      why: ({ status }: { status: number }) => `GitHub App token request failed with ${status}.`,
      fix: "Check that the GitHub App is installed on the repository owner, that the installation ID is current, and that the private key is valid. Read error.cause for the GitHub response.",
    },
    PRESETS_GITHUB_APP_TOKEN_MISSING: {
      why: "GitHub App token response did not include a token.",
      fix: "Retry later. If it fails again, check that the GitHub App installation is not suspended, and read error.cause for the GitHub response.",
    },
    PRESETS_GITHUB_AUTH_MISSING: {
      why: "GitHub authentication is not configured. Set VITEHUB_GITHUB_TOKEN or GitHub App credentials.",
      fix: "Set VITEHUB_GITHUB_TOKEN, or return a token or GitHub App credentials from the credentials() option of createGitHubHost(). A repository outside the App owner needs the token.",
    },
    PRESETS_GITHUB_DEPENDENCY_CONFLICT: {
      why: ({ file }: { file: string }) => `Resolve dependency conflicts in ${file} and call refreshDependencies before validation.`,
      fix: "Remove the merge conflict markers from the dependency file that the message names, then call `refreshDependencies` again.",
    },
    PRESETS_GITHUB_HOST_APP_OWNER_MISSING: {
      why: "GitHub App owner must be configured with App credentials.",
      fix: "Return owner, the repository owner of the installation, with appId, installationId, and privateKey from the credentials() option of createGitHubHost().",
    },
    PRESETS_GITHUB_INSTALL_FAILED: {
      why: ({ detail }: { detail: string }) => `Frozen dependency installation failed: ${detail}`,
      fix: "Read error.cause for the package manager output. Fix the lockfile or package.json of the pull request when `kind` is `input`. A retry helps when `retryable` is true, such as for installer capacity or the network.",
    },
    PRESETS_GITHUB_REPOSITORY_INVALID: {
      why: "Expected a GitHub repository in owner/name form.",
      fix: "Pass repository and headRepository as \"owner/name\", such as \"vite-hub/vitehub\".",
    },
    PRESETS_INSTALL_OUTPUT_CHANGED: {
      why: "Dependency output directory changed during installation.",
      fix: "Do not create, move, or delete workspace package directories while the install runs. Call refreshDependencies again.",
    },
    PRESETS_LINKED_BIN_CHANGED: {
      why: "Linked dependency bin target changed during snapshot validation.",
      fix: "Do not edit the bin files of linked dependencies while validation runs. Run validation again.",
    },
    PRESETS_LINKED_BIN_GIT_METADATA: {
      why: "Linked dependency bin targets must not read Git metadata.",
      fix: "Change the bin field of the linked package so that no target is inside a .git directory.",
    },
    PRESETS_LINKED_BIN_INVALID: {
      why: "Linked dependency bin targets must be file paths.",
      fix: "Set the bin field of the linked package to a file path string, or to an object whose values are file path strings.",
    },
    PRESETS_LINKED_BIN_NOT_FILE: {
      why: "Linked dependency bin targets must be regular files.",
      fix: "Point each bin entry of the linked package at a regular file, not a directory or a symbolic link.",
    },
    PRESETS_LINKED_BIN_OUTSIDE: {
      why: "Linked dependency bin targets must stay inside the checkout.",
      fix: "Point each bin entry of the linked package at a file inside the checkout.",
    },
    PRESETS_LOCAL_DEPENDENCY_CONTENTS_INVALID: {
      why: "Local dependency contents must be regular files and directories.",
      fix: "Remove symbolic links, sockets, and other special files from the file: dependency directory.",
    },
    PRESETS_LOCKFILE_MISSING: {
      why: "Frozen dependency installation requires a supported lockfile.",
      fix: "Commit pnpm-lock.yaml, package-lock.json, npm-shrinkwrap.json, or yarn.lock at the checkout root, or set install to false in the Babysitter options.",
    },
    PRESETS_NPM_CONFIG_UNSUPPORTED: {
      why: ({ key }: { key: string }) => `Unsupported project npm configuration: ${key}. Host-local configuration paths and package-manager extensions are not allowed.`,
      fix: "Remove the setting that the message names from .npmrc. The host accepts only hoisting, peer, workspace, node-linker, and trust-policy settings.",
    },
    PRESETS_NPM_VERSION_UNSUPPORTED: {
      why: "Host installation requires npm 7 or newer; older npm can execute repository onload scripts.",
      fix: "Set packageManager in package.json to npm 7 or newer, such as \"npm@11.6.3\".",
    },
    PRESETS_NPM_WORKSPACE_LINK_INVALID: {
      why: "npm workspace links must reference checkout-relative paths.",
      fix: "Run npm install in the checkout to write package-lock.json again, so that each link entry has a relative resolved path.",
    },
    PRESETS_PACKAGE_MANAGER_UNSUPPORTED: {
      why: "packageManager must select an official matching package-manager version.",
      fix: "Set packageManager in package.json to <name>@<x.y.z> with an optional +sha hash, where <name> is the package manager of the committed lockfile, such as \"pnpm@10.34.6\".",
    },
    PRESETS_PNPM_CONFIG_UNSUPPORTED: {
      why: ({ key }: { key: string }) => `Unsupported project pnpm configuration: ${key}. Host-local configuration paths and package-manager extensions are not allowed.`,
      fix: "Remove the setting that the message names from pnpm-workspace.yaml, or give it a supported value. Boolean settings take true or false.",
    },
    PRESETS_PULL_REQUEST_HEAD_CHANGED: {
      why: ({ expected, actual }: { expected: string, actual: string }) => `Pull request head changed from ${expected} to ${actual}.`,
      fix: "Read the pull request again and pass its current headSha to withPullRequestCheckout().",
    },
    PRESETS_PULL_REQUEST_HEAD_REF_INVALID: {
      why: "A pull request headRef cannot start with a dash.",
      fix: "Pass the branch name of the pull request head as headRef, without a leading dash.",
    },
    PRESETS_PULL_REQUEST_HEAD_REF_MISSING: {
      why: "A pull request headRef is required when headRepository is supplied.",
      fix: "Pass headRef, the branch name of the pull request head, together with headRepository to withPullRequestCheckout().",
    },
    PRESETS_PULL_REQUEST_HEAD_SHA_INVALID: {
      why: "A pull request headSha must be a full Git commit SHA.",
      fix: "Pass the 40-character head commit SHA of the pull request as headSha.",
    },
    PRESETS_PULL_REQUEST_PUSH_TARGET_MISSING: {
      why: "Pull request source repository and branch are required to push.",
      fix: "Pass headRepository and headRef of the pull request to withPullRequestCheckout() before you call push().",
    },
    PRESETS_PUSH_TARGET_HEAD_INVALID: {
      why: "Push target did not return a full Git commit SHA.",
      fix: "Commit your changes in the push target first, and use a SHA-1 Git repository.",
    },
    PRESETS_PUSH_TARGET_INVALID: {
      why: "Push target must be the root of its prepared Git checkout.",
      fix: "Pass the root directory of the prepared checkout or workspace to push(), not a subdirectory.",
    },
    PRESETS_YARN_LOCKFILE_INVALID: {
      why: "Invalid Yarn lockfile stanza; dependency fields must be structured.",
      fix: "Run yarn install in the checkout to write yarn.lock again, and commit the result.",
    },
    PRESETS_YARN_OUTPUT_INVALID: {
      why: "Yarn installation output must use a regular checkout directory.",
      fix: "Make .yarn a regular directory in the checkout, not a file or a symbolic link.",
    },
    PRESETS_YARN_PATCH_SELECTOR_INVALID: {
      why: "Yarn dependency patches must use project-relative ~/ selectors; parent package filesystems cannot be fingerprinted by the host.",
      fix: "Write each patch: path in the Yarn descriptor as ~/<path from the project root>, such as patch:pkg@npm:1.0.0#~/.yarn/patches/pkg.patch.",
    },
  },
})
