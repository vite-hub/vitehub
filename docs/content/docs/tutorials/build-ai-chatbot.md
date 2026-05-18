---
title: Build a Source-Aware AI Chatbot with ViteHub
description: Ship a chatbot that answers from your own docs, GitHub repos, and source files. One agent can run on Slack, Vite, Nitro, Cloudflare, and Vercel.
date: 2026-05-11
image: /images/tutorials/source-aware-chatbot.png
authors:
  - name: onmax
    avatar:
      src: https://github.com/onmax.png
    to: https://github.com/onmax
navigation.title: Source-Aware AI Chatbot
navigation.order: 1
icon: i-lucide-message-circle-code
frameworks: [vite, nitro]
---

Building source-aware assistants should not mean wiring a different bot for every platform. This guide walks through creating a ViteHub agent that receives chat events, answers with a model, and can inspect your docs and source files.

## What we're building

By the end of this tutorial, you'll have:

- A discovered agent at `server/agents/support.ts`
- Chat bound to that agent through the `chat()` capability
- A DevTools panel for local testing without external webhooks
- Workspace sources that ground the agent's answers

## Project setup

Install the packages that own the agent and workspace flow:

::code-tree-intersection{default}
```bash [Terminal]
pnpm add @vitehub/agent @vitehub/workspace ai
```
::

Register Agent and Workspace. Vite apps add the Chat DevTools plugin separately:

::fw{id="vite:dev vite:build"}
::code-tree-intersection
```ts [vite.config.ts]
import { hubAgent, hubChatDevtools } from '@vitehub/agent/vite'
import { hubWorkspace } from '@vitehub/workspace/vite'
import { DevTools } from '@vitejs/devtools'
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    DevTools(),
    hubWorkspace(),
    hubAgent(),
    hubChatDevtools(),
    nitro(),
  ],
}
```
::
::

::fw{id="nitro:dev nitro:build"}
::code-tree-intersection
```ts [nitro.config.ts]
import { defineNitroConfig } from 'nitro/config'

export default defineNitroConfig({
  modules: [
    '@vitehub/workspace/nitro',
    '@vitehub/agent/nitro',
  ],
}
```
::
::

## Step 1 - Define an agent with chat

Create `server/agents/support.ts` and attach Chat as a capability:

::code-tree-intersection
```ts [server/agents/support.ts]
import { gateway } from '@ai-sdk/gateway'
import { defineAgent } from '@vitehub/agent'
import { createDevtoolsAdapter } from '@vitehub/agent/chat/devtools'
import { chat } from '@vitehub/agent/capabilities'

export default defineAgent({
  description: 'Answer support chat messages.',
  provider: 'ai-sdk',

    instructions: 'You are a friendly support bot. Keep replies short and concrete.',
    model: gateway('openai/gpt-5.1-mini'),
  },
  capabilities: [
    chat({
      adapters: {
        devtools: createDevtoolsAdapter(),
      },
    }),
  ],
}
```
::

Chat registers the provider binding and webhook route. The agent remains the only public server definition.

## Step 2 - Inspect with DevTools

Start the dev server:

::code-tree-intersection
```bash [Terminal]
pnpm dev
```
::

Open the DevTools URL printed at startup and switch to the **ViteHub Chat** panel. Messages sent there hit the same agent that platform webhooks use.

## Step 3 - Enable Chat History

Chat is stateless by default. Enable history when you want recent thread messages replayed into the agent:

::code-tree-intersection
```ts [server/agents/support.ts]
import { gateway } from '@ai-sdk/gateway'
import { defineAgent } from '@vitehub/agent'
import { createDevtoolsAdapter } from '@vitehub/agent/chat/devtools'
import { chat } from '@vitehub/agent/capabilities'

export default defineAgent({
  workspace: 'support',
  description: 'Answer support chat messages.',
  provider: 'ai-sdk',

    instructions: 'You are a friendly support bot. Keep replies short and concrete.',
    model: gateway('openai/gpt-5.1-mini'),
  },
  capabilities: [
    chat({
      adapters: {
        devtools: createDevtoolsAdapter(),
      },
      history: true,
    }),
  ],
}
```
::

ViteHub manages Chat State internally. Configure `state` only when you want to choose a specific backing provider.

## Step 4 - Connect sources for grounded answers

Models guess. Tools inspect. Add a Workspace so the agent can search, list, and read your own files before answering:

::code-tree-intersection
```ts [server/agents/support.ts]
import { gateway } from '@ai-sdk/gateway'
import { defineAgent } from '@vitehub/agent'
import { createDevtoolsAdapter } from '@vitehub/agent/chat/devtools'
import { chat } from '@vitehub/agent/capabilities'
import * as source from '@vitehub/workspace/source'

export default defineAgent({
  workspace: {
    sources: {
      docs: source.glob({
        cwd: process.cwd(),
        include: ['README.md', 'docs/**/*.md'],
      }),
      instructions: source.file({
        workspacePath: 'AGENTS.md',
        content: [
          '# Support Chatbot',
          'Always inspect connected sources before answering.',
          'Say when the sources do not contain enough information.',
        ].join('\n'),
      }),
    },
  },
  provider: 'ai-sdk',

    instructions: async ({ fs }) => await fs.readFile('AGENTS.md'),
    tools: ({ workspace }) => workspace.tools.inspect(),
    model: gateway('openai/gpt-5.1-mini'),
  },
  capabilities: [
    chat({
      adapters: {
        devtools: createDevtoolsAdapter(),
      },
      history: true,
    }),
  ],
}
```
::

Each entry in `workspace.sources` declares a source: an origin that contributes files or items to the workspace. The source key becomes the default mount path, and the `tools` resolver is the explicit opt-in that lets the model inspect mounted workspace paths through the read-only workspace shell.

## Step 5 - Deploy anywhere

The same `server/agents/support.ts` ships to every supported runtime. Pick the platform adapter and ViteHub resolves the agent-scoped webhook route at `/api/agents/support/chat/<platform>`.

The provider, the model, and the runtime are interchangeable. The thing that makes your bot yours is the context you connect and the tools you let it call.

Resources:

- [Agent overview](../agent)
- [Workspace overview](../workspace)
