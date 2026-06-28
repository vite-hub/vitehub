---
title: Pull Request context
description: Record normalized Change Request invocation context and expose it as a Workspace file.
navigation.title: Pull Request context
navigation.order: 120
navigation.group: External context
icon: i-lucide-git-pull-request
---

`pullRequestContext()` records a normalized Pull Request or Change Request value for the Agent Invocation.
Use it when a trigger, webhook, or host already knows which Change Request started the Agent run.

## Installation

Import the Capability factory from `@vite-hub/agent/capabilities` and add it to `defineAgent({ capabilities })`.
Add a Workspace when Workspace-aware tools or runner code should read the generated context file.

## What it adds

The Capability stores the value in Agent Invocation Context under `pullRequest` by default.
When the Agent has a Workspace, it also adds a lazy Live Source at `pull-request-context/context.md`.

The file is markdown with frontmatter for common fields such as `repository`, `number`, `provider`, `baseRef`, `headRef`, `actor`, and `deliveryId`.

## Configuration

```ts [server/agents/reviewer.ts]
import { defineAgent } from '@vite-hub/agent'
import { pullRequestContext } from '@vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model },
  workspace,
  capabilities: [
    pullRequestContext({
      context: {
        number: 42,
        provider: 'github',
        repository: 'acme/app',
      },
    }),
  ],
})
```

## Runtime behavior

`pullRequestContext()` does not fetch provider data.
It only records the normalized context value supplied by the caller and exposes it as Workspace context for the Agent.

Apps can render their own review summary, Markham file, or report from `pull-request-context/context.md`.
Use `repositoryHost()` separately when the Agent needs to read comments, files, checks, statuses, or other provider-hosted repository data.

## Requirements

Context-only usage does not require a Workspace.
Explicit custom `sources` or `rules` require a Workspace because they contribute Workspace inputs.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Can inspect the Workspace file through Workspace-aware tools. |
| Harness-backed | Can inspect the generated file through normal Workspace paths. |
| Custom-run-backed | Can read the invocation context value directly through `context.get('pullRequest')`. |

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `context` | `PullRequestContextValue \| function` | none | Normalized Change Request context supplied by the trigger or caller. |
| `contextKey` | `string` | `"pullRequest"` | Agent Invocation Context key used to store the value. |
| `sources` | `Record<string, WorkspaceSourceInput> \| function` | none | Extra Workspace Sources to merge with the default context Source. |
| `rules` | `WorkspaceRules \| function` | none | Workspace rules contributed with the context Source. |
| `triggers` | `Record<string, AgentTriggerDefinition>` | none | Trigger contributions tied to this context. |

## Inspect and verify

Read `pull-request-context/context.md` from the Workspace.
Confirm the frontmatter matches the trigger payload and that provider data is only available when a separate Capability supplies it.

## Reference

- [Repository host](/docs/capabilities/repository-host)
- [Workspace and Sources](/docs/concepts/workspace-and-sources)
- Source: `packages/agent/src/capabilities/pull-request-context.ts`
