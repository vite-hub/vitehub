---
title: Agents
description: Define server-side Agents with Agent Drivers, Capabilities, invocations, workspace context, and inspection.
navigation.title: Overview
navigation.order: 20
icon: i-lucide-bot
---

An Agent is a named server-side actor that receives input and runs through an Agent Driver. Use Agents when a feature needs model execution, harness execution, custom agent code, Capabilities, Agent Triggers, Workspaces, Chat History, evals, or DevTools inspection.

An Agent Definition keeps those boundaries visible in one file. The driver decides how one Agent Invocation is processed, while Capabilities add named abilities such as chat, Workspace shell access, storage, web search, or input commands.

## Agent Definition shape

Define the driver first, then attach the abilities and context the Agent needs.

```ts [server/agents/support/config.ts]
import { gateway } from '@ai-sdk/gateway'
import { defineAgent } from '@vite-hub/agent'
import { workspaceShell } from '@vite-hub/agent/capabilities'
import { source } from '@vite-hub/workspace'

export default defineAgent({
  driver: {
    model: gateway('openai/gpt-5.1-mini'),
    instructions: [
      'Answer support questions from the connected workspace.',
      '{{ workspace.sources }}',
      '{{ capabilities }}',
    ],
  },
  workspace: {
    sources: {
      support: source.file({
        path: 'support.md',
        instructions: 'Use this source for support policies and known answers.',
      }),
    },
  },
  capabilities: [
    workspaceShell({ mode: 'read' }),
  ],
})
```

The discovered Agent identity comes from the file or folder name under `server/agents`. `server/agents/support/config.ts` creates the `support` Agent.

## How the pieces fit

| Concept | Responsibility |
| --- | --- |
| Agent Definition | Declares one Agent, its Agent Driver, Capabilities, Workspace, hooks, and Agent Invoker options. |
| Agent Driver | Selects model-backed, harness-backed, or custom-run-backed execution for each Agent Invocation. |
| Capability | Adds a named ability and may contribute triggers, tools, instructions, policy, or context values. |
| Agent Invocation | Runs one request through the selected Agent Definition and records lifecycle state. |
| Agent Invoker | Carries the trusted caller identity for one Agent Invocation. |
| Channel | Names origin, events, delivery, and message facts. It does not replace Agent Invoker identity. |
| Workspace | Exposes a scoped file tree and Sources for the Agent to inspect or mutate when allowed. |

## Agents and server primitives

Agents can use server primitives, but they do not replace them. Server code can call Runtime Helpers directly because the developer wrote that code. A model or harness receives access only through an explicit Capability or Driver boundary.

## Next steps

- Read [Agent Definitions](/docs/agents/agent-definitions) for the declaration shape.
- Read [Agent Drivers](/docs/agents/agent-drivers) to choose `driver.model`, `driver.harness`, or `driver.run`.
- Read [Capabilities](/docs/capabilities) before exposing model-facing abilities.
