---
title: Agents
description: Define an AI agent on your server in one file, choose what runs it, and reach it from chat, Slack, GitHub, or HTTP.
navigation.title: Overview
navigation.order: 1
navigation.group: Start
icon: i-lucide-bot
---

::product-hero{tagline="Define an AI agent in one file, give it files and tools, and reach it from chat, Slack, or GitHub." hosts="Node, Docker, Cloudflare, Vercel, Netlify, Deno" channels="Web chat, HTTP, Slack, Discord, Telegram, Teams, GitHub, GitLab, Forgejo, Gmail" channel-mode="builtin"}
  :::agent-demo
  :::
::

## Start here

- [First Agent](/docs/getting-started/first-agent) is the shortest proof. Run an Agent without an API key.
- [Learning path](/docs/agents/get-started) connects the first run to models, tools, and a complete application.
- [Build a chat app](/docs/agents/build-a-chat-app) connects a model, a streaming route, and a Vue chat UI in one project.

## Define and run

An Agent Definition selects a Driver. An Invocation runs that definition with one input. This example works without a model or credentials:

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
console.log(result) // { text: 'Hello, Ada!' }
```

`runtime: false` selects inline execution. The two-argument `runAgent()` form returns an error/result tuple. For model output, provider Drivers, and streaming, follow [Invocations](/docs/agents/invocations).

## Learn in order

1. [Define an Agent](/docs/agents/agent-definitions) and [choose its Driver](/docs/agents/agent-drivers).
2. [Run or stream an Invocation](/docs/agents/invocations).
3. [Write instructions](/docs/agents/instructions) and [attach tools through Capabilities](/docs/agents/capabilities).
4. [Select Chat History](/docs/agents/chat-history-sessions) and [add Workspace context](/docs/agents/workspace-context).
5. [Connect a Channel](/docs/agents/channels) when messages arrive from another service or a web chat.
6. [Inspect events](/docs/agents/observability), [test contracts](/docs/agents/testing), and [evaluate model behavior](/docs/agents/evals).

When the Agent works, use [presets and inheritance](/docs/agents/agent-presets) to share configuration and [Invocation storage](/docs/agents/invocation-storage) to retain run evidence. [Ready-made presets](/docs/agents/presets) provide complete workflows with their own setup requirements.

::product-features
  :::product-feature-item{title="Choose what does the work" icon="i-lucide-cpu" to="/docs/agents/agent-drivers"}
  Use an AI model, Codex, Claude Code, or your own function. Your routes call the agent the same way.
  :::

  :::product-feature-item{title="Give it only the tools you choose" icon="i-lucide-blocks" to="/docs/agents/capabilities"}
  The agent cannot use a server feature until you add a tool for it. Built-in tools include web search, memory, and MCP servers.
  :::

  :::product-feature-item{title="Let it read your files" icon="i-lucide-folder-git-2" to="/docs/agents/workspace-context"}
  Give it a folder of files from your project or GitHub. You decide if it can only read them or also write.
  :::

  :::product-feature-item{title="Talk to it where people already are" icon="i-lucide-radio" to="/docs/agents/channels"}
  Connect web chat, Slack, Discord, Telegram, Teams, GitHub, or an HTTP route.
  :::

  :::product-feature-item{title="Call it like a function" icon="i-lucide-play-circle" to="/docs/agents/invocations#run-an-agent"}
  `runAgent()` runs the agent and returns its result. The ViteHub Console shows what happened in each run.
  :::

  :::product-feature-item{title="Start from a ready-made agent" icon="i-lucide-copy" to="/docs/agents/presets"}
  Babysitter fixes pull requests. The Workspace preset answers from your files and links to them. Add your settings and run it.
  :::
::
