---
title: Build a Source-Aware AI Chatbot with ViteHub
description: Ship a chatbot that answers from your own docs, GitHub repos, and source files. One codebase runs on Telegram, Slack, Vite, Nitro, Cloudflare, and Vercel.
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

Building source-aware assistants should not mean wiring a different bot for every platform. This guide walks through creating a ViteHub chatbot that starts with a dummy DevTools reply, then grows into an agent that can answer from your docs, GitHub repos, and source files.

## What we're building

By the end of this tutorial, you'll have a working support chatbot with:

- A discovered Agent at `server/agents/support.ts` that exposes chat through `chat()`
- A live DevTools panel for testing without Telegram, Slack, or webhook setup
- An Agent that replaces the dummy reply with a real model response
- A Workspace that gives the agent file inspection tools for grounded answers
- One code path that can run in Vite, Nitro, Cloudflare, and Vercel

Each step adds one small piece, so you can see how Chat, Agent, Workspace, and Messages fit together.

## Prerequisites

Before we start, make sure you have:

- Node 20+ for local DevTools
- A Vite or Nitro app
- A model provider key for the provider you choose in the agent step

## Project setup

Install the packages that own the chat flow:

::code-tree-intersection{default}
```bash [Terminal]
pnpm add @vitehub/agent @vitehub/workspace ai
pnpm add -D @vitejs/devtools
```
::

Register the integration so ViteHub discovers your agents. Vite apps use plugins:

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
})
```
::
::

Nitro apps use modules:

::fw{id="nitro:dev nitro:build"}
::code-tree-intersection
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
::

That's all the wiring you need. The Agent owns the model loop, Workspace handles files, and Chat is attached as a capability.

## Step 1 — Define a chat-capable Agent

The fastest way to feel the loop is to skip the model entirely. Create `server/agents/support.ts` and echo whatever the user sends:

::code-tree-intersection
```ts [server/agents/support.ts]
import { chat, defineAgent } from '@vitehub/agent'

export default defineAgent({
  capabilities: [chat({ concurrency: 'queue', history: { source: 'thread', maxMessages: 20 } })],
  async run({ messages }) {
    const latest = messages.at(-1)
    const text = latest?.parts.filter(part => part.type === 'text').map(part => part.text).join('') || ''
    return {
      text: `You said: "${text}". I'll get smarter in step 3.`,
    }
  },
})
```
::

No model. No sources. No provider keys. Just an Agent with the Chat Capability.

## Step 2 — Send a message

Send a message through DevTools. The same `server/agents/support.ts` will handle real chat input once you attach a real model.

::fw{id="vite:dev vite:build"}
Vite picks up the panel through the `DevTools()` plugin you registered above. Start the dev server.
::

::fw{id="nitro:dev nitro:build"}
Run the Nitro dev server and open the URL it prints.
::

::code-tree-intersection
```bash [Terminal]
pnpm dev
```
::

Open the DevTools URL printed at startup and switch to the **ViteHub Chat** panel. Type a message—you'll see the dummy reply stream back instantly, with thread state and timeline visible on the side.

This is the loop you'll keep using. Every change to your agent or sources shows up in this panel within a hot reload.

## Step 3 — Add an Agent

Time to swap the dummy reply for a real model. Update the support agent:

::code-tree-intersection
```ts [server/agents/support.ts]
import { gateway } from '@ai-sdk/gateway'
import { chat, defineAgent } from '@vitehub/agent'

export default defineAgent({
  capabilities: [chat({ concurrency: 'queue', history: { source: 'thread', maxMessages: 20 } })],
  description: 'Answer support chat messages.',
  instructions: 'You are a friendly support bot. Keep replies short and concrete.',
  model: gateway('openai/gpt-5.1-mini'),
})
```
::

Reload the DevTools panel and send the same message. You'll see streamed model output instead of an echo. The thread history is preserved across messages because `history.source: 'thread'` replays the last 20 turns into the agent.

Chat is still a capability on the Agent. The Agent remains the source of truth.

## Step 4 — Connect sources for grounded answers

Models guess. Tools inspect. Add a Workspace to your agent so it can search, list, and read your own files before answering:

::code-tree-intersection
```ts [server/agents/support/chat/config.ts]
import { gateway } from '@ai-sdk/gateway'
import { defineAgent } from '@vitehub/agent'
import { workspaceShell } from '@vitehub/agent/capabilities'
import { source } from '@vitehub/workspace'

export default defineAgent({
  description: 'Answer support chat messages from connected project sources.',
  workspace: {
    sources: {
      docs: source.glob({
        cwd: '.',
        include: ['README.md', 'docs/**/*.md'],
      }),
      knowledgeBase: source.github({
        repo: 'acme/handbook',
        ref: 'main',
        root: 'support',
        materialize: 'lazy',
      }),
      instructions: source.file({
        workspacePath: 'AGENTS.md',
        content: [
          '# Support Chatbot',
          'Always inspect the connected sources before answering.',
          'Say when the sources do not contain enough information.',
        ].join('\n'),
      }),
    },
  },
  capabilities: [
    workspaceShell(),
  ],
  instructions: async ({ fs }) => await fs.readFile('AGENTS.md'),
  model: gateway('openai/gpt-5.1-mini'),
  provider: 'ai-sdk',
})
```
::

Each entry in `workspace.sources` becomes a mount. `workspaceShell()` is the explicit capability that lets the model inspect those mounts through the read-only workspace shell. Local globs travel with your repo, GitHub sources stay remote until the agent asks for them (`materialize: 'lazy'`), and inline files are perfect for instructions that should live next to the agent.

Send a question that only your sources can answer—"What does our refund policy say?"—and watch the panel show the tool calls firing before the streamed reply.

## Step 5 — Deploy anywhere

The same `server/agents/support.ts` ships to every supported runtime. Pick the platform and ViteHub resolves the Agent runtime around it.

::u-page-grid{class="pb-2"}
  :::u-page-card
  ---
  title: Cloudflare
  description: Run Chat webhooks on Workers and persist threads with Durable Objects.
  icon: i-simple-icons-cloudflare
  ---
  :::
  :::u-page-card
  ---
  title: Vercel
  description: Run the same chat-capable Agent through Vercel Functions with one config switch.
  icon: i-simple-icons-vercel
  ---
  :::
  :::u-page-card
  ---
  title: Workspace
  description: Choose how source files are mounted, cached, and inspected at runtime.
  icon: i-lucide-folder-git-2
  to: ../workspace
  ---
  :::
  :::u-page-card
  ---
  title: Agent
  description: Customize model runs, routes, tools, and the Chat handoff behavior.
  icon: i-lucide-bot
  to: ../agent
  ---
  :::
::

Swap providers the same way. Telegram today, Slack tomorrow—everything below the adapter stays untouched.

## The limit is your tools and context

You now have the whole loop: provider events in, source-aware streamed replies out, and the DevTools panel watching every step. From here, the bot only gets smarter when you give it more to work with.

Two levers to keep pulling:

- **More sources**: add product docs, changelogs, GitHub issues, customer macros, or your own internal handbook as additional Workspace mounts.
- **More tools**: expose typed actions on the agent—create a ticket, open a PR, look up an order—so it can do things, not just answer them.

The provider, the model, and the runtime are interchangeable. The thing that makes your bot _yours_ is the context you connect and the tools you let it call.

Resources:

- [Agent overview](../agent)
- [Workspace overview](../workspace)
