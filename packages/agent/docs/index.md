---
title: Agent
description: Define model and tool-loop agents for Vite and Nitro apps.
navigation.title: Overview
navigation.order: 0
icon: i-lucide-bot
frameworks: [vite, nitro]
---

`@vitehub/agent` defines server-side agents. An agent owns model instructions, model-facing capabilities, and the run or stream call that produces a response. It consumes `@vitehub/runtime` capabilities when it needs host resources.

Use Agent when a server feature needs a model loop with ViteHub message input.

```ts [server/agents/triager.ts]
import { defineAgent, type AgentToolDefinition } from '@vitehub/agent'
import { getMessageText } from '@vitehub/agent'

const classifyTicket: AgentToolDefinition<{ message: string }, { queue: string; priority: string }> = {
  name: 'classifyTicket',
  description: 'Classify a support request before queue handoff.',
  policy: ({ input }) => {
    const message = typeof input === 'object' && input && 'message' in input
      ? String(input.message)
      : ''

    return /refund|invoice|payment/i.test(message) ? 'require-approval' : 'allow'
  },
}

export default defineAgent({
  description: 'Triage support requests and prepare a queue handoff.',
  async run({ input }) {
    const latest = input.messages?.at(-1)
    const message = latest ? getMessageText(latest) : ''

    return {
      raw: { tool: classifyTicket.name },
      text: `Classify and route: ${message}`,
    }
  },
})
```

## What Agent owns

::card-group
  :::card
  ---
  icon: i-lucide-bot
  title: Agent definitions
  ---
  Keep model instructions, capabilities, and custom run behavior in `defineAgent()`.
  :::

  :::card
  ---
  icon: i-lucide-messages-square
  title: Message input
  ---
  Accept `@vitehub/agent` input and convert it to model calls inside Agent.
  :::

  :::card
  ---
  icon: i-lucide-route
  title: Optional routes
  ---
  Expose discovered agents over HTTP only when you enable generated routes.
  :::
::

## What Agent does not own

Agent does not own chat webhooks, Chat SDK adapters, workflow runs, runtime capability registration, or sandbox lifecycle. Use the package that owns each boundary:

| Need | Use |
| --- | --- |
| Receive Slack, Discord, Telegram, or Teams events | `@vitehub/agent/chat` |
| Store or replay conversation state | `@vitehub/agent` |
| Resolve shared capabilities, approvals, and trace context | `@vitehub/runtime` |
| Coordinate durable work | `@vitehub/workflow` |
| Execute isolated code | `@vitehub/sandbox` |

## Start here

::u-page-grid{class="pb-2"}
  :::u-page-card
  ---
  title: Quickstart
  description: Register Agent and define a first discovered agent.
  to: ./quickstart
  ---
  :::
  :::u-page-card
  ---
  title: Usage
  description: Discover agents, expose routes, customize runs, and bind Chat to Agent.
  to: ./usage
  ---
  :::
  :::u-page-card
  ---
  title: Runtime API
  description: Review exports, runtime context, module options, and handler input.
  to: ./runtime-api
  ---
  :::
  :::u-page-card
  ---
  title: Troubleshooting
  description: Fix missing routes, unknown agents, model errors, and duplicate ownership.
  to: ./troubleshooting
  ---
  :::
::
