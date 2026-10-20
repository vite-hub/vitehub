# @vite-hub/forge

`@vite-hub/forge` is the one Forge client of ViteHub. Channels, Capabilities, Workspaces and Sources use it to reach GitHub, GitLab and Forgejo. It is built on [`forges`](https://forges.link).

Applications do not install this package. They set Server Env, and the `vite-hub` packages that need a Forge read it. This README is the contract for ViteHub packages that depend on it.

## Server Env

Each field reads its `VITEHUB_` name first, then the `FORGES_` name that the `forges` library reads.

| Field | Names |
| --- | --- |
| `github.token` | `VITEHUB_GITHUB_TOKEN`, `FORGES_GITHUB_TOKEN` |
| `github.appId` | `VITEHUB_GITHUB_APP_ID`, `FORGES_GITHUB_APP_ID` |
| `github.privateKey` | `VITEHUB_GITHUB_PRIVATE_KEY`, `FORGES_GITHUB_PRIVATE_KEY` |
| `github.privateKeyPath` | `VITEHUB_GITHUB_PRIVATE_KEY_PATH` |
| `github.installationId` | `VITEHUB_GITHUB_INSTALLATION_ID`, `FORGES_GITHUB_INSTALLATION_ID` |
| `github.appOwner` | `VITEHUB_GITHUB_APP_OWNER` |
| `github.appInstallations` | `VITEHUB_GITHUB_APP_INSTALLATIONS` |
| `github.webhookSecret` | `VITEHUB_GITHUB_WEBHOOK_SECRET`, `FORGES_GITHUB_WEBHOOK_SECRET` |
| `gitlab.baseUrl`, `gitlab.token`, `gitlab.webhookSecret` | `VITEHUB_GITLAB_*`, `FORGES_GITLAB_*` |
| `forgejo.baseUrl`, `forgejo.token`, `forgejo.webhookSecret` | `VITEHUB_FORGEJO_*`, `FORGES_FORGEJO_*` |

`GH_TOKEN` and `GITHUB_TOKEN` are not read. In GitHub Actions, set `VITEHUB_GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}`.

## Public imports

| Import | Use |
| --- | --- |
| `forgeEnv` | The Server Env table above. |
| `readForgeEnv(field, env)` | The first value set for one `forgeEnv` field, from an env record or a lookup function. |
| `forgeProvider(connection)` | A `forges` provider for one Forge. Return it from a public API only where that API owns the Forge credentials. A GitHub provider has `graphql()`. |
| `branchRules(provider, repo, branch)` | GitHub only. Required checks, required workflows and allowed merge methods from rulesets and classic protection. |
| `listReviewThreads(provider, pull)`, `getReviewThread(provider, id)` | GitHub only. List the review conversations of a pull request, or look up one by id. |
| `retargetPullRequest(provider, pull, base)` | GitHub only. Change the base branch of a pull request. |
| `ForgeApiError`, `ForgeTimeoutError`, `MergeBlockedError`, `NotFoundError`, `RateLimitedError`, `repoRef` | The bundled `forges` classes and helper. Import them from here, so that `instanceof` matches errors from `forgeProvider()`. |
| `githubAppCredentials(input)` | GitHub App installation tokens, installation lookup and App metadata. Tokens are cached until one minute before they expire. |
| `readGitHubAppPrivateKey(inline, path)` | Read a PEM key from a value or a file. |
| `forgeArchive(provider, repo, { ref, signal })` | The repository tree at `ref` as a `tar.gz` stream. GitHub only. Anonymous github.com reads go to `codeload.github.com` and do not use the API limit. |
| `forgeGitCredentials({ forge, baseUrl, token, repository })` | The Git smart HTTP remote and the basic auth pair for one repository. |
| `forgeGitAuthHeader(credentials)` | The `http.<remote>.extraheader` entry for `GIT_CONFIG_KEY_<n>` and `GIT_CONFIG_VALUE_<n>`. It keeps the token out of process arguments. |
| `forgeBlob(provider, repo, sha, { signal })` | The bytes of one blob by sha. GitHub only. |
| `forgeCommitFiles(provider, repo, input, options)` | `contents.commitFiles()` that can also set git file modes (`100644`, `100755`, `120000`). Returns the commit sha. |
| `BranchMovedError` | The bundled `forges` error for a branch that moved before a commit. |
| `forgeErrorStatus(error)`, `ForgeResponseError` | Classify Forge request failures. |
| `withSignal(promise, signal)`, `abortError(signal)` | Cancellation helpers for Forge calls. |

## Diagnostics

| Code | Cause |
| --- | --- |
| `FORGE_R0001` | The GitHub App installation lookup failed, or the App is not installed on the repository. |
| `FORGE_R0002` | `forgeArchive()` was called for a Forge other than GitHub. |
| `FORGE_R0003` | `forgeGitCredentials()` received a base URL that is not HTTP or a repository that is not `owner/name`. |
| `FORGE_R0004` | `forgeBlob()` was called for a Forge other than GitHub. |
| `FORGE_R0005` | `forgeCommitFiles()` received a file mode for a Forge other than GitHub. |
| `FORGE_R0006` | A GitHub-only helper got a provider for another Forge. |
| `FORGE_R0007` | GitHub did not return complete branch rules, rulesets or classic protection. |
| `FORGE_R0008` | GitHub did not return complete review threads. |
| `FORGE_R0009` | A GitHub-only helper got a reference that is not a numbered pull request, or an empty input. |

## Gaps in `forges`

`src/gaps/` holds small helpers for operations that `forges` does not have yet. Each one has the signature that we propose upstream.

| Helper | Gap |
| --- | --- |
| `forgeArchive()` | No `contents.archive()`. |
| `forgeBlob()` | `contents.file()` reads by path, not by blob sha. |
| `forgeCommitFiles()` | `contents.commitFiles()` cannot set a file mode. |
| `forgeGitCredentials()`, `forgeGitAuthHeader()` | `Repo.cloneUrls` has no transport credential. |
| `branchRules()` | No branch protection, rulesets or required checks. |
| `listReviewThreads()`, `getReviewThread()` | No review thread listing. |
| `retargetPullRequest()` | No pull request base change. |
