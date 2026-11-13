# @vite-hub/forge

[![npm version](https://comark-ui.onmax.me/badge.svg?source=npm-version&package=%40vite-hub%2Fforge&icon=npm)](https://npmx.dev/package/@vite-hub/forge)
[![npm downloads](https://comark-ui.onmax.me/badge.svg?source=npm-downloads&package=%40vite-hub%2Fforge&period=month&icon=npm)](https://npmx.dev/package/@vite-hub/forge)
[![license](https://comark-ui.onmax.me/badge.svg?label=license&value=Apache-2.0)](https://github.com/vite-hub/vitehub/blob/main/LICENSE)
[![docs](https://comark-ui.onmax.me/badge.svg?label=docs&value=vitehub.dev)](https://vitehub.dev/docs)

`@vite-hub/forge` is the one Forge identity of ViteHub. Apps call `useForge()` to act as their GitHub App, or with their GitLab or Forgejo token. Channels, Capabilities, Workspaces and Sources read the same env names. It is built on [`forges`](https://forges.link). User docs: [Forge](https://vitehub.dev/docs/forge).

The GitHub Channel can use the same App credentials. The Workspace GitHub store and GitHub Sources use only `VITEHUB_GITHUB_TOKEN` (or `FORGES_GITHUB_TOKEN`); they do not mint App installation tokens.

## Use it in an app

```bash
pnpm add @vite-hub/forge
```

Import it from `vite-hub/forge`, which re-exports this package:

```ts
import { useForge } from "vite-hub/forge"

const forge = useForge()
const [error, github] = await forge.provider({ repository: "acme/web" })
if (error) throw error
await github.request("POST", "/repos/acme/web/issues", { body: { title: "Nightly build failed" } })
```

| Call | Returns |
| --- | --- |
| `useForge({ forge, baseUrl, env, fetch, userAgent })` | The Forge of this deployment. `forge` defaults to `"github"`. `env` defaults to the active Cloudflare bindings, then `process.env`. Throws `FORGE_MISSING_ENV` or `FORGE_INVALID_ENV` when the env cannot work. |
| `forge.kind`, `forge.auth`, `forge.baseUrl` | The Forge, `"app"` or `"token"`, and the API base. |
| `forge.token({ repository, refresh, signal })` | `[error, { token, expiresAt }]`. With a GitHub App, an installation token for `repository`, or for `VITEHUB_GITHUB_INSTALLATION_ID`. Cached until one minute before it expires. |
| `forge.provider({ repository, refresh, signal })` | `[error, provider]`, a `forges` provider that sends `token()`. A GitHub provider has `graphql()`. |
| `forge.app({ signal })` | `[error, { id, slug, login }]` of the GitHub App. Throws `FORGE_NOT_APP` with a token. |

GitHub uses the App when `VITEHUB_GITHUB_APP_ID` is set, and `VITEHUB_GITHUB_TOKEN` otherwise. Runtime errors are `FORGE_APP_NOT_INSTALLED` and `FORGE_REQUEST_FAILED`. A cancelled call rejects with the abort reason. The codes are documented at [Forge limits and errors](https://vitehub.dev/docs/forge/limits-and-errors).

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

`useForge()` is the app API. The other exports are the building blocks that ViteHub packages use.

| Import | Use |
| --- | --- |
| `useForge(options)` | The Forge identity of the app, as above. |
| `forgeEnv` | The Server Env table above. |
| `readForgeEnv(field, env)` | The first value set for one `forgeEnv` field, from an env record or a lookup function. |
| `forgeProvider(connection)` | A `forges` provider for one Forge. Return it from a public API only where that API owns the Forge credentials. A GitHub provider has `graphql()`. |
| `githubBranchRuleDetails(rules)` | GitHub only. Required workflows, ruleset merge methods and the classic protection source from the result of `provider.repos.branchRules()`. |
| `retargetPullRequest(provider, pull, base)` | GitHub only. Change the base branch of a pull request. |
| `forgeMerge(provider, pull, options)` | `threads.merge()` with `bypassRules`. GitHub only with `bypassRules: true`: merge past failing branch rules, as an admin or a ruleset bypass actor. It needs `method` and `sha`. |
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
| `FORGE_R0007` | `githubBranchRuleDetails()` got branch rules that are not complete GitHub rulesets or classic protection. |
| `FORGE_R0009` | A GitHub-only helper got a reference that is not a numbered pull request, or an empty input. |

## Gaps in `forges`

`src/gaps/` holds small helpers for operations that `forges` does not have yet. Each one has the signature that we propose upstream.

| Helper | Gap |
| --- | --- |
| `forgeArchive()` | No `contents.archive()`. |
| `forgeBlob()` | `contents.getFile()` reads by path, not by blob sha. |
| `forgeCommitFiles()` | `contents.commitFiles()` cannot set a file mode. |
| `forgeGitCredentials()`, `forgeGitAuthHeader()` | `Repo.cloneUrls` has no transport credential. |
| `githubBranchRuleDetails()` | `BranchRules` has no required workflows, ruleset merge methods or classic protection source. |
| `retargetPullRequest()` | No pull request base change. |
| `forgeMerge()` | `threads.merge()` cannot bypass branch rules. |
