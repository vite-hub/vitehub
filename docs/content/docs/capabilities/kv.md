---
title: KV
description: Expose scoped KV read and optional edit tools to an Agent.
navigation.title: KV
navigation.order: 70
navigation.group: Runtime primitives
icon: i-lucide-key-round
---

`kv()` adds model-facing tools for a configured ViteHub KV primitive.
It exposes read tools by default and edit tools only in write mode.

The Capability contributes `kv_read` for exact-key reads or prefix key listing.
When configured with write mode, it also contributes `kv_edit` for putting or deleting one key.

## Configure KV access

Attach KV in read mode until the product needs model-facing writes.
The KV primitive must already be configured by the app.

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
import { kv } from 'vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model },
  capabilities: [
    kv({ mode: 'read' }),
  ],
})
```

## How KV access works

ViteHub selects the configured KV store and exposes the KV tools.
Read mode supports one exact key or one prefix per tool call.
Write mode adds a put/delete tool and allows its normal operations by default.

## Requirements

`kv()` requires a configured `kv` primitive.
Named store selection requires the KV primitive to expose store selection.

Writes require explicit write mode.
Set `policy: 'require-approval'` or `policy: 'deny'` when the product needs an additional gate.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Receives `kv_read` and, in write mode, `kv_edit`. |
| Provider-backed | Receives KV tools through the provider MCP bridge. |
| Custom-run-backed | The configured primitive is available through runtime context; `driver.run` decides how to use it. |

## Verify KV access

Run `vitehub agent info --agent <name> --json` and inspect the resolved tool list.
Confirm that read mode shows only `kv_read`. Write mode also lists `kv_edit` with the configured policy.

Run one invocation against a missing KV primitive during development.
Confirm that the Capability fails before it exposes tools.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `mode` | `"read" \| "write"` | `"read"` | Adds `kv_edit` when set to `"write"`. |
| `store` | `string` | default store | Selects a named KV store when the KV primitive supports `store()`. |
| `policy` | `AgentToolPolicyDecision \| function` | `"allow"` | Policy for `kv_edit`. |

## Related pages

- [KV primitive](/docs/server-primitives/kv)
- [Official capabilities](/docs/capabilities/official-capabilities)
