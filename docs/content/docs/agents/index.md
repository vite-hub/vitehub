---
title: Agents
description: Define a server-side Agent, choose how it runs, and connect it to your application.
navigation.title: Overview
navigation.order: 20
navigation.group: Core
icon: i-lucide-bot
---

An Agent is a named server-side program. Its definition records how it runs,
which files and tools it can use, and how callers reach it.

Start with an offline Agent if you have not built one yet. The tutorial creates
the definition, calls it from an H3 route, and shows the response without a model
key or hosted service.

::u-page-grid{class="not-prose mt-8 sm:grid-cols-2"}
  :::u-page-card
  ---
  title: Build your first Agent
  description: Define and call an Agent with a complete local example.
  icon: i-lucide-rocket
  to: /docs/getting-started/first-agent
  ---
  :::
  :::u-page-card
  ---
  title: Define an Agent
  description: Choose a Driver, Capabilities, Workspace, and Channels.
  icon: i-lucide-file-user
  to: /docs/agents/agent-definitions
  ---
  :::
  :::u-page-card
  ---
  title: Choose a Driver
  description: Run a model, Codex, Claude Code, or application code.
  icon: i-lucide-cpu
  to: /docs/agents/agent-drivers
  ---
  :::
  :::u-page-card
  ---
  title: Add Capabilities
  description: Give the active Driver selected tools and runtime behavior.
  icon: i-lucide-blocks
  to: /docs/capabilities
  ---
  :::
::

## How an Agent fits together

| Part | What you choose |
| --- | --- |
| [Agent Definition](/docs/agents/agent-definitions) | One Agent's Driver, Capabilities, Workspace, Channels, and hooks. |
| [Agent Driver](/docs/agents/agent-drivers) | A model, a coding provider, or your own `run` function. |
| [Agent Invocation](/docs/agents/invocations) | The input for one run and whether the result returns or streams. |
| [Capabilities](/docs/capabilities) | The tools and behavior available during an invocation. |
| [Workspace context](/docs/agents/workspace-context) | The files, Sources, and bindings available to the Agent. |
| [Instructions](/docs/agents/instructions) | Durable guidance for a model or coding provider. |

Capabilities grant access deliberately. Adding KV, Blob, a Workspace, or another
server feature to the application does not give a model access to it. Attach the
matching Capability only when the Agent needs that action.

## Connect an Agent

Call an Agent directly from trusted server code, or connect it to a product entry
point:

- [Channels](/docs/agents/channels) connect web chat, Discord, Telegram, GitHub,
  and other message transports.
- [Triggers](/docs/agents/triggers) turn application events into Agent input.
- [Agent Actors](/docs/agents/actors) carry trusted caller identity.
- [Chat History and sessions](/docs/agents/chat-history-sessions) select the
  earlier messages supplied to a chat invocation.

## Verify behavior

Use the [CLI development loop](/docs/development/cli) to inspect and run the
Agent locally. Add an [Eval](/docs/agents/evals) for behavior that must keep
working. Deployment-specific behavior still needs a build and runtime check on
the selected host.

## Advanced execution

- [Controlled child invocations](/docs/agents/controlled-child-invocations)
  start, inspect, cancel, or respond to child work from trusted code.
- [Boxes](/docs/agents/boxes) prepare a process environment when application
  code owns that lifecycle.
