---
title: Blob
description: Expose scoped Blob read and optional edit tools to an Agent.
navigation.title: Blob
navigation.order: 80
navigation.group: Runtime primitives
icon: i-lucide-file-box
---

`blob()` adds model-facing tools for a configured ViteHub Blob primitive.
It exposes object read, metadata, and list operations by default, then adds edits only in write mode.

## Installation

Import the Capability factory from `@vite-hub/agent/capabilities` and add it to `defineAgent({ capabilities })`.
Use the configuration example below as the starting point, then tighten modes, policies, stores, and providers for the Agent boundary.

## What it adds

The Capability contributes `blob_read` for get, head, and list operations.
When configured with write mode, it also contributes `blob_edit` for putting or deleting objects.

## Configuration

Attach Blob in read mode until the Agent needs to write objects.
The Blob primitive must already be configured by the app.

```ts [server/agents/support.ts]
import { defineAgent } from '@vite-hub/agent'
import { blob } from '@vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model },
  capabilities: [
    blob({ mode: 'read' }),
  ],
})
```

## Runtime behavior

ViteHub selects the configured Blob store and exposes a small Storage Capability Tool Surface.
Read mode supports one object read, metadata read, or prefix list operation per tool call.
Write mode adds put/delete operations with approval required by default.

## Requirements

`blob()` requires a configured `blob` primitive.
Named store selection requires the Blob primitive to expose store selection.

Writes require write mode and should keep approval enabled unless the product explicitly accepts autonomous storage writes.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Receives `blob_read` and, in write mode, `blob_edit`. |
| Harness-backed | Runtime requirements apply; model-facing Blob tools are not passed by default. |
| Custom-run-backed | The configured primitive is available through runtime context; `driver.run` decides how to use it. |

## Inspect and verify

Inspect the Agent tool list in DevTools.
Read mode should show only `blob_read`; write mode should also show `blob_edit` with the configured policy.

Run one invocation against a missing Blob primitive during development.
The Capability should fail before exposing tools.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `mode` | `"read" \| "write"` | `"read"` | Adds `blob_edit` when set to `"write"`. |
| `store` | `string` | default store | Selects a named Blob store when the Blob primitive supports `store()`. |
| `policy` | `AgentToolPolicyDecision \| function` | `"require-approval"` | Policy for `blob_edit`. |

## Reference

- [Blob primitive](/docs/server-primitives/blob)
- [Official capabilities](/docs/capabilities/official-capabilities)
- Source: `packages/agent/src/capabilities/storage/blob.ts`
