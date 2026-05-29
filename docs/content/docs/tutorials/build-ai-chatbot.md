---
title: Build an AI Agent in one file
description: >-
  Build a support Agent with model behavior, Capabilities, Workspace Sources,
  DevTools, and an Agent Eval.
date: 2026-05-28
image: /images/tutorials/agent-layers-flat.png
authors:
  - name: onmax
    avatar:
      src: https://github.com/onmax.png
    to: https://github.com/onmax
navigation.title: AI Agent
navigation.order: 3
icon: i-lucide-message-circle-code
frameworks: [vite, nitro]
---

The Agent Package is the second ViteHub layer.

The first layer gives you server primitives: KV, Blob, Queue, Workflow,
Sandbox, Workspace, and the framework integrations that wire them to a host.
The Agent layer composes those pieces into one model-backed server actor.

The developer experience should feel closer to [Better Auth](https://better-auth.com/)
than to a custom tool registry. You open one typed file, see the model, read the
instructions, and inspect the Capabilities the Agent can use.

For this post, we will build a support Agent that answers from one Workspace
Source, test it in DevTools, and turn the expected answer into an Agent Eval.

::code-tree-intersection{default}
```ts [server/agents/support/config.ts]
import { gateway } from '@ai-sdk/gateway'
import { defineAgent } from '@vitehub/agent'
import { chat, workspaceShell } from '@vitehub/agent/capabilities'
import { source } from '@vitehub/workspace'

export default defineAgent({
  model: gateway('openai/gpt-5.1-mini'),
  instructions: 'Answer support questions from the workspace.',
  capabilities: [
    chat(),
    workspaceShell(),
  ],
  workspace: {
    sources: {
      support: source.file('support.md'),
    },
  },
})
```
::

That is the Agent file in three pieces:

- **Agent**: the model, instructions, and runtime behavior.
- **Capabilities**: the abilities you opt into, such as chat or workspace
  access.
- **Workspace**: the named Sources the agent can inspect when a Capability
  exposes them.

## Capabilities you can add

The example starts with `chat()` and `workspaceShell()`. Every extra ability is
another opt-in line in the Agent file.

- `chat()` adds a chat entrypoint.
- `workspaceShell()` reads or writes Workspace files.
- `skills()` loads project instructions from `SKILL.md`.
- `webSearch()` searches and reads the web.
- `fetch()` wraps HTTP APIs as typed tools.
- `mcp()` connects MCP server tools.
- `sandbox()` runs approved commands in isolation.
- `schedule()` declares cron work or schedule tools.
- `inputCommands()` expands slash commands.
- `transcribe()` attaches audio-to-text input handling.
- `memory()` persists scoped Agent memory.
- `kv()` reads or writes KV keys.
- `blob()` reads or writes Blob objects.
- `db()` queries or mutates a database.
- `chatTitle()` generates conversation titles.
- `chatSummary()` summarizes conversations.
- `llmGate()` rejects unsafe or unwanted requests.
- `llmRoute()` chooses the right path for a request.
- `usageTelemetry()` records model usage and cost.

## One file you can review

The Agent file should make a review easy. If a pull request changes the model,
the instructions, the Capabilities, or the Workspace Sources, that change should
be visible in one place.

That gives you a clean path from prototype to production: get chat working,
ground the answer in Workspace Sources, inspect the live invocation in DevTools,
then protect the behavior with an eval.

## Prerequisites

- Node 20.19+ or Node 22.12+.
- `pnpm`
- a model provider key for the AI SDK Gateway model you choose

## Install the ViteHub pieces

Install the packages used in this post:

```bash [Terminal]
pnpm add @vitehub/agent @vitehub/workspace
pnpm add @vitehub/devtools @ai-sdk/gateway ai
pnpm add -D @vitejs/devtools
```

Register the integrations for your framework:

::fw{id="vite:dev vite:build"}
::code-tree-intersection
```ts [vite.config.ts]
import { hubAgent } from '@vitehub/agent/vite'
import { hubDevtools } from '@vitehub/devtools'
import { hubWorkspace } from '@vitehub/workspace/vite'
import { DevTools } from '@vitejs/devtools'
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'

export default defineConfig(async () => ({
  plugins: [
    ...(await DevTools()),
    hubDevtools(),
    hubWorkspace(),
    hubAgent(),
    nitro(),
  ],
}))
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
})
```
::
::

::fw{id="vite:dev vite:build"}
The Vite plugins split the local wiring into small pieces:

- `DevTools()` adds the Vite DevTools shell.
- `hubDevtools()` adds the ViteHub panel.
- `hubWorkspace()` registers Workspace Sources.
- `hubAgent()` discovers Agent Definitions and connects Chat-capable Agents to DevTools.
- `nitro()` gives the app a Nitro server runtime.
::

::fw{id="nitro:dev nitro:build"}
The Nitro modules split the server wiring into small pieces:

- `@vitehub/workspace/nitro` registers Workspace Sources.
- `@vitehub/agent/nitro` discovers Agent Definitions.
::

## Create the first Agent

::fw{id="vite:dev vite:build"}
Create `server/agents/support/config.ts` for this example. ViteHub can also
discover plain Vite Agent files such as `src/support.agent.ts`, but this Agent
owns Workspace Sources, so the folder form keeps the Agent and its source files
together.
::

::fw{id="nitro:dev nitro:build"}
Create `server/agents/support/config.ts`. In Nitro, the folder name gives the
Agent its discovery name. Later, when this file declares `workspace`, the same
file also becomes the Workspace Definition.
::

Start with chat and a short instruction:

::code-tree-intersection
```ts [server/agents/support/config.ts]
import { gateway } from '@ai-sdk/gateway'
import { defineAgent } from '@vitehub/agent'
import { chat } from '@vitehub/agent/capabilities'

export default defineAgent({
  capabilities: [
    chat(),
  ],
  instructions: 'Answer support questions in a short, concrete style.',
  model: gateway('openai/gpt-5.1-mini'),
})
```
::

The model and instructions belong to the Agent. `chat()` adds the chat runtime.
Every message from DevTools or an API route becomes an Agent Invocation against
this definition.

This version can already answer a chat message, but it only has the model and
the instructions. It does not know about your support policy yet.

## Add Workspace context

Models should not guess from memory when your own files contain the answer. Add
a small support note next to the Agent:

::code-tree-intersection
```md [server/agents/support/workspace/support.md]
# Support notes

Refunds are available within 30 days when the order has not shipped.
```
::

The file lives beside the Agent. Because the folder has a `workspace/`
directory, `source.file('support.md')` reads from that directory and exposes the
file as `support.md` inside the Workspace.

::fw{id="vite:dev vite:build"}
If you want a standalone Workspace, Vite uses `src/support.workspace.ts`. Here,
the Workspace stays in `server/agents/support/config.ts` because the support
Agent is the only consumer.
::

::fw{id="nitro:dev nitro:build"}
If you want a standalone Workspace, Nitro uses `server/workspaces/support.ts`.
Here, `server/agents/support/config.ts` owns the Workspace so the support policy
stays beside the Agent.
::

ViteHub does not load sibling files by convention. Declare the file as a
Workspace Source and attach the Workspace Shell Capability:

::code-tree-intersection
```ts [server/agents/support/config.ts]
import { gateway } from '@ai-sdk/gateway'
import { defineAgent } from '@vitehub/agent'
import { chat, workspaceShell } from '@vitehub/agent/capabilities'
import { source } from '@vitehub/workspace'

export default defineAgent({
  workspace: {
    sources: {
      support: source.file('support.md'),
    },
  },
  capabilities: [
    chat({
      history: {
        source: 'thread',
        maxMessages: 20,
      },
    }),
    workspaceShell(),
  ],
  instructions: [
    'Answer from the workspace sources.',
    'If the sources do not contain the answer, say so.',
  ],
  model: gateway('openai/gpt-5.1-mini'),
})
```
::

Two things happen here, and they stay separate. `workspace.sources` mounts
`support.md` as source context. `workspaceShell()` exposes a read-only workspace
tool so the model can inspect that context during the invocation.

A Workspace does not automatically become model context just because it exists.
You can add more Sources without changing the model loop, and you can choose
which Capabilities expose which runtime abilities.

That boundary is useful when the Agent grows. You can mount more docs, changelog
files, or GitHub-backed Sources without giving the model write access or changing
the chat integration.

## Test the loop in DevTools

::fw{id="vite:dev vite:build"}
Run the app:

```bash [Terminal]
pnpm dev
```

Open Vite DevTools, choose **ViteHub**, then open **Chat**. Select the
`support` Agent and ask:

```txt
What is our refund policy?
```

The Agent should stream a reply that mentions the 30-day refund window. The
DevTools timeline also shows the workspace tool calls that happen before the
answer.

Use this view when the Agent gives a weak answer. If the timeline never reads
`support.md`, the problem is source access. If it reads the file and still gives
the wrong answer, the next place to tune is the instructions.
::

::fw{id="nitro:dev nitro:build"}
Run the app:

```bash [Terminal]
pnpm dev
```

The Chat DevTools feature is registered through the Vite DevTools integration.
For a Nitro-only app, keep the same Agent Definition and use an HTTP route or an
Agent Eval for non-interactive verification.
::

DevTools is the fast local inspection loop. Once the answer looks right, turn the
expectation into an Agent Eval:

::code-tree-intersection
```ts [server/agents/support/eval.ts]
import { defineEval, textContains } from '@vitehub/agent/eval'

export default defineEval({
  scenarios: [
    {
      name: 'answers refund policy',
      input: {
        prompt: 'What is our refund policy?',
      },
      scorers: [
        textContains('30 days'),
      ],
    },
  ],
})
```
::

The eval imports the sibling Agent Definition by convention, runs the same Agent
Invocation path, and scores the text output. Use evals for behavior you want to
protect, not for every prompt you try manually.

## What to remember

The support Agent is small, but it shows the core ViteHub split:

- The Agent owns model behavior.
- Capabilities define what it can do.
- The Workspace supplies named source context.
- DevTools explains a live invocation.
- Agent Evals protect behavior that should stay stable.

From here, you can add more Sources, attach more Capabilities, or move the same
Agent toward a hosted runtime without changing the core definition.

## Next steps

::u-page-grid{class="pb-2"}
  :::u-page-card
  ---
  title: Agent
  description: Customize model runs, routes, triggers, usage telemetry, and Agent Evals.
  icon: i-lucide-bot
  to: ../agent
  ---
  :::
  :::u-page-card
  ---
  title: Workspace
  description: Add file, glob, fetch, and GitHub Sources to the Workspace file tree.
  icon: i-lucide-folder-git-2
  to: ../workspace
  ---
  :::
  :::u-page-card
  ---
  title: Cloudflare
  description: Deploy ViteHub features to Cloudflare-backed runtime primitives.
  icon: i-simple-icons-cloudflare
  to: ../providers/cloudflare
  ---
  :::
  :::u-page-card
  ---
  title: Vercel
  description: Deploy ViteHub features to Vercel-backed runtime primitives.
  icon: i-simple-icons-vercel
  to: ../providers/vercel
  ---
  :::
::
