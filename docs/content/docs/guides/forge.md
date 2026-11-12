---
title: Call GitHub as your GitHub App with useForge()
description: Get GitHub App installation tokens and a GitHub, GitLab, or Forgejo client from one set of env names, the same names that Channels and Workspaces read.
navigation.title: GitHub App and Forges
navigation.order: 30
navigation.group: Forges
icon: i-lucide-git-pull-request
---

`useForge()` gives server code one Forge identity. With a GitHub App, it signs the App JWT, finds the installation of a repository, and mints installation tokens. You do not write JWT or token code.

`useForge()` and the GitHub Channel read the same App credentials. The Workspace GitHub store and GitHub Sources read only `VITEHUB_GITHUB_TOKEN` (or `FORGES_GITHUB_TOKEN`); they do not mint App installation tokens. Set a token separately when these consumers need private-repository access.

## Install

```bash [Terminal]
pnpm add @vite-hub/forge
```

`vite-hub/forge` re-exports `@vite-hub/forge`. An app that does not install the package does not load it.

## Set the env

| Variable | Use |
| --- | --- |
| `VITEHUB_GITHUB_APP_ID` | The App ID or the Client ID of the GitHub App. |
| `VITEHUB_GITHUB_PRIVATE_KEY` | The App private key in PEM. An escaped `\n` becomes a new line. |
| `VITEHUB_GITHUB_PRIVATE_KEY_PATH` | A file with the private key, when the host cannot store a multi-line value. |
| `VITEHUB_GITHUB_INSTALLATION_ID` | Optional. One fixed installation. Without it, `useForge()` finds the installation of each repository. |
| `VITEHUB_GITHUB_TOKEN` | A token to use when there is no App, such as `${{ secrets.GITHUB_TOKEN }}` in GitHub Actions. |
| `VITEHUB_GITLAB_TOKEN`, `VITEHUB_GITLAB_BASE_URL` | GitLab. |
| `VITEHUB_FORGEJO_TOKEN`, `VITEHUB_FORGEJO_BASE_URL` | Forgejo and Gitea. |

When `VITEHUB_GITHUB_APP_ID` is set, `useForge()` uses the App. Otherwise it uses `VITEHUB_GITHUB_TOKEN`. Each variable also has a `FORGES_` name, such as `FORGES_GITHUB_APP_ID`, which the `forges` library reads. `GH_TOKEN` and `GITHUB_TOKEN` are not read.

`useForge()` reads the bindings of the active Cloudflare request, then `process.env`. To read another source, pass `env`, for example `useForge({ env: process.env })`.

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

A GitHub provider also has `graphql()`. Get a new provider for each job. An installation token expires after one hour, and `useForge()` caches it until one minute before that.

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

## Errors

Operations return `[error, data]`. A configuration that cannot work throws, so you find it at the first call.

### Runtime errors

### FORGE_APP_NOT_INSTALLED

The GitHub App is not installed on the repository. Install the App on it, or set `VITEHUB_GITHUB_INSTALLATION_ID` to an installation that can reach it.

### FORGE_REQUEST_FAILED

A GitHub request failed. `error.cause` has the Forge error. A 401 means that the App ID, the private key, or the token is wrong. Retry after a 5xx or a network error.

### Configuration errors

### FORGE_MISSING_ENV

The env has no credentials for the Forge, or it has only a part of the App credentials. The error names the variables to set.

### FORGE_INVALID_ENV

A variable has a value that cannot work, such as an installation ID that is not a number, or a key path that names a file that does not exist.

### FORGE_MISSING_INSTALLATION

The App has no fixed installation, and the call has no `repository`. Pass `{ repository: 'owner/name' }`, or set `VITEHUB_GITHUB_INSTALLATION_ID`.

### FORGE_NOT_APP

`app()` needs a GitHub App, and the Forge uses a token. Check `forge.auth` before you call `app()`.
