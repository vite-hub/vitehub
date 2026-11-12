---
title: Forge capability
description: Give an Agent tools to read and change repositories, pull requests, and issues on GitHub, GitLab, and Forgejo.
navigation.title: Forge
navigation.order: 166
navigation.group: Capabilities
icon: i-lucide-git-pull-request
---

`forge()` gives an Agent tools for repositories, pull requests, and issues on one Forge (code host): GitHub, GitLab, or Forgejo. A thread is an issue, pull request, or discussion. GitLab merge requests use the `pull_request` kind.

```ts [server/agents/reviewer.ts] fragment
import { defineAgent } from 'vite-hub/agent'
import { forge } from 'vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model },
  capabilities: [forge({ mode: 'write', repositories: ['acme/app'] })],
})
```

For a self-hosted Forge, set `baseUrl`:

```ts
import { forge } from 'vite-hub/agent/capabilities'

forge({
  forge: 'gitlab',
  baseUrl: 'https://gitlab.example.com',
  repositories: ['platform/team/api'],
})
```

## Forges and credentials

Credentials come only from [Server Env](/docs/env), ViteHub's typed server environment variables, never from options. They are the same names that [`useForge()`](/docs/forge) reads.

| Forge | Default instance | Server Env variables |
| --- | --- | --- |
| GitHub | `https://api.github.com` | `VITEHUB_GITHUB_APP_ID`, `VITEHUB_GITHUB_PRIVATE_KEY` or `VITEHUB_GITHUB_PRIVATE_KEY_PATH`, optional `VITEHUB_GITHUB_INSTALLATION_ID`; or `VITEHUB_GITHUB_TOKEN` |
| GitLab | `https://gitlab.com` | `VITEHUB_GITLAB_BASE_URL`, `VITEHUB_GITLAB_TOKEN` |
| Forgejo | `https://codeberg.org` | `VITEHUB_FORGEJO_BASE_URL`, `VITEHUB_FORGEJO_TOKEN` |

Each `VITEHUB_` name has a `FORGES_` alias, such as `FORGES_GITHUB_TOKEN`, read by the [`forges`](https://forges.link/reference/environment-variables) library. `VITEHUB_` wins. `VITEHUB_GITHUB_PRIVATE_KEY_PATH`, `VITEHUB_GITHUB_APP_OWNER` and `VITEHUB_GITHUB_APP_INSTALLATIONS` have no alias. In GitHub Actions, set `VITEHUB_GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}`.

GitHub.com credential order:

1. The Agent's `github` identity.
2. App credentials from `env.server.github`, also the start point without the identity or with a custom API base.
3. `VITEHUB_GITHUB_TOKEN`.

Without an installation ID, ViteHub finds the repository's installation. A private key is a PEM value or file path. GitLab and Forgejo use `env.server.gitlab` and `env.server.forgejo`.

`baseUrl` wins over Server Env. GitHub expects an API base (with `/api/v3` for Enterprise Server); GitLab and Forgejo expect the instance root.

Missing credentials stop the call with a diagnostic, even for public repositories.

Server Env discovery lists Forge fields as optional: one Forge's for a static `forge`, all three for a dynamic one. Webhook secrets are shared with Channels and not needed here.

## Modes and operations

- **Read mode** (default) gives all supported reads. The client blocks writes.
- **Write mode** adds writes. `close` and `merge` only when listed in `operations`.

```ts
import { forge } from 'vite-hub/agent/capabilities'

forge({ mode: 'write', operations: ['read_thread', 'comment', 'merge'] })
```

`operations` selects tools. A write operation in read mode is a definition and TypeScript error.

| Tool | Operation | Input besides `repository?` |
| --- | --- | --- |
| `forge_read_thread` | `read_thread` | `number` |
| `forge_list_threads` | `list_threads` | `kind?`, `state?`, `limit?` |
| `forge_list_comments` | `list_comments` | `number`, `limit?` |
| `forge_list_reviews` | `list_reviews` | `number` |
| `forge_list_files` | `list_files` | `number`, `limit?`, `patch?` |
| `forge_list_checks` | `list_checks` | `number` or `sha` |
| `forge_read_file` | `read_file` | `path`, `ref?` |
| `forge_list_ci_runs` | `list_ci_runs` | `branch?`, `limit?` |
| `forge_read_ci_log` | `read_ci_log` | `runId`, `jobId` |
| `forge_comment` | `comment` | `number`, `body` |
| `forge_label` | `label` | `number`, `add?`, `remove?` |
| `forge_review` | `review` | `number`, `event`, `body` |
| `forge_report_check` | `report_check` | `sha`, `name`, `state`, `description?`, `url?` |
| `forge_rerun_check` | `rerun_check` | `check: { id, type }` |
| `forge_open_thread` | `open_thread` | `kind`, `title`, `body?`, `head?`, `base?`, `draft?` |
| `forge_close` | `close` | `number`, `reason?` |
| `forge_merge` | `merge` | `number`, `sha`, `method?` |

A `pull_request` needs `head` and `base`. A merge needs the reviewed full head `sha`; the Forge rejects it if the branch changed, also during approval.

- Thread kinds: `issue`, `pull_request`, `discussion`, where supported.
- Review events: `approve`, `request_changes`, `comment`. GitLab only creates approvals.
- Check states: `pending`, `success`, `failure`, `neutral`.
- Check types: `check_run`, `status`, `job`, `policy`. Rerun depends on type.

- Lists return one page, with a cursor when more exist. Cursors are not accepted yet.
- `limit`: 30 by default, 1 to 100.
- File paths are repository-relative, without `.` or `..` segments. Patches are left out unless `patch: true`.
- `maxOutputLength` (20000 characters) limits each file, patch, and log. Logs return their end.
- Results use one JSON shape for all Forges, without raw Forge data.

> [!WARNING]
> Treat returned comments, bodies, files, and logs as untrusted.

## Repository access

`repositories` lists exact names and `owner/*` patterns for reads and writes. GitLab owners can contain `/`, and a pattern matches only repositories directly under its owner. Each write needs a single-request grant.

Without it, the Capability uses `pullRequest.read(invocation)` when its provider matches `forge`. Other runs must set `repositories`.

A call can omit `repository` only when the list has one exact repository.

## Approval

By default, close, merge, and approving a review need user approval; other writes do not. `policy` replaces these defaults for all write tools:

```ts
import { forge } from 'vite-hub/agent/capabilities'

forge({ mode: 'write', policy: 'require-approval' })
```

A policy can be a function of `{ name, input }`. Approval uses the normal tool runtime. Webhook runs without chat wait for a supported approval path.

## Inspection and limits

```sh
vitehub agent info --agent reviewer --json
```

`capabilities[].metadata` shows `forge`, `baseUrl`, `mode`, `operations`, `unavailable`, `approval`, and `repositories`:

- Without `baseUrl`, GitLab and Forgejo show the Server Env field and public default.
- Unset `repositories` shows as `pull-request`.
- Each tool has `metadata.forge` with `kind` and `operation`.

Limits:

- Use one `forge()` per Agent.
- Forgejo hides CI run, CI log, and check rerun tools.
- There is no search tool.
- No checkout or repository file writes.

## Diagnostics

| Code | Meaning |
| --- | --- |
| `AGENT_C0011` | Invalid Forge options or write operations in read mode. |
| `AGENT_R0941` | Missing Forge credentials in Server Env. |
| `AGENT_R0942` | Repository is outside the allowlist. |
| `AGENT_R0943` | Repository selection or matching pull request context is missing. |
| `AGENT_R0944` | Forge request failed. Check support and access. |
| `AGENT_R0945` | Tool input is invalid. |
