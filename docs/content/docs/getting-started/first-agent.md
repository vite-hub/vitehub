---
title: First agent
description: Define a model-backed Agent and run one invocation from server code.
navigation.order: 4
icon: i-lucide-bot
---

An Agent is a model-backed server actor. Start with one Agent Definition, then attach capabilities only when the Agent needs controlled access to tools or context.

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
  instructions: 'Answer support questions with short, concrete replies.',
  model: gateway('openai/gpt-5.1-mini'),
})
```

The discovered Agent name comes from the file location. This file creates the `support` Agent.

## Run an invocation

Call the Agent from ordinary server code.

```ts [server/api/support.post.ts]
import { runAgent } from '@vite-hub/agent'
import support from '../agents/support'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ prompt: string }>(event)

  return runAgent(support, { runtime: 'unknown' }, {
    prompt: body.prompt,
  })
})
```

## Add capabilities later

Capabilities expose model-facing abilities. Do not attach storage, workspace, or execution access until the product needs it.

```ts [server/agents/support.ts]
import { workspaceShell } from '@vite-hub/agent/capabilities'

export default defineAgent({
  instructions: [
    'Answer from project context first.',
    '{{ capabilities }}',
  ].join('\n\n'),
  model,
  capabilities: [
    workspaceShell({ mode: 'read' }),
  ],
})
```

Continue with [Agent definitions](/docs/agents/agent-definitions) for the full declaration shape, or open [Custom capabilities](/docs/agents/capabilities/custom-capabilities) when the official capability catalog does not describe the ability your Agent needs.
