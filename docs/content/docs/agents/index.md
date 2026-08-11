---
title: Agents
description: Define, run, connect, and verify server-side Agents on any host.
navigation.title: Overview
navigation.order: 20
navigation.group: Core
icon: i-lucide-bot
---

ViteHub Agents are server-side programs with an explicit execution path, a controlled set of abilities, and inspectable runtime behavior. An Agent Definition keeps those choices in one place and runs on any supported host.

If this is your first Agent, follow [Build your first Agent](/docs/getting-started/first-agent). It creates an offline Agent, invokes it from a server route, and shows the response before adding a model or credentials.

## Build an Agent

This support Agent uses a model, reads a scoped documentation Workspace, and answers from inspected files.

```ts [server/agents/support/agent.ts]
import { defineAgent } from '@vite-hub/agent'
import { workspaceShell } from '@vite-hub/agent/capabilities'
import { file } from '@vite-hub/workspace'

export default defineAgent({
  driver: {
    model: 'openai/gpt-5.1-mini',
    instructions: [
      'Answer support questions from the docs Workspace.',
      'Use Workspace inspection before answering. Say when the docs do not contain the answer.',
    ],
  },
  capabilities: [workspaceShell({ mode: 'read' })],
  workspace: {
    sources: {
      docs: file({ path: './docs/content' }),
    },
  },
})
```

The Definition has three independent parts:

| Part | What it decides |
| --- | --- |
| [Agent Driver](/docs/agents/agent-drivers) | Whether the invocation uses a model, a harness such as Codex, or application code. |
| [Capabilities](/docs/capabilities) | Which tools and runtime abilities the active Driver can use. |
| [Workspace context](/docs/agents/workspace-context) | Which files, Sources, and bindings are visible to the invocation. |

## Run it

Use `runAgent()` when the caller needs one final result.

```ts [server/api/support.post.ts]
import { runAgent } from '@vite-hub/agent'
import support from '../agents/support/agent'

export default defineEventHandler(async (event) => {
  const { prompt } = await readBody<{ prompt: string }>(event)
  return runAgent(support, { runtime: 'unknown' }, { prompt })
})
```

```bash [Terminal]
curl http://localhost:3000/api/support \
  --request POST \
  --header 'content-type: application/json' \
  --data '{"prompt":"How do I add a server primitive?"}'
```

The route returns the Agent's final result. Use [`streamAgent()`](/docs/agents/invocations#stream-an-agent) when a UI should receive incremental output.

## Connect it

Keep product entry points separate from execution:

- [Channels](/docs/agents/channels) connect the Agent to web chat, Discord, Telegram, GitHub, and other destinations.
- [Triggers](/docs/agents/triggers) translate product events into Agent Invocations.
- [Agent Actors](/docs/agents/actors) carry trusted caller identity into an invocation.
- [Chat History and sessions](/docs/agents/chat-history-sessions) select which prior messages belong to the next chat invocation.

## Verify it

Run the Agent locally through the [CLI dev loop](/docs/development/cli), then add an [Eval](/docs/agents/evals) for behavior that must remain stable. Both use the same Agent Definition, Driver, Capabilities, and Workspace as the application path.

## Choose the next page

| Goal | Read |
| --- | --- |
| Understand every `defineAgent()` option | [Agent Definitions](/docs/agents/agent-definitions) |
| Choose model, harness, or custom execution | [Agent Drivers](/docs/agents/agent-drivers) |
| Write model-facing behavior and policy | [Instructions](/docs/agents/instructions) |
| Give an Agent scoped files and Sources | [Workspace context](/docs/agents/workspace-context) |
| Run a harness in a prepared environment | [Boxes](/docs/agents/boxes) |
