---
title: Build a Source-Aware Chatbot with ViteHub
description: Learn how to build a chatbot that connects to your own sources with ViteHub Chat, Workspace, and Agent.
navigation.title: Source-Aware Chatbot
navigation.order: 1
icon: i-lucide-message-circle-code
frameworks: [vite, nitro]
---

Building source-aware chatbots is much easier when each part has a clear job. This guide walks through creating a chatbot with ViteHub Chat, Workspace, and Agent. Each step is explained so you can see how provider events, connected sources, and model execution work together.

## What we're building

By the end of this tutorial, you'll have a `~/support/chat` feature with:

- Provider chat support through ViteHub Chat
- A colocated Workspace Agent at `server/agents/support/chat/config.ts`
- Local and remote source mounts that the agent can inspect with tools
- A clean handoff from chat messages to the `support/chat` agent
- Runtime portability across local development, Vite, Nitro, Cloudflare, and Vercel

The powerful part is that you can connect your chat, bring your own sources, and run the same feature anywhere ViteHub supports. Chat handles platform events. Workspace handles files. Agent handles the model loop.

## Prerequisites

Before we start, make sure you have:

- A Vite or Nitro app
- An AI SDK model configured in your app
- Credentials for the chat provider you want to connect
- Source files that your chatbot should be allowed to inspect

## Project setup

Start by installing the ViteHub packages that own the chat flow:

```bash
pnpm add @vitehub/agent @vitehub/chat @vitehub/messages @vitehub/workspace ai chat
```

### Configuration

Register Workspace, Agent, and Chat in your app. Vite apps use plugins:

::fw{id="vite:dev vite:build"}
```ts [vite.config.ts]
import { hubAgent } from '@vitehub/agent/vite'
import { hubChat } from '@vitehub/chat/vite'
import { hubWorkspace } from '@vitehub/workspace/vite'
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    hubWorkspace(),
    hubAgent(),
    hubChat(),
    nitro(),
  ],
})
```
::

Nitro apps use modules:

::fw{id="nitro:dev nitro:build"}
```ts [nitro.config.ts]
import { defineNitroConfig } from 'nitro/config'

export default defineNitroConfig({
  modules: [
    '@vitehub/workspace/nitro',
    '@vitehub/agent/nitro',
    '@vitehub/chat/nitro',
  ],
})
```
::

Here is what each package does:

::card-group
  :::card
  ---
  icon: i-lucide-message-circle
  title: Chat
  ---
  Receives provider events, resolves the right thread, and posts the answer back to the user.
  :::

  :::card
  ---
  icon: i-lucide-folder-git-2
  title: Workspace
  ---
  Mounts the source files your chatbot can inspect, including local files, remote sources, and inline instructions.
  :::

  :::card
  ---
  icon: i-lucide-bot
  title: Agent
  ---
  Runs the model loop with workspace tools, so answers are based on inspected files instead of hidden prompt context.
  :::
::

This separation is what makes the feature flexible. You can change the chat provider without changing the agent, add sources without changing the webhook, and move runtimes without rewriting the source-aware behavior.

## Building the source-aware agent

This section covers the `~/support/chat` feature itself. In ViteHub, a colocated workspace agent lives at `server/agents/<name>/config.ts`. For this chatbot, create `server/agents/support/chat/config.ts`.

ViteHub discovers this file as the `support/chat` agent and uses the same name for the implicit workspace.

::steps

### Creating the workspace agent

First, define the agent and the files it can inspect:

```ts [server/agents/support/chat/config.ts]
import { defineAgent } from '@vitehub/agent'
import * as source from '@vitehub/workspace/source'

export default defineAgent({
  description: 'Answer support chat messages from connected project sources.',
  workspace: {
    sources: {
      docs: source.glob({
        cwd: process.cwd(),
        include: ['README.md', 'docs/**/*.md'],
      }),
      knowledgeBase: source.glob({
        cwd: process.cwd(),
        include: ['knowledge-base/**/*.md', 'support/**/*.md'],
      }),
      instructions: source.file({
        workspacePath: 'AGENTS.md',
        content: [
          '# Support Chatbot',
          'Answer from inspected workspace evidence.',
          'Say when the connected sources do not contain enough information.',
        ].join('\n'),
      }),
    },
  },
  instructions: async ({ fs }) => await fs.readFile('AGENTS.md'),
  model,
})
```

The `workspace.sources` object is the source map for your chatbot. Each key becomes a mount in the workspace, so the agent can list, search, and read files through tools instead of receiving every source as a large prompt string.

Here is what each part does:

Workspace sources

The `docs`, `knowledgeBase`, and `instructions` entries define the files available to the agent. File-backed sources come from your project, while inline sources are useful for instructions that should travel with the feature.

Agent instructions

The `instructions` function reads `AGENTS.md` from the workspace. This keeps the instructions close to the source tree the agent uses, instead of duplicating them in code.

Model execution

The `model` option is still owned by Agent. Chat does not need to know which model you use, and Workspace does not need to know how the response is generated.

### Connecting remote sources

Local files are a good start. Next, connect remote sources so your chatbot can inspect the same docs, product notes, or repository files your team already uses:

