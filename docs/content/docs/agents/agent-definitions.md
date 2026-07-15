---
title: Agent Definitions
description: Declare one Agent, its Agent Driver, Capabilities, Workspace, and trusted invocation boundaries.
navigation.order: 21
icon: i-lucide-file-user
---

An Agent Definition is the code declaration that names one Agent and configures how it runs. It owns the Agent Driver, optional Box, attached Capabilities, Workspace context, Agent Invoker options, and lifecycle hooks.

ViteHub discovers Agent Definitions from `server/agents`. The Agent File Name or folder name provides the discovered identity, so `server/agents/support.ts` and `server/agents/support/agent.ts` both create a `support` Agent.

Discovered Agent Definitions run as Workflows by default, and ViteHub selects the Workflow provider from the active host integration. Direct `runAgent()` calls without a discovered host identity remain inline. Use `runtime: false` when a hosted Agent must also complete inline, or `runtime: workflow('name')` when it needs a Workflow identity that differs from its discovered Agent identity.

## Define the Agent

Start with one Agent Driver. A model-backed Agent uses `defineAgent({ driver: { model } })` and keeps model-facing instructions inside the driver object.

```ts [server/agents/support.ts]
import { gateway } from '@ai-sdk/gateway'
import { defineAgent } from '@vite-hub/agent'

export default defineAgent({
  driver: {
    model: gateway('openai/gpt-5.1-mini'),
    instructions: 'Answer support requests with short, concrete replies.',
  },
})
```

The driver object accepts exactly one concrete variant: `model`, `harness`, or `run`. Driver-specific options stay beside that variant key.

## Attach Capabilities

Capabilities add named abilities. They are the public way to expose model-facing tools, triggers, policy, metadata, and context values. Put free-form guidance for those abilities in Agent Driver Instructions or deterministic imported instruction Markdown.

```ts [server/agents/support.ts]
import { gateway } from '@ai-sdk/gateway'
import { defineAgent } from '@vite-hub/agent'
import { webSearch, workspaceShell } from '@vite-hub/agent/capabilities'

export default defineAgent({
  driver: {
    model: gateway('openai/gpt-5.1-mini'),
    instructions: [
      'Answer from project context first.',
      'Use web search only when the workspace does not contain the answer.',
    ],
  },
  capabilities: [
    workspaceShell({ mode: 'read' }),
    webSearch({ mode: 'tool' }),
  ],
})
```

Tools are contributed by Capabilities. They are not top-level Agent Definition fields.

When trusted invocation context decides which Agent Definition abilities apply, make `capabilities` a callback. ViteHub resolves the Agent Invoker first and uses the returned list for that invocation; Capabilities contributed by the active Channel still compose normally.

```ts [server/agents/support.ts]
export default defineAgent({
  driver: { model },
  capabilities: ({ actor }) => [
    customerRecords,
    ...(actor.meta?.support === true ? [internalDiagnostics] : []),
  ],
})
```

The callback also receives the invocation input and runtime handles. Capabilities that contribute Agent Triggers, chat admission or attachments, or static Workspace Sources must stay in a static array because ViteHub registers those contributions before an invocation starts.

## Add Workspace context

Workspace context gives the Agent a file tree and Sources. The Workspace owns file visibility, while Capabilities decide whether the active Agent Driver receives model-facing tools or other driver-compatible inputs.

```ts [server/agents/docs/agent.ts]
import { gateway } from '@ai-sdk/gateway'
import { defineAgent } from '@vite-hub/agent'
import { workspaceShell } from '@vite-hub/agent/capabilities'
import { glob } from '@vite-hub/workspace'

export default defineAgent({
  driver: {
    model: gateway('openai/gpt-5.1-mini'),
    instructions: [
      'Answer from the docs workspace.',
      'Use the docs Source for public product behavior.',
    ],
  },
  workspace: {
    sources: {
      docs: glob({
        cwd: '.',
        include: ['README.md', 'docs/**/*.md'],
      }),
    },
  },
  capabilities: [
    workspaceShell({ mode: 'read' }),
  ],
})
```

Use a writable Workspace Capability only when the product expects the Agent to change Workspace files. Start with read access when the Agent only needs context.

## Configure trusted callers

Agent Invoker options define trusted caller profiles and optional resolution logic. The resolved Agent Invoker becomes `context.invoker` for Agent and Capability callbacks.

```ts [server/agents/support.ts]
import { gateway } from '@ai-sdk/gateway'
import { defineAgent, defineAgentInvoker } from '@vite-hub/agent'

export default defineAgent({
  driver: {
    model: gateway('openai/gpt-5.1-mini'),
    instructions: 'Answer support requests.',
  },
  invoker: defineAgentInvoker({
    profiles: [
      {
        id: 'dev-support',
        kind: 'devtools',
        label: 'Support developer',
        meta: { scope: 'support' },
      },
    ],
  }),
})
```

Agent Invokers are not Channels, Auth Users, or Access roles. They carry trusted invocation identity that those systems may produce or consume.

## Next steps

- Read [Agent Drivers](/docs/agents/agent-drivers) for the driver variants.
- Read [Boxes](/docs/agents/boxes) when a harness Agent needs an explicit execution environment.
- Read [Workspace context](/docs/agents/workspace-context) before exposing files.
- Read [Capabilities](/docs/capabilities) for official and custom ability pages.
