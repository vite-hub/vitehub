---
title: Call GitHub as your GitHub App
description: Install Forge, set the GitHub App env, and open an issue as the App from a server route.
layout: tutorial
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

A Forge is a code host, such as GitHub, GitLab, or Forgejo. `useForge()` gives your server code one Forge identity. With a GitHub App, it signs the App JWT, finds the installation of a repository, and mints installation tokens. You do not write JWT or token code.

In this tutorial, you open an issue as your GitHub App from a server route.

> [!NOTE] Before you start
> Start with the app from [Installation](/docs/getting-started/installation) and run commands from the app root. You need a GitHub App installed on a test repository and its private key.

::tutorial-step{title="Install Forge"}
## Install Forge

```bash pm [commands/install]
pnpm add @vite-hub/forge
```

`vite-hub/forge` re-exports `@vite-hub/forge`. An app that does not install the package does not load it.

::

::tutorial-step{title="Set the env"}
## Set the env

For local development, save the private key as `github-app.pem` in the app root. Add the App ID and key path to `.env`:

```sh [.env]
VITEHUB_GITHUB_APP_ID=123456
VITEHUB_GITHUB_PRIVATE_KEY_PATH=./github-app.pem
```

- `VITEHUB_GITHUB_APP_ID` is the App ID or Client ID of your GitHub App.
- `VITEHUB_GITHUB_PRIVATE_KEY_PATH` points to a file with the private key in PEM. The file must be available at runtime. Or set the PEM text in `VITEHUB_GITHUB_PRIVATE_KEY`.

Keep `.env` and the key out of git and public assets.

When `VITEHUB_GITHUB_APP_ID` is set, `useForge()` authenticates as the App. [Configure](/docs/forge/configure) lists every variable.

::

::tutorial-step{title="Open an issue"}
## Open an issue

Create `server/api/issues.post.ts`. Change `acme/web` to your test repository:

```ts [server/api/issues.post.ts]
import { defineEventHandler, HTTPError } from 'h3'
import { useForge } from 'vite-hub/forge'

export default defineEventHandler(async () => {
  const [error, github] = await useForge().provider({ repository: 'acme/web' })
  if (error) throw new HTTPError({ status: 502, message: error.why })

  const { data } = await github.request<{ html_url: string }>('POST', '/repos/acme/web/issues', {
    body: { title: 'Nightly build failed' },
  })
  return { url: data.html_url }
})
```

- `provider({ repository })` returns a [`forges`](https://forges.link) client authenticated with that repository's installation token.
- The call returns `[error, provider]`. If your App is not installed on the repository, `error.code` is `FORGE_APP_NOT_INSTALLED`.

Start the dev server with `pnpm dev`, then call the route from a second terminal:

```bash [commands/send]
curl -X POST http://localhost:3000/api/issues
```

The response has the URL of the new issue. The issue author is the bot user of your App, such as `acme-bot[bot]`.

::

## In production

Set `VITEHUB_GITHUB_APP_ID` on your host and provide the private key at runtime in a form that the host can read:

- On Cloudflare, store the PEM in a `VITEHUB_GITHUB_PRIVATE_KEY` secret binding. Remove the local `VITEHUB_GITHUB_PRIVATE_KEY_PATH` setting, because a deployed Worker does not have your local `github-app.pem` file. `useForge()` reads the request bindings.
- On hosts where a private key file is available at runtime, set `VITEHUB_GITHUB_PRIVATE_KEY_PATH` to that file. Otherwise, store the PEM in `VITEHUB_GITHUB_PRIVATE_KEY` in the host's secret settings.

When an App has multiple installations, `useForge()` looks up the installation for each repository. To skip that lookup, see [Installations](/docs/forge/configure#installations).

::card-group
:::card{title="Configure" icon="i-lucide-sliders-horizontal" to="/docs/forge/configure"}
Set the env for GitHub, GitLab, and Forgejo.
:::

:::card{title="Server API" icon="i-lucide-code-2" to="/docs/forge/server-api"}
Get a token for git or gh, and know who the App is.
:::

:::card{title="Forge capability" icon="i-lucide-git-pull-request" to="/docs/agents/capabilities/forge"}
Give an Agent tools for repositories, pull requests, and issues.
:::
::
