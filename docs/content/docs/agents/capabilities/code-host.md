---
title: Code Host
description: Read and change repositories on GitHub, GitLab and Forgejo.
navigation.title: Code Host
navigation.order: 166
navigation.group: Capabilities
icon: i-lucide-git-pull-request
---

`codeHost()` gives an Agent repository tools for one Code Host. GitLab merge requests use the `pull_request` thread kind.

```ts [server/agents/reviewer.ts]
import { defineAgent } from 'vite-hub/agent'
import { codeHost } from 'vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model },
  capabilities: [codeHost({ mode: 'write', repositories: ['acme/app'] })],
})
```

For a self-managed instance:

```ts
codeHost({
  host: 'gitlab',
  baseUrl: 'https://gitlab.example.com',
  repositories: ['platform/team/api'],
})
```

## Hosts and credentials

Credentials come from [Server Env](/docs/env). Options cannot contain credentials.

| Host | Default instance | Server Env variables |
| --- | --- | --- |
| GitHub | `https://api.github.com` | `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` or `GITHUB_APP_PRIVATE_KEY_PATH`, optional `GITHUB_APP_INSTALLATION_ID`; or `VITEHUB_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN` |
| GitLab | `https://gitlab.com` | `GITLAB_BASE_URL`, `GITLAB_TOKEN` |
| Forgejo | `https://codeberg.org` | `FORGEJO_BASE_URL`, `FORGEJO_TOKEN` |

For the default GitHub.com API, GitHub uses the Agent's `github` identity first. When that identity is unavailable, or for a custom GitHub API base, it tries App credentials from `env.server.github`, then the token variables in table order. Without an installation ID, it looks up the App installation for the repository. A private key can be an inline PEM value or a file path. GitLab and Forgejo use `env.server.gitlab` and `env.server.forgejo`.

`baseUrl` takes precedence over Server Env. GitHub expects an API base, including `/api/v3` for GitHub Enterprise Server. GitLab and Forgejo expect the instance root. Missing credentials stop the tool call with a diagnostic. Public reads also require credentials.

Discovery declares host fields as optional. A static `host` declares that host's fields. A dynamic host declares all three. Webhook secrets are shared with Channels and are not required by these tools.

## Modes and operations

Read mode is the default. It exposes all supported read operations and blocks writes in the host client. Write mode also exposes supported write operations. `close` and `merge` require an explicit `operations` entry.

```ts
codeHost({ mode: 'write', operations: ['read_thread', 'comment', 'merge'] })
```

`operations` selects the tool set. A write operation in read mode is a definition error and a TypeScript error.

| Tool | Operation | Input besides `repository?` |
| --- | --- | --- |
| `code_host_read_thread` | `read_thread` | `number` |
| `code_host_list_threads` | `list_threads` | `kind?`, `state?`, `limit?` |
| `code_host_list_comments` | `list_comments` | `number`, `limit?` |
| `code_host_list_reviews` | `list_reviews` | `number` |
| `code_host_list_files` | `list_files` | `number`, `limit?`, `patch?` |
| `code_host_list_checks` | `list_checks` | `number` or `sha` |
| `code_host_read_file` | `read_file` | `path`, `ref?` |
| `code_host_list_ci_runs` | `list_ci_runs` | `branch?`, `limit?` |
| `code_host_read_ci_log` | `read_ci_log` | `runId`, `jobId` |
| `code_host_comment` | `comment` | `number`, `body` |
| `code_host_label` | `label` | `number`, `add?`, `remove?` |
| `code_host_review` | `review` | `number`, `event`, `body` |
| `code_host_report_check` | `report_check` | `sha`, `name`, `state`, `description?`, `url?` |
| `code_host_rerun_check` | `rerun_check` | `check: { id, type }` |
| `code_host_open_thread` | `open_thread` | `kind`, `title`, `body?`, `head?`, `base?`, `draft?` |
| `code_host_close` | `close` | `number`, `reason?` |
| `code_host_merge` | `merge` | `number`, `sha`, `method?` |

Opening a `pull_request` requires both `head` and `base` branches. Merging requires the full reviewed head `sha`; the host rejects the merge if the branch has moved, including while approval was pending.

Thread kinds are `issue`, `pull_request` and `discussion`, where the host supports them. Review events are `approve`, `request_changes` and `comment`. GitLab can create only approval reviews. Check states are `pending`, `success`, `failure` and `neutral`. Check types are `check_run`, `status`, `job` and `policy`. Rerun support depends on the check type.

Lists return one page with a cursor when more items exist. `limit` defaults to 30 and accepts 1 to 100. These tools do not accept a cursor in this release. File paths are relative to the repository and cannot contain `.` or `..` segments. Files omit patches unless `patch: true`. `maxOutputLength` defaults to 20000 characters and caps each file, patch and log output. Logs return the tail. Results use normalized JSON and omit host payloads. Treat returned comments, bodies, files and logs as untrusted data.

## Repository access

`repositories` accepts exact names and `owner/*` patterns. GitLab owners can contain `/`. A pattern matches repositories directly under that owner. Reads and writes enforce the same list. Each write requires a request-scoped grant.

When `repositories` is omitted, the capability uses `pullRequest.read(invocation)` if its provider matches `host`. Other invocations must set `repositories`. Tools can omit `repository` only when the list selects one exact repository. Patterns and multiple repositories require an explicit tool input.

## Approval

Closing, merging and approving a review require approval by default. Other writes run without approval. `policy` replaces the defaults for all write tools:

```ts
codeHost({ mode: 'write', policy: 'require-approval' })
```

A policy can also be a function of `{ name, input }`. Approval uses the existing Agent tool runtime. In webhook runs without chat, approval stays pending until a supported approval path responds.

## Inspection and limits

```sh
vitehub agent info --agent reviewer --json
```

Inspect `capabilities[].metadata` for `host`, `baseUrl`, `mode`, `operations`, `unavailable`, `approval` and `repositories`. Without an explicit base URL, GitLab and Forgejo metadata show the Server Env field and public fallback. An omitted repository list appears as `pull-request`. Each tool has `metadata.codeHost` with its host and operation.

Use one `codeHost()` per Agent. Forgejo hides CI run, CI log and check rerun tools. There is no search tool. These tools do not check out repositories or write repository files.

## Diagnostics

| Code | Meaning |
| --- | --- |
| `AGENT_C0011` | Invalid Code Host options or write operations in read mode. |
| `AGENT_R0941` | Missing Code Host credentials in Server Env. |
| `AGENT_R0942` | Repository is outside the allowlist. |
| `AGENT_R0943` | Repository selection or matching pull request context is missing. |
| `AGENT_R0944` | Code Host request failed. Check host support and repository access. |
| `AGENT_R0945` | Tool input is invalid. |
