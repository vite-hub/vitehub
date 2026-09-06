---
title: Agent Definitions
description: Declare how one Agent runs, what it can use, and how callers reach it.
navigation.order: 21
navigation.group: Core
icon: i-lucide-file-user
---

An Agent Definition is the single configuration object for one Agent. It selects an [Agent Driver](/docs/agents/agent-drivers), attaches Capabilities and Workspace context, and defines any Channels, Actor resolution, hooks, or hosted runtime behavior.

ViteHub discovers definitions in `server/agents`. Both `server/agents/support.ts` and `server/agents/support/agent.ts` create an Agent named `support`.

## Define an Agent

Start with the execution path. This Agent uses ViteHub's built-in Codex Driver:

```ts [server/agents/review.ts]
import { defineAgent } from 'vite-hub/agent'

export default defineAgent({
  description: 'Reviews the current repository change.',
  driver: 'codex',
})
```

The shorthand uses `permissions: 'ask'`. Provider actions request approval unless the Agent Definition opts into another policy.

Use a tagged built-in value when the Driver needs options:

```ts [server/agents/review.ts]
export default defineAgent({
  driver: {
    kind: 'codex',
    model: 'gpt-5.5',
    permissions: 'ask',
  },
})
```

For application-supplied execution, use exactly one structural Driver variant: `{ model }` or `{ run }`.

## Add abilities and context

Capabilities decide which runtime abilities the selected Driver receives. Workspace context decides which files and Sources those abilities can reach.

```ts [server/agents/support/agent.ts]
import { defineAgent } from 'vite-hub/agent'
import { workspaceShell } from 'vite-hub/agent/capabilities'
import { glob } from 'vite-hub/workspace'

export default defineAgent({
  driver: {
    model: 'openai/gpt-5.1-mini',
    instructions: 'Answer from the docs Workspace. Say when the answer is absent.',
  },
  capabilities: [workspaceShell({ mode: 'read' })],
  workspace: {
    sourceRootDir: process.cwd(),
    sources: {
      docs: glob({ cwd: '.', include: ['docs/content/**/*.md'] }),
    },
  },
})
```

Declaring a Workspace does not automatically grant model-backed or custom Drivers file access. Provider Drivers receive the selected Workspace as their working directory; Capabilities still control additional tools and invocation behavior.

AI SDK Model Drivers make one output-only correction call when a known tool receives arguments that fail its input schema. The correction cannot select another tool or execute a provider-defined tool. Set `driver.execution.repairToolCall: false` to disable this behavior.

## Extend an Agent

Use `extends` to make one Agent Definition the default for another:

```ts [server/agents/bot-dev/agent.ts]
import { defineAgent } from 'vite-hub/agent'
import bot from '../bot/agent'

export default defineAgent({
  extends: bot,
  driver: { model: 'gpt-5.6-sol' },
  workspace: {
    store: { provider: 'local', root: '.vitehub/workspaces/bot-dev' },
  },
})
```

The child gets a fresh runtime from the parent's configuration. `name` is not inherited; discovery names each Agent from its own file. Configure separate persistent storage when the Agents must keep separate data. An explicitly shared store or adapter remains shared.

Child configuration overrides parent defaults. Channels, Sources, Skills, and hooks merge by key, replacing each matching definition or callback as a whole. Static Capabilities merge by `id`: the child replaces a matching Capability and appends new ones. A Capability resolver replaces the inherited list or resolver. Other arrays replace the parent array. Changing a Driver kind or store provider replaces that configuration.

`extends` accepts one definition created by `defineAgent()` in the same package instance. It does not discover files in the parent's directory. Import shared instructions with `@../bot/instructions.md` and share Skills through explicit Sources or a directory link. Relative file paths resolve from each discovered Agent's directory.

## Return structured output

Set `driver.output` when downstream code needs validated data instead of free-form text.

```ts [server/agents/triage.ts]
import * as v from 'valibot'
import { defineAgent } from 'vite-hub/agent'

export default defineAgent({
  driver: {
    model: 'openai/gpt-5.1-mini',
    instructions: 'Classify the request and explain the next action.',
    output: {
      schema: v.object({
        priority: v.picklist(['low', 'normal', 'urgent']),
        nextAction: v.string(),
      }),
    },
  },
})
```

Inline `runAgent()` execution returns the validated structured result. A schema failure fails the invocation instead of returning unchecked model output. Workflow-backed calls return an `AgentWorkflowRun` after the Workflow starts. Poll `getWorkflowRun(workflowName, run.id)` until its status is `completed`, then read `result` for the validated Agent value. Treat `failed`, `cancelled`, and `unknown` as terminal states instead of waiting indefinitely.

When an AI SDK Model Driver returns invalid native structured output, it makes up to three total attempts by default: the original request and two output-only correction calls. Set `driver.output.maxAttempts` to a positive integer to choose the total attempt limit; `maxAttempts: 1` disables correction calls. Corrections keep the invocation's prepared model and provider route, but they do not replay conversation messages or expose tools, so completed tool effects cannot run again. Tool results remain available as bounded evidence for corrected output. Usage records include every model call, with per-call attribution, aggregate token totals, and aggregate cost when provider metadata or configured pricing supplies it.

Provider Drivers such as `codex` and `claude-code`, and custom-run Drivers, validate their returned output once. They do not accept `maxAttempts` because a second provider session or application callback would replay work instead of performing an output-only Model Driver correction.

## Choose hosted execution

Discovered Agents use the active host's Workflow integration by default. Set `runtime: false` when a hosted Agent must complete inline, or select a named Workflow identity with `runtime: workflow('support')`.

With the implicit discovery-default Workflow binding, direct `runAgent()` calls without a discovered host identity remain inline. An explicit `runtime: workflow('support')` binding starts that named Workflow even for a direct call.

## Definition options

| Option | Purpose |
| --- | --- |
| `extends` | Inherits configuration from one Agent Definition. |
| `driver` | Required unless inherited. Selects one built-in provider, model-backed, or custom-run execution path. |
| `capabilities` | Attaches a static list or invocation-time Capability resolver. |
| `workspace` | Declares or reuses scoped files, Sources, bindings, and access policy. |
| `driver.instructions` | Configures instructions on the selected Driver; see [Instructions](/docs/agents/instructions). |
| `driver.output` | Validates structured Agent output. |
| `channels` | Declares named Agent Channels and generated routes. |
| `messages` | Applies shared delivery, streaming, concurrency, session, and transcript settings to adapter Channels. |
| `invoker` | Configures Agent Actor profiles and resolution using the current API name. |
| `runtime` | Selects inline or Workflow-backed hosted execution. |
| `hooks` | Observes input, completion, failure, Capability lifecycle, or hook execution. |
| `runEvents` | Publishes application-owned progress for an invocation with a stable run id. |
| `name`, `description`, `version` | Adds explicit discovery and inspection metadata. |
| `cli.capabilities` | Enables or disables Capability-contributed CLI commands. |

Use the dedicated pages for option details rather than growing the Definition itself: [Drivers](/docs/agents/agent-drivers), [Channels](/docs/agents/channels), [Actors](/docs/agents/actors), and [Invocations](/docs/agents/invocations).
