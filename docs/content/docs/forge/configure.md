---
title: Forge configuration
description: Set the env of a GitHub App, a token, GitLab, or Forgejo, and see which ViteHub parts read the same names.
navigation.title: Configure
navigation.order: 3
icon: i-lucide-sliders-horizontal
---

Forge has no `vitehub()` option. It reads its credentials from the env when you call `useForge()`.

## Set the env

| Variable | Use |
| --- | --- |
| `VITEHUB_GITHUB_APP_ID` | The App ID or the Client ID of the GitHub App. |
| `VITEHUB_GITHUB_PRIVATE_KEY` | The App private key in PEM. An escaped `\n` becomes a new line. |
| `VITEHUB_GITHUB_PRIVATE_KEY_PATH` | A private PEM file that is available at runtime. On Cloudflare, use a `VITEHUB_GITHUB_PRIVATE_KEY` secret binding instead. |
| `VITEHUB_GITHUB_INSTALLATION_ID` | Optional. One fixed installation. Without it, `useForge()` finds the installation of each repository. |
| `VITEHUB_GITHUB_TOKEN` | A token to use when there is no App, such as `${{ secrets.GITHUB_TOKEN }}` in GitHub Actions. |
| `VITEHUB_GITLAB_TOKEN`, `VITEHUB_GITLAB_BASE_URL` | GitLab. |
| `VITEHUB_FORGEJO_TOKEN`, `VITEHUB_FORGEJO_BASE_URL` | Forgejo and Gitea. |

When `VITEHUB_GITHUB_APP_ID` is set, `useForge()` uses the App. Otherwise it uses `VITEHUB_GITHUB_TOKEN`. `GH_TOKEN` and `GITHUB_TOKEN` are not read.

`useForge()` reads the bindings of the active Cloudflare request, then `process.env`. To read another source, pass `env`, for example `useForge({ env: process.env })`.

## Server Env

Each field reads its `VITEHUB_` name first, then the `FORGES_` name that the [`forges`](https://forges.link) library reads. `forgeEnv` from `vite-hub/forge` is this table.

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

## Who reads the same names

- `useForge()` and the GitHub Channel read the same App credentials. See [Forge access for Git and Drivers](/docs/agents/channels#forge-access-for-git-and-drivers).
- The [`forge()` Capability](/docs/agents/capabilities/forge) and the [GitLab and Forgejo Channels](/docs/agents/forge-channels) read the same names.
- The Workspace GitHub store and GitHub Sources read only `VITEHUB_GITHUB_TOKEN` (or `FORGES_GITHUB_TOKEN`). They do not mint App installation tokens. Set a token separately when these parts need private-repository access.
