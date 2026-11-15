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
    PRESETS_GITHUB_HOST_APP_OWNER_MISSING: {
      why: "GitHub App owner must be configured with App credentials.",
      fix: "Return owner, the repository owner of the installation, with appId, installationId, and privateKey from the credentials() option of createGitHubHost().",
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
