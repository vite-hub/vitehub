---
title: Agents
description: Define a server-side Agent, choose how it runs, and connect it to your application.
navigation.title: Overview
navigation.order: 1
navigation.group: Start
icon: i-lucide-bot
---

::product-hero{tagline="One file under server/agents: a Driver, a Workspace, Capabilities, and Channels, run and recorded on your host." hosts="Node, Docker, Cloudflare, Vercel, Netlify, Deno" channels="Web chat, HTTP, Slack, Discord, Telegram, Teams, GitHub, GitLab, Forgejo, Gmail" channel-mode="builtin"}
  :::agent-demo
  :::
::


::product-features
  :::product-feature-item{title="Bring any model or coding provider" icon="i-lucide-cpu" to="/docs/agents/agent-drivers"}
  A model, Codex, Claude Code, typed questions, or your own function.
  :::

  :::product-feature-item{title="Tools are the APIs your routes already call" icon="i-lucide-blocks" to="/docs/agents/capabilities"}
  A Capability wraps one primitive with a mode, a scope, and a policy. Official tools add MCP, skills, memory, and web access.
  :::

  :::product-feature-item{title="It works in a real file tree" icon="i-lucide-folder-git-2" to="/docs/agents/workspace-context"}
  A Workspace holds files and Sources and persists between runs.
  :::

  :::product-feature-item{title="Reach it from chat, GitHub, Slack, or HTTP" icon="i-lucide-radio" to="/docs/agents/channels"}
  A Channel starts the Invocation where the input lives.
  :::

  :::product-feature-item{title="Call it like a function, inspect it like a trace" icon="i-lucide-play-circle" to="/docs/agents/invocations"}
  `runAgent()` returns a result; the Console shows every step.
  :::

  :::product-feature-item{title="Start from a working harness" icon="i-lucide-git-pull-request" to="/docs/agents/babysitter"}
  Babysitter repairs pull requests, waits for checks, merges, and can score repeatable Evals.
  :::

::
