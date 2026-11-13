---
title: Forge
layout: landing
navigation.title: Overview
description: Act as your GitHub App, or with a GitLab or Forgejo token, from server code. One set of env names for routes, Channels, and Agents.
navigation.order: 1
icon: i-lucide-git-pull-request
---

::product-hero{tagline="Call GitHub as your GitHub App, or GitLab and Forgejo with a token. You write no JWT or token code."}
  :::code-tree
  ```sh [.env]
  # Local development: the private PEM file must exist at runtime
  VITEHUB_GITHUB_APP_ID=123456
  VITEHUB_GITHUB_PRIVATE_KEY_PATH=./github-app.pem
  ```

  ```ts [server/api/issues.post.ts]
  import { createError, defineEventHandler } from 'h3'
  import { useForge } from 'vite-hub/forge'

  // Sends the installation token of acme/web
  export default defineEventHandler(async () => {
    const [error, github] = await useForge().provider({ repository: 'acme/web' })
    if (error) throw createError({ status: 502, message: error.why })

    const { data } = await github.request<{ html_url: string }>('POST', '/repos/acme/web/issues', {
      body: { title: 'Nightly build failed' },
    })
    return { url: data.html_url }
  })
  ```

  ```ts [server/utils/github-env.ts]
  import { useForge } from 'vite-hub/forge'

  // Give the token to git or gh
  export async function githubEnv(repository: string) {
    const [error, token] = await useForge().token({ repository })
    if (error) return error
    return { GH_TOKEN: token.token }
  }
  ```
  :::
::

For production, [provide credentials for your host](/docs/forge/get-started#in-production).

::product-features
  :::product-feature-item{title="Act as your GitHub App" icon="i-lucide-badge-check" to="/docs/forge/get-started"}
  `useForge()` signs the App JWT, finds the installation, and mints installation tokens.
  :::

  :::product-feature-item{title="A typed Forge client" icon="i-lucide-code-2" to="/docs/forge/server-api#call-the-api-as-the-app"}
  `provider()` returns a `forges` client. A GitHub client also has `graphql()`.
  :::

  :::product-feature-item{title="GitHub, GitLab, and Forgejo" icon="i-lucide-git-branch" to="/docs/forge/server-api#use-gitlab-or-forgejo"}
  Pass `forge`, and the client type follows it.
  :::

  :::product-feature-item{title="One set of env names" icon="i-lucide-key-round" to="/docs/forge/configure"}
  Routes, the GitHub Channel, and Agents read the same `VITEHUB_GITHUB_*` names.
  :::

  :::product-feature-item{title="Repository tools for Agents" icon="i-lucide-bot" to="/docs/agents/capabilities/forge"}
  The `forge()` Capability and the GitLab and Forgejo Channels use the same Forge.
  :::

  :::product-feature-item{title="Errors without try/catch" icon="i-lucide-circle-alert" to="/docs/forge/limits-and-errors"}
  Each call returns `[error, data]`. A configuration that cannot work throws at the first call.
  :::
::

::agent-only
Use Forge when server code calls GitHub, GitLab, or Forgejo as the app. Install `@vite-hub/forge` and import `useForge()` from `vite-hub/forge`. Do not write JWT or installation token code, and do not read `GH_TOKEN` or `GITHUB_TOKEN`.

Get a new provider for each job. Pass `repository` so a GitHub App finds the right installation. Import Forge error classes, such as `NotFoundError`, from `@vite-hub/forge`, not from `forges`.

Prove it with a real App or token against a test repository. Without credentials, show that `useForge()` throws `FORGE_MISSING_ENV` with the variables to set.
::
