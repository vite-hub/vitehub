---
title: Repository host context
description: Read issue and Change Request context through a lazy async record.
navigation.title: Repository host context
navigation.order: 120
navigation.group: External context
icon: i-lucide-git-pull-request
---

`repositoryHostContext()` records repository-host context for one Agent Invocation.
Use it when a trigger, webhook, or host knows the current issue or Change Request and runtime code should read the related provider data on demand.

## Installation

Import the Capability factory from `@vite-hub/agent/capabilities` and add it to `defineAgent({ capabilities })`.
Provide a Repository Host client directly, or configure a `repository-host` primitive for the invocation.

## What it adds

The Capability stores an async record in Agent Invocation Context under `repositoryHost` by default.
The record exposes `keys()`, `has(key)`, `get(key)`, `pick(keys)`, `entries(keys?)`, and `resolveAll()`.

Each key loads only when caller code requests it.
ViteHub caches in-flight and successful key loads for the current record, so repeated `get('comments')` calls reuse the same request.

The default keys are `issue`, `pullRequest`, `body`, `labels`, `comments`, and `files`.
Known keys that do not apply return `undefined`.
Unknown keys throw an error.

## Configuration

```ts [server/agents/reviewer.ts]
import { defineAgent } from '@vite-hub/agent'
import { repositoryHostContext } from '@vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model },
  capabilities: [
    repositoryHostContext({
      client: githubRepositoryHostClient,
      materialize: './PULL_REQUEST.template.md',
      target: {
        repo: 'acme/app',
        number: 42,
      },
    }),
  ],
})
```

## Read context

Read the async record from invocation context when hooks, custom runners, or host code need repository-host data.
The caller owns presentation and decides whether to render Markdown, JSON, or another format.

```ts [server/agents/reviewer.ts]
import { repositoryHostContext } from '@vite-hub/agent/capabilities'

const host = repositoryHostContext.read(ctx)

const keys = await host.keys()
const issue = await host.get('issue')
const pullRequest = await host.get('pullRequest')
const comments = await host.get('comments')
const labels = await host.get('labels')
```

Use `resolveAll()` when code needs a plain object with every available key.
The async record is not a JSON container, and `JSON.stringify(host)` throws instead of silently resolving async values.

## Target resolution

For GitHub, `repositoryHostContext()` reads the issue shape first.
When the issue includes pull request metadata, the record also exposes Change Request data through `pullRequest` and `files`.

```ts [server/agents/reviewer.ts]
repositoryHostContext({
  client: githubRepositoryHostClient,
  target: { repo: 'acme/app', number: 42 },
})

repositoryHostContext({
  client: githubRepositoryHostClient,
  target: { repo: 'acme/app', issue: 42 },
})

repositoryHostContext({
  client: githubRepositoryHostClient,
  target: { repo: 'acme/app', pullRequest: 42 },
})
```

V1 supports GitHub issues and pull requests.
Node ids, discussions, actions, and non-GitHub providers are not part of this context record yet.

## Runtime behavior

`repositoryHostContext()` keeps context data-only unless `materialize` is configured.
With `materialize: './PULL_REQUEST.template.md'`, ViteHub bundles the colocated Markdown renderer and writes the resolved context to `PULL_REQUEST.md` in the Agent Workspace.
The generated path preserves directories and case while removing only the final `.template`.

Use `repositoryHost()` separately when a model-backed Agent needs repository-host tools such as `repository_host_read`.
Use `repositoryHostContext()` when trusted runtime code needs a typed invocation context value.

## Requirements

Static context does not require a Repository Host client.
Target-based context requires a client option or a configured `repository-host` primitive.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Does not receive rendered context automatically. Caller code must render selected values into instructions, input, or another model-facing surface. |
| Provider-backed | Receives the configured materialized Markdown file in its Agent Workspace. |
| Custom-run-backed | Can read the async record directly through `repositoryHostContext.read(ctx)`. |

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `client` | `RepositoryHostClient \| function` | primitive | Provider client with `read()`. |
| `context` | `RepositoryHostContextInput \| function` | invocation context | Static issue, Change Request, or selected key values. |
| `contextKey` | `string` | `"repositoryHost"` | Agent Invocation Context key used to store the async record. |
| `id` | `string` | `"repository-host-context"` | Capability id. |
| `materialize` | relative `*.template.md` path | none | Renders resolved context into the matching Workspace `.md` path. |
| `provider` | `"github" \| string` | client provider | Provider guard. V1 accepts GitHub targets. |
| `target` | `RepositoryHostContextTarget \| function` | none | Repository host target such as `{ repo, number }`, `{ repo, issue }`, or `{ repo, pullRequest }`. |
| `triggers` | `Record<string, AgentTriggerDefinition>` | none | Trigger contributions tied to this context. |

## Inspect and verify

Call `keys()` to inspect which values are available for the target.
Call `resolveAll()` in tests when you need to assert the full resolved shape.

## Reference

- [Repository host](/docs/capabilities/repository-host)
- [Agent invocations](/docs/agents/invocations)
- Source: `packages/agent/src/capabilities/repository-host-context.ts`
