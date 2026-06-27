---
title: Entry
description: Add a small product-owned Agent Trigger Capability.
navigation.title: Entry
navigation.order: 30
navigation.group: Invocation
icon: i-lucide-door-open
---

`entry()` creates a small official Capability for app-owned product events.
Use it when a product event needs an Agent Trigger but the behavior has not earned a full product-specific Capability name.

## Installation

Import the Capability factory from `@vite-hub/agent/capabilities` and add it to `defineAgent({ capabilities })`.
Use the configuration example below as the starting point, then tighten modes, policies, stores, and providers for the Agent boundary.

## What it adds

`entry()` adds Capability metadata and any Agent Triggers supplied by the application.
The Capability keeps trigger behavior attached to the Agent Definition instead of registering a separate route or channel helper.

## Configuration

Pass a stable id and a trigger map.
The trigger definitions remain app-owned, while ViteHub composes them through the Capability lifecycle.

```ts [server/agents/support.ts]
import { defineAgent } from '@vite-hub/agent'
import { entry } from '@vite-hub/agent/capabilities'
import { ticketCreatedTrigger } from '../triggers/ticket-created'

export default defineAgent({
  driver: { model },
  capabilities: [
    entry({
      id: 'support-events',
      triggers: {
        ticketCreated: ticketCreatedTrigger,
      },
    }),
  ],
})
```

## Runtime behavior

ViteHub exposes each trigger as `<entry id>.<trigger name>`.
The trigger maps product event input into Agent Invocation input and run metadata; Agent execution still belongs to the Agent Package.

## Requirements

`entry()` requires a stable id.
Trigger names must be stable local identifiers.

The Capability does not create public routes by itself.
An app route, webhook, DevTools surface, or another host component must consume the resolved Agent Trigger.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Receives Agent Invocation input produced by the trigger. |
| Harness-backed | Receives Agent Invocation input produced by the trigger. |
| Custom-run-backed | Receives Agent Invocation input produced by the trigger; `driver.run` owns the result. |

## Inspect and verify

Inspect the Agent trigger list and verify the trigger id uses the Capability id plus trigger name.
Invoke the trigger once from the host surface and check that the Agent Invocation metadata names the expected origin.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `id` | `string` | required | Capability id and app-owned entry id. |
| `triggers` | `Record<string, AgentTriggerDefinition>` | none | Named Agent Triggers contributed by this entry. |

## Reference

- [Agent triggers](/docs/agents/triggers)
- [Custom capabilities](/docs/capabilities/custom-capabilities)
- Source: `packages/agent/src/capabilities/entry.ts`
