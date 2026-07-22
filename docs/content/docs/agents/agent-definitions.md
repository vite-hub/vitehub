---
title: Agent Definitions
description: Declare one Agent, its Agent Driver, Capabilities, Workspace, and trusted invocation boundaries.
navigation.order: 21
icon: i-lucide-file-user
---

An Agent Definition is the code declaration that names one Agent and configures how it runs. It owns the Agent Driver, optional Box, attached Capabilities, Workspace context, Agent Actor configuration, Channels, and lifecycle hooks.

ViteHub discovers Agent Definitions from `server/agents`. The Agent File Name or folder name provides the discovered identity, so `server/agents/support.ts` and `server/agents/support/agent.ts` both create a `support` Agent.

Discovered Agent Definitions run as Workflows by default, and ViteHub selects the Workflow provider from the active host integration. Direct `runAgent()` calls using that discovery-default binding remain inline without a discovered host identity. Use `runtime: false` when a hosted Agent must also complete inline, or `runtime: workflow('name')` when direct and hosted calls should use that named Workflow identity.

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

## Agent Definition options

`defineAgent()` requires `driver` and accepts the following top-level fields.

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `driver` | `AgentDriver` | Required | Selects exactly one model, harness, or custom-run execution path. |
| `box` | `BoxDefinition` | None | Gives a harness driver an explicit execution environment, Home, checkout, and requirements. A Box replaces `driver.sandbox` and `driver.workDir`. |
| `capabilities` | `AgentCapabilitiesInput` | `[]` | Attaches a static Capability list or an invocation-time resolver. |
| `channels` | `Record<string, AgentChannelInput>` | None | Declares named Channel factories or definitions for reachability and delivery. |
| `cli.capabilities` | `boolean` | `true` | Enables or disables Capability-contributed Agent CLI commands for this Definition. |
| `description` | `string` | None | Adds human-readable metadata for discovery and inspection. |
| `hooks` | Agent, Capability, and observer hook map | None | Registers `agent:input`, `agent:finish`, Capability lifecycle, or `hook:observe` callbacks. |
| `invoker` | `AgentInvokerOptions` | None | Configures Agent Actor profiles and resolution through the current `invoker`-named API. |
| `messages` | `AgentMessageChannelSettings` | Channel defaults | Applies shared message delivery, concurrency, session, state, and transcript settings across adapter-backed Channels. |
| `name` | `string` | Discovered identity | Supplies an explicit Definition name for direct metadata and Workspace naming. Discovered host identity still comes from the file or folder path. |
| `output` | `AgentOutputDefinition` | None | Decodes and validates structured Agent output with a Standard Schema. |
| `runtime` | `false \| workflow(name?)` | Discovered Workflow | Disables hosted Workflow execution or selects an explicit Workflow binding. Direct calls without discovered Agent identity remain inline. |
| `runEvents` | `AgentRunEvents` | None | Publishes and reads durable events scoped to the current Agent Invocation run. |
| `version` | `string` | None | Adds a Definition version to generated and Agent inspection metadata. |
| `workspace` | `WorkspaceAgentWorkspaceConfig` | None | References a named Workspace or declares an Agent-owned Workspace and access mode. |

The resolved `AgentDefinition` also exposes runtime-owned `resolve()` and, when applicable, `run()`. Those are outputs of `defineAgent()`, not additional authoring fields.

## Declare structured output

Set `output.schema` when server code needs a typed value instead of provider result plumbing. The schema uses [Standard Schema](https://standardschema.dev/), so the Agent Invocation decodes the final JSON, validates it once, and returns the inferred output value.

```ts [server/agents/summary.ts]
import { defineAgent } from '@vite-hub/agent'
import { codexDriver } from '@vite-hub/agent/harness/codex'
import { object, string } from 'valibot'

const summaryOutput = object({
  summary: string(),
  title: string(),
})

export default defineAgent({
  driver: codexDriver(),
  output: { schema: summaryOutput },
})
```

Harness Agent Drivers receive a JSON-only output instruction. When the validator also implements Standard JSON Schema, ViteHub includes that JSON Schema as model guidance; Standard Schema validation remains the runtime authority either way. Invalid JSON and schema failures throw `AgentOutputValidationError` with distinct `AGENT_OUTPUT_INVALID_JSON` and `AGENT_OUTPUT_SCHEMA_INVALID` codes. Messages are fixed; parser and schema diagnostics remain available through the non-serialized `cause`.

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

When trusted invocation context decides which Agent Definition abilities apply, make `capabilities` a callback. ViteHub resolves the Agent Actor first and uses the returned list for that invocation; Capabilities contributed by the active Channel still compose normally.

```ts [server/agents/support.ts]
export default defineAgent({
  driver: { model },
  capabilities: ({ actor }) => [
    customerRecords,
    ...(actor.meta?.support === true ? [internalDiagnostics] : []),
  ],
})
```

The callback also receives the invocation input and runtime handles. Capabilities that contribute Agent Triggers, chat admission, or static Workspace Sources must stay in a static array because ViteHub registers those contributions before an invocation starts.

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

## Configure Agent Actors

An Agent Actor carries trusted caller identity for one invocation. The current configuration field and helper are named `invoker` and `defineAgentInvoker()`. Resolved callbacks receive the same Actor as both `actor` and `invoker`.

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
        kind: 'developer',
        label: 'Support developer',
        meta: { scope: 'support' },
      },
    ],
  }),
})
```

Agent Actors are not Channels, Auth Users, or Access roles. Those systems can produce or consume an Actor, but they do not replace its trusted invocation identity.

## Next steps

- Read [Agent Drivers](/docs/agents/agent-drivers) for the driver variants.
- Read [Boxes](/docs/agents/boxes) when a harness Agent needs an explicit execution environment.
- Read [Workspace context](/docs/agents/workspace-context) before exposing files.
- Read [Agent Actors](/docs/agents/actors) for trusted caller profiles and exact `invoker` API names.
- Read [Capabilities](/docs/capabilities) for official and custom ability pages.
