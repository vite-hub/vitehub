---
title: Agents
description: Define model-backed server actors with instructions, invocations, triggers, workspaces, and capabilities.
navigation.title: Overview
navigation.order: 20
icon: i-lucide-bot
---

Agents are the ViteHub path for model-backed server actors. Use agents when the feature needs instructions, model execution, tools, workspace context, triggers, evaluations, or model-facing capabilities.

If you only need KV, Database, Blob, Queue, Workflow, Schedule, Sandbox, Workspace, or Env from ordinary app code, start with [Server primitives](/docs/server-primitives).

## Agent model

An Agent Definition declares one Agent. An Agent Invocation runs that Agent once. Capabilities attach controlled abilities to the Agent.

```ts [server/agents/support.ts]
import { gateway } from '@ai-sdk/gateway'
import { defineAgent } from '@vite-hub/agent'
import { workspaceShell } from '@vite-hub/agent/capabilities'

export default defineAgent({
  instructions: 'Answer support questions from the connected workspace.',
  model: gateway('openai/gpt-5.1-mini'),
  capabilities: [
    workspaceShell({ mode: 'read' }),
  ],
})
```

## Agent docs map

| Page | Use it for |
| --- | --- |
| [Agent definitions](/docs/agents/agent-definitions) | Define model, instructions, workspace, and capabilities. |
| [Instructions](/docs/agents/instructions) | Compose durable behavior and capability instruction slots. |
| [Invocations](/docs/agents/invocations) | Run, stream, inspect, and finish one Agent Invocation. |
| [Triggers](/docs/agents/triggers) | Start Agent Invocations from server routes, chat, schedules, or product events. |
| [Workspace context](/docs/agents/workspace-context) | Give an Agent source files without granting unrestricted writes. |
| [Capabilities](/docs/agents/capabilities) | Attach official or custom abilities to an Agent. |
| [Evals](/docs/agents/evals) | Test agent behavior with repeatable cases. |
| [DevTools](/docs/agents/devtools) | Inspect invocations, tools, workspace access, and traces during development. |

## Agents are not server primitives

Agents can use server primitives, but they do not replace them. The difference is authority.

Server code can call a Runtime Helper directly because the developer wrote that code. A model should only receive model-facing tools, instructions, or runtime context through an explicit Capability.
