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
    PRESETS_BABYSITTER_ADMISSION_CHECK_INVALID: {
      why: "Invalid admission.check result. Expected undefined or { reason, detail, retryAt }.",
      fix: "Return undefined from the Babysitter admission.check function, or a pause object with a non-empty reason string, an optional detail string, and an optional retryAt timestamp in milliseconds.",
    },
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
    PRESETS_BABYSITTER_HOST_EXECUTABLE_UNAVAILABLE: {
      why: ({ program, problem }: { program: string, problem: string }) => `The host executable ${program} ${problem}.`,
      fix: "Install the executable that the message names in the PATH of the trusted host service. A script must start with an interpreter line, such as #!/usr/bin/env node. Model passes wait until this check succeeds.",
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
