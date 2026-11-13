---
title: Forge server API
description: Call a Forge as your GitHub App or with a token, give a token to git or gh, know who the App is, and use the building blocks of @vite-hub/forge.
navigation.title: Server API
navigation.order: 4
icon: i-lucide-code-2
---

Import `useForge()` from `vite-hub/forge`. It re-exports `@vite-hub/forge`.

| Call | Returns |
| --- | --- |
| `useForge({ forge, baseUrl, env, fetch, userAgent, conditionalRequests })` | The Forge of this deployment. `forge` defaults to `"github"`. `env` defaults to the active Cloudflare bindings, then `process.env`. Throws `FORGE_MISSING_ENV` or `FORGE_INVALID_ENV` when the env cannot work. |
| `forge.kind`, `forge.auth`, `forge.baseUrl` | The Forge, `"app"` or `"token"`, and the API base. |
| `forge.token({ repository, refresh, signal })` | `[error, { token, expiresAt }]`. With a GitHub App, an installation token for `repository`, or for `VITEHUB_GITHUB_INSTALLATION_ID`. |
| `forge.provider({ repository, refresh, signal })` | `[error, provider]`, a `forges` provider that sends `token()`. A GitHub provider has `graphql()`. |
| `forge.app({ signal })` | `[error, { id, slug, login }]` of the GitHub App. Throws `FORGE_NOT_APP` with a token. |

`baseUrl` is the API base for GitHub Enterprise Server, or the instance root for GitLab and Forgejo. A cancelled call rejects with the abort reason.

## Call the API as the App

`provider()` returns a [`forges`](https://forges.link) client that sends the installation token of the repository:

```ts [server/api/issues.post.ts]
import { createError, defineEventHandler } from 'h3'
import { useForge } from 'vite-hub/forge'

export default defineEventHandler(async () => {
  const [error, github] = await useForge().provider({ repository: 'acme/web' })
  if (error) throw createError({ status: 502, message: error.why })

  const { data } = await github.request<{ html_url: string }>('POST', '/repos/acme/web/issues', {
    body: { title: 'Nightly build failed' },
  })
  return { url: data.html_url }
})
```

A GitHub provider also has `graphql()`. Get a new provider for each job, because an installation token expires. See [Limits](/docs/forge/limits-and-errors#limits).

A GitHub provider sends a repeated `GET` with `If-None-Match` and the ETag of the last response. When nothing changed, GitHub answers `304 Not Modified`, which doesn't count against the rate limit, and the provider returns the body it kept. Each page of a list is kept on its own. The bodies live in memory, up to 32 MiB per process, and are kept per App installation, so they outlast the hourly token rotation. Every read still goes to GitHub, so a kept body is never returned unless GitHub says it is current. Turn it off with `useForge({ conditionalRequests: false })`.

## Give a token to git or gh

`token()` returns the token itself:

```ts [server/utils/github-env.ts]
import { useForge } from 'vite-hub/forge'

export async function githubEnv(repository: string) {
  const [error, token] = await useForge().token({ repository })
  if (error) return error
  return { GH_TOKEN: token.token }
}
```

`expiresAt` is the expiry of an installation token. It is `undefined` for `VITEHUB_GITHUB_TOKEN`. Pass `refresh: true` to mint a new token before the cached one expires.

## Know who the App is

`app()` returns the App ID, its slug, and its bot login, such as `acme-bot[bot]`. Use the login to find comments that the App wrote:

```ts [server/utils/github-bot.ts]
import { useForge } from 'vite-hub/forge'

export async function botLogin() {
  const [error, app] = await useForge().app()
  if (error) throw error
  return app.login
}
```

## Use GitLab or Forgejo

Pass `forge`. The provider type follows it:

```ts [server/utils/gitlab.ts]
import { useForge } from 'vite-hub/forge'

export async function gitlab() {
  const [error, provider] = await useForge({ forge: 'gitlab' }).provider()
  if (error) throw error
  return provider
}
```

## Public imports

`useForge()` is the app API. The other exports are the building blocks that ViteHub packages use.

| Import | Use |
| --- | --- |
| `forgeEnv` | The [Server Env](/docs/forge/configure#server-env) table. |
| `readForgeEnv(field, env)` | The first value set for one `forgeEnv` field, from an env record or a lookup function. |
| `forgeProvider(connection)` | A `forges` provider for one Forge. Return it from a public API only where that API owns the Forge credentials. A GitHub provider has `graphql()`. |
| `conditionalFetch(fetch, { identity, cache })`, `forgeMemoryCache({ maxSize, maxEntrySize })` | The `fetch` wrapper behind `conditionalRequests`, and its in-memory LRU. The default cache holds up to 32 MiB of bodies per process and skips bodies over 1 MiB. |
| `githubBranchRuleDetails(rules)` | GitHub only. Required workflows, ruleset merge methods and the classic protection source from the result of `provider.repos.branchRules()`. |
| `retargetPullRequest(provider, pull, base)` | GitHub only. Change the base branch of a pull request. |
| `ForgeApiError`, `ForgeTimeoutError`, `MergeBlockedError`, `NotFoundError`, `RateLimitedError`, `repoRef` | The bundled `forges` classes and helper. Import them from here, so that `instanceof` matches errors from `forgeProvider()`. The [`vitehub/forge-error-imports`](/docs/reference/doctor-rules#vhub0026) Doctor rule checks it. |
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
