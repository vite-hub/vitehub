---
title: Invocations
description: Run or stream one Agent request and inspect the resulting lifecycle.
navigation.order: 23
icon: i-lucide-play-circle
---

An Agent Invocation is one runtime request to an Agent. It starts with input, applies capabilities, runs the model or custom handler, records lifecycle events, and returns a result.

## Run an agent

```ts [server/api/support.post.ts]
import { runAgent } from '@vite-hub/agent'
import support from '../agents/support'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ prompt: string }>(event)

  return runAgent(support, { runtime: 'nitro' }, {
    prompt: body.prompt,
  })
})
```

## Stream an agent

```ts
import { streamAgent } from '@vite-hub/agent'

const result = await streamAgent(support, { runtime: 'nitro' }, {
  prompt: 'Summarize the latest support docs.',
})
```

Streaming is useful for chat interfaces and long model responses. The same Capability boundaries still apply.

## Finish hooks

Use an Agent Finish Hook when you need to observe the completed outcome.

```ts
export default defineAgent({
  hooks: {
    'agent:finish'(event) {
      event.runtime.waitUntil(syncUsage(event))
    },
  },
  instructions,
  model,
})
```

Finish hooks are for observation, export, telemetry, or cleanup. They should not quietly grant new abilities to the Agent.

## Invocation context values

Capabilities can record typed Agent Invocation Context Values before later callbacks run. Use them for decisions such as access scope, route selection, chat identity, or gate results.

Context values do not dynamically grant Capabilities. Capability attachment remains server-configured in the Agent Definition.
