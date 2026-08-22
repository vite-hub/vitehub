---
title: Repository host
description: Expose provider-hosted repository, Change Request, issue, comment, check, and status data.
navigation.title: Repository host
navigation.order: 125
navigation.group: External context
icon: i-lucide-git-pull-request
---

`repositoryHost()` gives an Agent a provider-neutral Repository Host Capability.
Use it when the Agent needs GitHub, GitLab, Bitbucket, or another repository host through a configured client.

Provide a client directly or configure a `repository-host` primitive.

The Capability adds `repository_host_read` in read mode.
In write mode it also adds `repository_host_write` for comments and reactions through the configured Repository Host client.

## Configure repository tools

```ts [server/agents/reviewer.ts]
import { defineAgent } from 'vite-hub/agent'
import { repositoryHost } from 'vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model },
  capabilities: [
    repositoryHost({
      client: githubRepositoryHostClient,
      mode: 'read',
      provider: 'github',
    }),
  ],
})
```

## How repository tools work

`repository_host_read` accepts normalized operations for repositories, Change Requests, Change Request files, issues, comments, checks, and statuses.
Operations that target a single Change Request, issue, comment, check, or status require `target.id`.

`repository_host_write` requires write mode and a client with `write()`.
Comment writes require a `body`; all writes require a target id.
Supported writes are allowed by default after the developer enables write mode. Set an explicit policy when comments or reactions need approval or must be denied at runtime.

## Requirements

When `client` is omitted, ViteHub requires a configured `repository-host` primitive.
The client must expose `read()`, and write mode also requires `write()` before the write tool can succeed.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Receives `repository_host_read`, plus `repository_host_write` in write mode. |
| Provider-backed | Receives Repository Host tools through the provider MCP bridge. |
| Custom-run-backed | Can use the configured client directly through runtime context if the runner owns that behavior. |

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `client` | `RepositoryHostClient \| function` | primitive | Provider client with `read()` and optional `write()`. |
| `mode` | `"read" \| "write"` | `"read"` | Adds `repository_host_write` when set to `"write"`. |
| `policy` | `AgentToolPolicyDecision \| function` | `"allow"` | Policy for `repository_host_write`. |
| `provider` | `"github" \| "gitlab" \| "bitbucket" \| string` | client provider | Provider metadata for inspection. |

## Verify repository tools

Run `vitehub agent info --agent <name> --json` and inspect the resolved tool list.
Read one repository or Change Request through `repository_host_read`, then verify read mode exposes no write tool. When using an explicit approval policy, verify that posting comments or reactions requests approval.

## Related pages

- [Custom capabilities](/docs/capabilities/custom-capabilities)
- [Agent triggers](/docs/agents/triggers)
