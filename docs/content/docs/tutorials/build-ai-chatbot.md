---
title: Build an AI Agent with ViteHub
description: >-
  Learn how ViteHub separates Agent behavior, Capabilities, and Workspace
  context while building a small support chat Agent.
date: 2026-05-11
image: /images/tutorials/source-aware-chatbot.png
authors:
  - name: onmax
    avatar:
      src: https://github.com/onmax.png
    to: https://github.com/onmax
navigation.title: AI Agent
navigation.order: 1
icon: i-lucide-message-circle-code
frameworks: [vite, nitro]
---

Most AI apps start as a model call inside a route. Then the useful parts arrive:
chat history, tools, files, local debugging, evals, and a runtime that can ship
beyond your laptop. Without a framework, that logic spreads across handlers,
adapters, prompts, and helper scripts.

ViteHub keeps the agent in one place. A single Agent file declares the model,
instructions, Capabilities, and Workspace Sources the agent needs. You compose
the pieces you want instead of writing a custom orchestration layer for every
new assistant.

That is the developer experience this post introduces. You will build a small
support Agent, give it a Chat Capability, connect one Workspace Source, and test
the whole loop in DevTools before turning the important behavior into an eval.

## One file, three layers

By the end, `server/agents/support/config.ts` contains the complete Agent. These
are the three layers inside that file:

- **Agent**: the server-side actor that owns model behavior, instructions, and
  each Agent Invocation.
- **Capabilities**: opt-in abilities such as chat, workspace inspection,
  storage, web search, or your own tools.
- **Workspace**: the file tree and Sources an Agent can inspect or mutate when
  you explicitly allow it.

The support chat example is small on purpose. The important part is not the
chatbot. The important part is that the Agent stays readable as you add behavior,
abilities, and context.

## Prerequisites

- Node 20.19+ or Node 22.12+.
- `pnpm`
- a model provider key for the AI SDK Gateway model you choose

## Install the ViteHub pieces

Install the packages used in this post:

```bash [Terminal]
pnpm add @vitehub/agent @vitehub/workspace
pnpm add @vitehub/devtools @ai-sdk/gateway ai
pnpm add -D @vitejs/devtools
```

Register the integrations for your framework:

::fw{id="vite:dev vite:build"}
```ts [vite.config.ts]
import { hubAgent, hubChatDevtools } from '@vitehub/agent/vite'
import { hubDevtools } from '@vitehub/devtools'
import { hubWorkspace } from '@vitehub/workspace/vite'
import { DevTools } from '@vitejs/devtools'
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'

export default defineConfig(async () => ({
  plugins: [
    ...(await DevTools()),
    hubDevtools(),
    hubWorkspace(),
    hubAgent(),
    hubChatDevtools(),
    nitro(),
  ],
}))
```
::

::fw{id="nitro:dev nitro:build"}
```ts [nitro.config.ts]
import { defineNitroConfig } from 'nitro/config'

export default defineNitroConfig({
  modules: [
    '@vitehub/workspace/nitro',
    '@vitehub/agent/nitro',
  ],
})
```
::

## Create the Agent

An Agent is the server-side definition ViteHub discovers and runs. Create
`server/agents/support/config.ts` with one model, one instruction, and one Chat
Capability.

```ts [server/agents/support/config.ts]
import { gateway } from '@ai-sdk/gateway'
import { chat, defineAgent } from '@vitehub/agent'

export default defineAgent({
  capabilities: [
    chat(),
  ],
  instructions: 'Answer support questions in a short, concrete style.',
  model: gateway('openai/gpt-5.1-mini'),
})
```

This file already shows the first two layers:

- `defineAgent()` declares the Agent.
- `chat()` attaches the Chat Capability.

The model and instructions belong to the Agent. Chat behavior stays in the
Capability. Every message from DevTools or an API route becomes an Agent
Invocation against this definition.

## Add Workspace context

