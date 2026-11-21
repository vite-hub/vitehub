---
title: Agents
layout: landing
description: Define an AI agent on your server in one file, choose what runs it, and reach it from chat, Slack, GitHub, or HTTP.
navigation.title: Overview
navigation.order: 1
navigation.group: Start
icon: i-lucide-bot
---

::product-hero{tagline="Define an AI agent in one file, give it files and tools, and reach it from chat, Slack, or GitHub." hosts="Node, Docker, Cloudflare, Vercel, Netlify, Deno" channels="Web chat, HTTP, Slack, Discord, Telegram, Teams, GitHub, GitLab, Forgejo, Gmail" channel-mode="builtin"}
  :hero-figure{name="agents"}
::

## Start here

- [First Agent](/docs/getting-started/first-agent): run an Agent with no API key.
- [Learning path](/docs/agents/get-started): go from your first run to models, tools, and a full app.
- [Build a chat app](/docs/agents/build-a-chat-app): connect a model, a streaming route, and a Vue chat UI.

For a single model call without tools, such as a summary or fields read from text, you do not need an Agent. Call [`ask(prompt, { model, schema })`](/docs/gateways/server-api#get-typed-data-from-a-model) from AI Gateways to get data checked against your schema.

## Define and run

An Agent Definition picks a Driver to do the work, and an Invocation runs it with one input. This example needs no model or credentials:

```ts
import { defineAgent, runAgent } from 'vite-hub/agent'

const greeting = defineAgent({
  runtime: false,
  driver: {
    run({ prompt }) {
      const name = typeof prompt === 'string' ? prompt : 'friend'
      return { text: `Hello, ${name}!` }
    },
  },
})

const [error, result] = await runAgent(greeting, { prompt: 'Ada' })
if (error) throw error
console.log(result.text) // 'Hello, Ada!'
```

`runAgent()` returns an `[error, result]` tuple. See [Invocations](/docs/agents/invocations) for model output, provider Drivers, and streaming.

## Learn in order

1. [Define an Agent](/docs/agents/agent-definitions) and [choose its Driver](/docs/agents/agent-drivers).
2. [Run or stream an Invocation](/docs/agents/invocations).
3. [Write instructions](/docs/agents/instructions) and [attach tools through Capabilities](/docs/agents/capabilities).
4. [Select Chat History](/docs/agents/chat-history-sessions) and [add Workspace context](/docs/agents/workspace-context).
5. [Connect a Channel](/docs/agents/channels) for messages from another service or web chat.
6. [Inspect events](/docs/agents/observability), [test contracts](/docs/agents/testing), and [evaluate model behavior](/docs/agents/evals).

Then share configuration with [presets and inheritance](/docs/agents/agent-presets) and keep run records with [Invocation storage](/docs/agents/invocation-storage). [Ready-made presets](/docs/presets) give full workflows, each with its own setup.

::product-features
  :::product-feature-item{title="Choose what does the work" icon="i-lucide-cpu" to="/docs/agents/agent-drivers"}
  Run an AI model, Codex, Claude Code, or your own function. Your routes call the Agent the same way.
  :::

  :::product-feature-item{title="Give it only the tools you choose" icon="i-lucide-blocks" to="/docs/agents/capabilities"}
  An Agent cannot use a server feature until you add a tool for it. Built-in tools cover web search, memory, and MCP servers.
  :::

  :::product-feature-item{title="Let it read your files" icon="i-lucide-folder-git-2" to="/docs/agents/workspace-context"}
  Give it a folder from your project or GitHub. You choose whether the Agent can only read or also write.
  :::

  :::product-feature-item{title="Talk to it where people already are" icon="i-lucide-radio" to="/docs/agents/channels"}
  Connect web chat, Slack, Discord, Telegram, Teams, GitHub, or an HTTP route.
  :::

  :::product-feature-item{title="Call it like a function" icon="i-lucide-play-circle" to="/docs/agents/invocations#run-an-agent"}
  `runAgent()` runs the Agent and returns its result. The ViteHub Console shows what happened in each run.
  :::

  :::product-feature-item{title="Start from a ready-made agent" icon="i-lucide-copy" to="/docs/presets"}
  Babysitter fixes pull requests, and the Workspace preset answers from your files with links. Add your settings and run it.
  :::
::