```ts [server/agents/support/chat/config.ts]
export default defineAgent({
  workspace: {
    sources: {
      docs: source.github({
        repo: 'acme/docs',
        ref: 'main',
        root: 'docs',
        materialize: 'lazy',
      }),
      product: source.github({
        repo: 'acme/product',
        ref: 'main',
        root: 'knowledge-base',
        materialize: 'lazy',
      }),
    },
  },
  instructions: 'Use workspace tools before answering product or documentation questions.',
  model,
})
```

Lazy sources are resolved only when the agent needs them. The agent can search the manifest, read the specific file that matters, and leave the rest untouched.

::

## Connect Chat

Now connect the provider-facing chat to the workspace agent. The chat definition receives direct messages and routes them to `support/chat`:

```ts [server/chat.ts]
import { defineChat } from '@vitehub/chat'

export default defineChat({
  adapters: ({ runtimeConfig }) => ({
    telegram: createTelegramAdapter({
      botToken: runtimeConfig.telegram.botToken,
    }),
  }),
  agent: {
    name: 'support/chat',
    history: {
      source: 'thread',
      maxMessages: 20,
    },
  },
  state,
  userName: 'Support Bot',
})
```

The adapter can be Telegram, Slack, Discord, a devtools adapter, or your own Chat SDK adapter. The important boundary is that Chat handles the incoming event and thread response, while Agent handles the model and tools.

Here is what each part does:

Adapters

The `adapters` option connects provider events to Chat SDK. You can start with an existing provider adapter, then replace it later with a custom adapter without touching the agent.

Agent handoff

The `agent` option tells Chat to send direct messages to `support/chat`. The `history` option includes recent thread messages, so follow-up questions keep the conversation context.

State

The `state` adapter stores provider conversation state. On Cloudflare, this can be a Durable Object state adapter. On other runtimes, use a state adapter that works in that environment.

## Building your own adapter

When your chat surface is not one of the default providers, keep the same source-aware agent and swap only the adapter layer:

```ts [server/chat.ts]
export default defineChat({
  adapters: {
    support: createSupportAdapter({
      endpoint: '/api/support/events',
    }),
  },
  agent: 'support/chat',
  state,
  userName: 'Support Bot',
})
```

This is the main advantage of keeping the source-aware behavior in a Workspace Agent. Provider details stay at the edge. Source inspection, instructions, and tools stay in one discovered agent.

## Run locally

Start your app and point the provider webhook at the generated Chat route:

```txt
/api/webhooks/telegram
```

Send a direct message that can be answered from your connected sources. Your chatbot should inspect the workspace, answer in the same thread, and keep the conversation history available for follow-up questions.

For local development, use the Chat DevTools adapter or a real provider webhook tunnel. The feature stays the same either way because the provider adapter is not coupled to the workspace.

## Deploying anywhere

ViteHub keeps the chatbot definition portable by resolving runtime details at the integration layer. The source-aware behavior stays in `server/agents/support/chat/config.ts`, while provider and state details move into the runtime configuration.

::u-page-grid{class="pb-2"}
  :::u-page-card
  ---
  title: Cloudflare
  description: Run Chat webhooks on Workers and store Chat state with Durable Objects.
  icon: i-simple-icons-cloudflare
  to: ../chat/providers/cloudflare
  ---
  :::
  :::u-page-card
  ---
  title: Vercel
  description: Run the same Chat definition through Vercel Functions.
  icon: i-simple-icons-vercel
  to: ../chat/providers/vercel
  ---
  :::
  :::u-page-card
  ---
  title: Workspace
  description: Choose how source files are mounted, cached, and inspected.
  icon: i-lucide-folder-git-2
  to: ../workspace
  ---
  :::
  :::u-page-card
  ---
  title: Agent
  description: Customize model runs, routes, tools, and Chat handoff behavior.
  icon: i-lucide-bot
  to: ../agent
  ---
  :::
::

Use the hosted provider pages when you are ready to configure state bindings, deployment presets, or provider-specific runtime settings.

## Going further

You now have a source-aware chat feature with provider handoff and workspace-backed context. To take it further, consider adding:

More sources

Add product docs, changelogs, support macros, repository files, or customer-facing guides as additional Workspace mounts.

Custom input shaping

Customize `agent.hooks.prepareInput` when a provider needs extra metadata in the agent input, such as tenant IDs, channel IDs, or selected product areas.

Tool policies

Add approval policies to tools that can change files or trigger downstream actions.

Sandbox execution

Use Sandbox when your chatbot needs real command execution against a workspace session.

## Conclusion

You've built a source-aware chatbot with:

- A provider-facing chat definition using ViteHub Chat
- A colocated Workspace Agent discovered as `support/chat`
- Local, inline, and remote source mounts
- Workspace tool inspection before answering
- Runtime-specific deployment options without changing the core feature

The combination of ViteHub Chat, Workspace, and Agent makes it straightforward to build chatbots that answer from your own sources while keeping provider events, file state, and model execution cleanly separated.

Resources:

- [Chat overview](../chat)
- [Agent overview](../agent)
- [Workspace overview](../workspace)
- [Chat on Cloudflare](../chat/providers/cloudflare)
- [Chat on Vercel](../chat/providers/vercel)
