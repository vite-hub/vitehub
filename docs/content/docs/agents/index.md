---
title: Agents
description: Define a server-side Agent, choose how it runs, and connect it to your application.
navigation.title: Overview
navigation.order: 20
navigation.group: Core
icon: i-lucide-bot
---

An Agent is a named program that runs on your server. You describe it in one
file under `server/agents`. ViteHub discovers the file, runs the Agent when a
caller invokes it, and records what happened.

Use an Agent when a request needs a model, a coding provider such as Codex, or
a fixed set of typed questions. Use an Agent also when you want the same
inspection, Capabilities, and Channels for application code that you run
yourself.

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
import { workspaceShell } from 'vite-hub/agent/capabilities'
import { glob } from 'vite-hub/workspace'

export default defineAgent({
  driver: {
    model: 'openai/gpt-5.1-mini',
    instructions: 'Answer from the docs. Say when the docs do not answer.',
  },
  capabilities: [workspaceShell({ mode: 'read' })],
  workspace: {
    sourceRootDir: process.cwd(),
    sources: {
      docs: glob({ cwd: '.', include: ['docs/content/**/*.md'] }),
    },
  },
})
```

This file creates an Agent named `support`. The Driver runs a model with the
instructions. The Workspace contains the docs files. The `workspaceShell()`
Capability lets the model read those files. Server code then calls the Agent
with `runAgent(support, runtimeContext, { prompt })`.

::u-page-grid{class="not-prose mt-8 sm:grid-cols-2"}
  :::u-page-card
  ---
  title: Build your first Agent
  description: Define and call an Agent offline, with no model key.
  icon: i-lucide-rocket
  to: /docs/getting-started/first-agent
  ---
  :::
  :::u-page-card
  ---
  title: Define an Agent
  description: Select a Driver, Capabilities, Workspace, and Channels.
  icon: i-lucide-file-user
  to: /docs/agents/agent-definitions
  ---
  :::
::

## How an Agent fits together

| Part | What it decides |
| --- | --- |
| [Agent Definition](/docs/agents/agent-definitions) | The one object that names the Agent and holds every other part. |
| [Agent Driver](/docs/agents/agent-drivers) | How one run executes: a model (`{ model }`), Codex or Claude Code (`'codex'`, `'claude-code'`), typed questions (`{ ask }`), or your function (`{ run }`). |
| [Instructions](/docs/agents/instructions) | The durable guidance that a model or coding provider reads. |
| [Capabilities](/docs/capabilities) | The operations the Agent receives, such as tools, chat behavior, and access policy. |
| [Workspace context](/docs/agents/workspace-context) | The files and Sources that the Agent can reach. |
| [Invocation](/docs/agents/invocations) | One run: its input, its result or stream, and its trace. |
| [Agent Actor](/docs/agents/actors) | The trusted identity of the caller for one Invocation. |

An Agent gets no access by default. Adding KV, Blob, or a Workspace to the
application does not give a model access to it. Attach the matching
Capability only when the Agent needs that operation. A Workspace defines which
files exist. Capabilities and the Driver decide how the Agent can use them.

## How callers reach an Agent

Every call creates one Invocation. Choose the entry point that owns the input:

| Entry point | Use it when | API |
| --- | --- | --- |
| Direct call | Your route, Schedule, or script already validates the input. | `runAgent()`, `streamAgent()` |
| Trigger | A Capability or Channel prepares the event, for example `chat.message`. | `runAgentTrigger()`, `streamAgentTrigger()` |
| Channel | A web chat or messaging provider sends messages. ViteHub generates the route. | `channels` in the Definition |

Read [Invocations](/docs/agents/invocations) for direct calls,
[Triggers](/docs/agents/triggers) for event input, and
[Channels](/docs/agents/channels) for web chat, Discord, Slack, Teams,
Telegram, GitHub, and HTTP.

## Reading order

The sidebar follows this order. Read the pages in each group before you go to
the next group.

1. **Core.** Read [Agent Definitions](/docs/agents/agent-definitions) to
   declare an Agent. Then read [Invocations](/docs/agents/invocations) to run
   it and read the result.
2. **Configure.** Choose an [Agent Driver](/docs/agents/agent-drivers), write
   [Instructions](/docs/agents/instructions), and add
   [Workspace context](/docs/agents/workspace-context). Then select
   [Capabilities](/docs/capabilities) for the operations the Agent needs.
3. **Connect.** Add [Channels](/docs/agents/channels) or
   [Triggers](/docs/agents/triggers). Pass a trusted
   [Agent Actor](/docs/agents/actors). Select prior messages with
   [Chat History and sessions](/docs/agents/chat-history-sessions).
4. **Verify.** Inspect the Agent with the
   [CLI development loop](/docs/development/cli). Protect behavior with
   [Evals](/docs/agents/evals). Check Codex and Claude Code credentials and
   quota with [Provider status](/docs/agents/provider-status). A
   deployment-specific behavior still needs a build and a runtime check on the
   selected host.
5. **Advanced execution.** Start, inspect, and cancel child work with
   [Child invocations](/docs/agents/controlled-child-invocations).
   [Boxes](/docs/agents/boxes) prepare a process environment when application
   code owns that lifecycle.
