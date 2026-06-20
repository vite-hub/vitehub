---
title: kv()
description: Expose scoped KV read and optional edit tools to an Agent.
navigation.title: kv()
navigation.order: 70
icon: i-lucide-key-round
---

`kv()` adds model-facing tools for a configured ViteHub KV primitive.
It exposes read tools by default and edit tools only in write mode.

## What it adds

The Capability contributes `kv_read` for exact-key reads or prefix key listing.
When configured with write mode, it also contributes `kv_edit` for putting or deleting one key.

## Minimum attach example

Attach KV in read mode until the product needs model-facing writes.
The KV primitive must already be configured by the app.

```ts [server/agents/support.ts]
import { defineAgent } from '@vite-hub/agent'
import { kv } from '@vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model },
  capabilities: [
    kv({ mode: 'read' }),
  ],
})
```

## Runtime behavior

ViteHub selects the configured KV store and exposes a small Storage Capability Tool Surface.
Read mode supports one exact key or one prefix per tool call.
Write mode adds a put/delete tool with approval required by default.

## Requirements

`kv()` requires a configured `kv` primitive.
Named store selection requires the KV primitive to expose store selection.

Writes require write mode and should keep approval enabled unless the product explicitly accepts autonomous storage writes.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Receives `kv_read` and, in write mode, `kv_edit`. |
| Harness-backed | Runtime requirements apply; model-facing KV tools are not passed by default. |
| Custom-run-backed | The configured primitive is available through runtime context; `driver.run` decides how to use it. |

## Inspect and verify

Inspect the Agent tool list in DevTools.
Read mode should show only `kv_read`; write mode should also show `kv_edit` with the configured policy.

Run one invocation against a missing KV primitive during development.
The Capability should fail before exposing tools.

## Reference

- [KV primitive](/docs/server-primitives/kv)
- [Official capabilities](/docs/capabilities/official-capabilities)
- Source: `packages/agent/src/capabilities/storage/kv.ts`
