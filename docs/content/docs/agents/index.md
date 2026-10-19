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
