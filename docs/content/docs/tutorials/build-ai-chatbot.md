---
title: Build a Source-Aware AI Chatbot with ViteHub
description: Ship a chatbot that answers from your own docs, GitHub repos, and source files. One codebase runs on Telegram, Slack, Vite, Nitro, Cloudflare, and Vercel.
date: 2026-05-11
image: /images/tutorials/source-aware-chatbot.png
authors:
  - name: onmax
    avatar: https://github.com/onmax.png
navigation.title: Source-Aware AI Chatbot
navigation.order: 1
icon: i-lucide-message-circle-code
frameworks: [vite, nitro]
---

Building source-aware assistants should not mean wiring a different bot for every platform. This guide walks through creating a ViteHub chatbot that starts with a dummy DevTools reply, then grows into an agent that can answer from your docs, GitHub repos, and source files.

## What we're building

By the end of this tutorial, you'll have a working support chatbot with:

- A Chat definition at `server/chat.ts` that handles messages through ViteHub
- A live DevTools panel for testing without Telegram, Slack, or webhook setup
- An Agent that replaces the dummy reply with a real model response
- A Workspace that gives the agent file inspection tools for grounded answers
- One code path that can run in Vite, Nitro, Cloudflare, and Vercel

Each step adds one small piece, so you can see how Chat, Agent, Workspace, and Messages fit together before adding platform adapters.

## Prerequisites

Before we start, make sure you have:

- Node 20+ for local DevTools
- A Vite or Nitro app
- An AI SDK model provider key for the agent step

## Project setup

Install the packages that own the chat flow:

::code-tree-intersection{default}
```bash [Terminal]
pnpm add @vitehub/chat @vitehub/agent @vitehub/workspace @vitehub/messages ai
```
::

Register the integration so ViteHub discovers `server/chat.ts` and your agents. Vite apps use plugins:

::fw{id="vite:dev vite:build"}
::code-tree-intersection
```ts [vite.config.ts]
import { hubAgent } from '@vitehub/agent/vite'
import { hubChat } from '@vitehub/chat/vite'
import { hubWorkspace } from '@vitehub/workspace/vite'
import { DevTools } from '@vitejs/devtools'
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    DevTools(),
    hubWorkspace(),
    hubAgent(),
    hubChat(),
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
    '@vitehub/chat/nitro',
  ],
})
```
::
::

That's all the wiring you need. Chat handles provider events, Workspace handles files, and Agent handles the model loop. Nothing else hooks together until you ask it to.

## Step 1 — Define a chat with a dummy reply

The fastest way to feel the loop is to skip the model entirely. Create `server/chat.ts` and echo whatever the user sends:

::code-tree-intersection
```ts [server/chat.ts]
import { defineChat } from '@vitehub/chat'
import { getMessageText } from '@vitehub/messages'

export default defineChat({
  userName: 'Support Bot',
  state,
  onDirectMessage: async ({ message, thread }) => {
    const text = getMessageText(message)
    await thread.post(`You said: "${text}". I'll get smarter in step 3.`)
  },
})
```
::

No model. No sources. No provider keys. Just a thread that posts a string. ViteHub still runs the full pipeline—routing, state, devtools instrumentation—around this dummy reply.

## Step 2 — Inspect with DevTools

You don't need a Telegram bot token or a Slack workspace to try this. ViteHub Chat ships a DevTools panel that talks to the same `server/chat.ts` your real provider will eventually hit.

::fw{id="vite:dev vite:build"}
Vite picks up the panel through the `DevTools()` plugin you registered above. Start the dev server.
::

::fw{id="nitro:dev nitro:build"}
Nitro mounts the panel automatically when `@vitehub/chat/nitro` is registered. Run the dev server and open the URL it prints.
::

::code-tree-intersection
```bash [Terminal]
pnpm dev
```
::

Open the DevTools URL printed at startup and switch to the **ViteHub Chat** panel. Type a message—you'll see the dummy reply stream back instantly, with thread state and timeline visible on the side.

This is the loop you'll keep using. Every change to your chat, agent, or sources shows up in this panel within a hot reload—no tunneling, no webhook secrets, no platform setup.

## Step 3 — Add an Agent

Time to swap the dummy reply for a real model. ViteHub agents live in `server/agents/<name>/config.ts`. Create the support chat agent:

::code-tree-intersection
```ts [server/agents/support/chat/config.ts]
import { defineAgent } from '@vitehub/agent'

export default defineAgent({
  description: 'Answer support chat messages.',
  instructions: 'You are a friendly support bot. Keep replies short and concrete.',
  model,
})
```
::

ViteHub discovers this file as the `support/chat` agent. Now hand the chat over to it—delete `onDirectMessage` and bind the agent by name:

::code-tree-intersection
```ts [server/chat.ts]
import { defineChat } from '@vitehub/chat'

export default defineChat({
  userName: 'Support Bot',
  state,
  agent: {
    name: 'support/chat',
    history: {
      source: 'thread',
      maxMessages: 20,
    },
  },
})
```
::

Reload the DevTools panel and send the same message. You'll see streamed model output instead of an echo. The thread history is preserved across messages because `history.source: 'thread'` replays the last 20 turns into the agent.

Chat still owns provider events. Agent owns the model. They never reach across.

## Step 4 — Connect sources for grounded answers

Models guess. Tools inspect. Add a Workspace to your agent so it can search, list, and read your own files before answering:

::code-tree-intersection
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
  instructions: async ({ fs }) => await fs.readFile('AGENTS.md'),
  model,
})
```
::

Each entry in `workspace.sources` becomes a mount the agent can inspect with `list`, `search`, and `read` tools. Local globs travel with your repo, GitHub sources stay remote until the agent asks for them (`materialize: 'lazy'`), and inline files are perfect for instructions that should live next to the agent.

Send a question that only your sources can answer—"What does our refund policy say?"—and watch the panel show the tool calls firing before the streamed reply.

## Step 5 — Deploy anywhere

The same `server/chat.ts` and `server/agents/support/chat/config.ts` ship to every supported runtime. Pick the platform and ViteHub resolves state, webhooks, and bindings for you.

::u-page-grid{class="pb-2"}
  :::u-page-card
  ---
  title: Cloudflare
  description: Run Chat webhooks on Workers and persist threads with Durable Objects.
  icon: i-simple-icons-cloudflare
  to: ../chat/providers/cloudflare
  ---
  :::
  :::u-page-card
  ---
  title: Vercel
  description: Run the same Chat definition through Vercel Functions with one config switch.
  icon: i-simple-icons-vercel
  to: ../chat/providers/vercel
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

- [Chat overview](../chat)
- [Agent overview](../agent)
- [Workspace overview](../workspace)
- [Chat on Cloudflare](../chat/providers/cloudflare)
- [Chat on Vercel](../chat/providers/vercel)