Models should not guess from memory when your own files contain the answer. Add a
small support note next to the Agent:

```md [server/agents/support/workspace/support.md]
# Support notes

Refunds are available within 30 days when the order has not shipped.
```

Now declare a Workspace Source and attach the Workspace Shell Capability:

```ts [server/agents/support/config.ts]
import { gateway } from '@ai-sdk/gateway'
import { chat, defineAgent } from '@vitehub/agent'
import { workspaceShell } from '@vitehub/agent/capabilities'
import { source } from '@vitehub/workspace'

export default defineAgent({
  workspace: {
    sources: {
      support: source.file('support.md'),
    },
  },
  capabilities: [
    chat({
      history: {
        source: 'thread',
        maxMessages: 20,
      },
    }),
    workspaceShell(),
  ],
  instructions: [
    'Answer from the workspace sources.',
    'If the sources do not contain the answer, say so.',
  ],
  model: gateway('openai/gpt-5.1-mini'),
})
```

Two things happen here, and they stay separate. `workspace.sources` mounts
`support.md` as source context. `workspaceShell()` exposes a read-only workspace
tool so the model can inspect that context during the invocation.

A Workspace does not automatically become model context just because it exists.
You can add more Sources without changing the model loop, and you can choose
which Capabilities expose which runtime abilities.

## Test the loop in DevTools

::fw{id="vite:dev vite:build"}
Run the app:

```bash [Terminal]
pnpm dev
```

Open Vite DevTools, choose **ViteHub**, then open **Chat**. Select the
`support` Agent and ask:

```txt
What is our refund policy?
```

The Agent should stream a reply that mentions the 30-day refund window. The
DevTools timeline also shows the workspace tool calls that happen before the
answer.
::

::fw{id="nitro:dev nitro:build"}
Run the app:

```bash [Terminal]
pnpm dev
```

The Chat DevTools feature is registered through the Vite DevTools integration.
For a Nitro-only app, keep the same Agent Definition and use an HTTP route or an
Agent Eval for non-interactive verification.
::

DevTools is the fast local inspection loop. Once the answer looks right, turn the
expectation into an Agent Eval:

```ts [server/agents/support/eval.ts]
import { defineEval, textContains } from '@vitehub/agent/eval'

export default defineEval({
  scenarios: [
    {
      name: 'answers refund policy',
      input: {
        prompt: 'What is our refund policy?',
      },
      scorers: [
        textContains('30 days'),
      ],
    },
  ],
})
```

The eval imports the sibling Agent Definition by convention, runs the same Agent
Invocation path, and scores the text output. Use evals for behavior you want to
protect, not for every prompt you try manually.

## What to remember

The support Agent is small, but it shows the core ViteHub shape:

- The Agent owns model behavior.
- Capabilities define what it can do.
- The Workspace supplies named source context.
- DevTools explains a live invocation.
- Agent Evals protect behavior that should stay stable.

From here, you can add more Sources, attach more Capabilities, or move the same
Agent toward a hosted runtime without changing the core definition.

## Next steps

::u-page-grid{class="pb-2"}
  :::u-page-card
  ---
  title: Agent
  description: Customize model runs, routes, triggers, usage telemetry, and Agent Evals.
  icon: i-lucide-bot
  to: ../agent
  ---
  :::
  :::u-page-card
  ---
  title: Workspace
  description: Add file, glob, fetch, and GitHub Sources to the Workspace file tree.
  icon: i-lucide-folder-git-2
  to: ../workspace
  ---
  :::
  :::u-page-card
  ---
  title: Cloudflare
  description: Deploy ViteHub features to Cloudflare-backed runtime primitives.
  icon: i-simple-icons-cloudflare
  to: ../providers/cloudflare
  ---
  :::
  :::u-page-card
  ---
  title: Vercel
  description: Deploy ViteHub features to Vercel-backed runtime primitives.
  icon: i-simple-icons-vercel
  to: ../providers/vercel
  ---
  :::
::
