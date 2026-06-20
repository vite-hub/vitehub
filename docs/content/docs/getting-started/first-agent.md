---
title: First agent
description: Define an Agent and run one Agent Invocation from server code.
navigation.order: 4
icon: i-lucide-bot
---

An Agent is a named server-side actor driven by an Agent Driver. Start with one Agent Definition, then attach Capabilities only when the Agent needs controlled access to tools, Workspace files, storage, chat, or product events.

## Install agents

```bash [Terminal]
pnpm add @vite-hub/agent @ai-sdk/gateway
```

Register the integration.

```ts [vite.config.ts]
import { hubAgent } from '@vite-hub/agent/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubAgent()],
})
```

## Define an agent

Create one Agent Definition under `server/agents`.

```ts [server/agents/support.ts]
import { gateway } from '@ai-sdk/gateway'
import { defineAgent } from '@vite-hub/agent'

export default defineAgent({
  driver: {
    instructions: 'Answer support questions with short, concrete replies.',
    model: gateway('openai/gpt-5.1-mini'),
  },
})
```

The discovered Agent name comes from the file location. This file creates the `support` Agent.

## Run an invocation

Call the Agent from ordinary server code with `runAgent()`.

```ts [server/api/support.post.ts]
import { runAgent } from '@vite-hub/agent'
import support from '../agents/support'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ prompt: string }>(event)

  return runAgent(support, { runtime: 'vite' }, {
    prompt: body.prompt,
  })
})
```

Run the app and post a prompt.

```bash [Terminal]
pnpm dev
```

```bash [Terminal]
curl -X POST http://localhost:5173/api/support \
  -H 'content-type: application/json' \
  -d '{"prompt":"What can you help with?"}'
```

The response proves one Agent Invocation can run from normal server code. The route owns HTTP behavior, while the Agent Definition owns the Agent Driver and attached Capabilities.

## Add capabilities later

Capabilities expose model-facing abilities. Do not attach storage, Workspace, chat, or execution access until the product needs it.

```ts [server/agents/support.ts]
import { gateway } from '@ai-sdk/gateway'
import { defineAgent } from '@vite-hub/agent'
import { workspaceShell } from '@vite-hub/agent/capabilities'

export default defineAgent({
  driver: {
    instructions: [
      'Answer from project context first.',
      '{{ capabilities }}',
    ].join('\n\n'),
    model: gateway('openai/gpt-5.1-mini'),
  },
  workspace: {
    sources: {},
  },
  capabilities: [
    workspaceShell({ mode: 'read' }),
  ],
})
```

`workspaceShell()` requires an explicit Workspace because Workspace is the file-tree boundary. Add Sources before relying on Workspace files for answers.

## Next steps

- Read [Agent definitions](/docs/agents/agent-definitions) for the full declaration shape.
- Read [Capabilities API](/docs/concepts/capabilities-api) before exposing model-facing abilities.
- Read [Workspace and Sources](/docs/concepts/workspace-and-sources) before adding project files.
