---
title: Usage
description: Request provider usage metadata and expose the normalized Agent Usage Record at finish.
navigation.title: Usage
navigation.order: 225
navigation.group: Decisions and output
icon: i-lucide-chart-no-axes-column
---

Add `usage()` to request the provider's complete usage metadata and expose ViteHub's normalized Agent Usage Record as a typed Finish Extension.

## Add usage

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
import { usage } from 'vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model: 'anthropic/claude-sonnet-4.5' },
  capabilities: [usage()],
})
```

For OpenRouter calls, the Capability sets `providerOptions.openrouter.usage.include` to `true`. Existing provider options and OpenRouter usage settings are preserved.

## Read the record

The Capability's typed `usage` Finish Extension returns the same normalized record available at `event.invocation.usage`.

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
import { usage } from 'vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model: 'anthropic/claude-sonnet-4.5' },
  capabilities: [usage()],
  hooks: {
    'agent:finish'(event) {
      console.log(event.invocation.usage)
      console.log(event.extensions.get('usage'))
    },
  },
})
```

The record can contain normalized token usage, model and transport metadata, provider-reported cost, and other provider usage metadata. Fields remain optional when the provider does not report them.

## Verify it

Invoke the Agent through OpenRouter and inspect the provider call settings and Finish Event. Confirm that `usage.include` is enabled without replacing existing provider options, and that the `usage` Finish Extension matches `event.invocation.usage`.

## Related

- [Cost capability](/docs/capabilities/cost)
- [Agent Invocations](/docs/concepts/agent-invocations)
- [Runtime events](/docs/reference/runtime-events)
