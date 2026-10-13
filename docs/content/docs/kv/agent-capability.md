---
title: KV capability
description: Give an Agent a KV read tool and, in write mode, a tool that puts or deletes one key.
navigation.title: Agent capability
navigation.order: 5
icon: i-lucide-key-round
---

`kv()` gives an Agent the `kv_read` tool. In write mode, it also gives the `kv_edit` tool.
Both tools call the configured [KV primitive](/docs/kv).
The [KV server API](/docs/kv/server-api) covers application code. This page covers the Agent tools.

## Configure KV access

Attach KV in read mode until the Agent must write keys.

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

To let the Agent write, set `mode: 'write'`. Use `store` to limit the Agent to one named KV Store, and `policy` to gate writes.

```ts [server/agents/support.ts]
kv({ mode: 'write', policy: 'require-approval', store: 'agent-notes' })
```

## Agent-visible tool contract

These definitions are resolved from the real Capability during the docs build.

### Read mode

::agent-capability-tools{name="kv" variant="read"}
::

### Write mode

::agent-capability-tools{name="kv" variant="write"}
::

## How KV access works

When the Agent Invocation resolves its tools, the Capability reads the `kv` runtime handle. With `store`, it calls `store(name)` on that handle and uses the result.

- `kv_read` accepts exactly one of `key` or `prefix`. It fails when the input has both or neither.
- `kv_read` with `key` returns the value from `get(key)`.
- `kv_read` with `prefix` returns the key names from `keys(prefix)`. It does not return values, and it does not limit the number of keys.
- `kv_edit` with `operation: 'put'` calls `set(key, value)`. With `operation: 'delete'`, it calls `del(key)`.

When the KV handle returns an `[error, value]` tuple, the tool throws the error or returns the value.

## Requirements

- Configure the KV primitive. Generated Agent routes pass `kv` from `@vite-hub/kv` to the Capability when the KV Vite integration is active.
- Without a `kv` handle, tool resolution fails with `Capability "kv" requires the kv primitive to be configured.` The Agent Driver does not receive KV tools.
- `store` requires a KV handle that exposes `store()`.

## Security and approval

- Read mode lets the Agent read any key and list key names under any prefix in the selected store. The tool description says "developer-provided prefix", but the Capability does not enforce a prefix scope. To limit what the Agent can see, select a dedicated store with `store`.
- Write mode lets the Agent put or delete any key in the selected store.
- `policy` applies only to `kv_edit`. `kv_read` has no policy gate.
- `policy` accepts `'allow'`, `'require-approval'`, `'deny'`, `'retryable-failure'`, or a function that receives `{ name, input }` and returns one of these values.
- Without `policy`, `kv_edit` runs when the Agent calls it.
- `'require-approval'` stops the call with `APPROVAL_REQUIRED` and an Approval Request. The write runs only after approval. See [Runtime policy, approvals, and traces](/docs/agents/runtime-policy).

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Receives `kv_read` and, in write mode, `kv_edit`. |
| Provider-backed | Receives the same tools through the provider MCP bridge. |
| Custom-run-backed | `driver.run` receives the tools in `context.tools` and decides whether to call them. |

## Verify KV access

1. Start the Vite development server.
2. Run `vitehub agent info --agent support --json`. Confirm that `tools` contains an entry with `name: "kv"`. Inspection lists one entry for each Capability, not one entry for each tool.
3. Run `vitehub agent dev "Read the key app:1" --agent support`. Confirm that the output shows a `[tool] kv_read` call.
4. In read mode, ask the Agent to change a key. Confirm that it has no `kv_edit` tool.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `mode` | `"read" \| "write"` | `"read"` | Adds `kv_edit` when set to `"write"`. Other values fail when the Agent Definition loads. |
| `store` | `string` | default store | Selects a named KV Store through `store()` on the KV handle. |
| `policy` | `AgentToolPolicyDecision \| (context) => AgentToolPolicyDecision \| Promise<AgentToolPolicyDecision>` | none (calls run) | Policy for `kv_edit`. Has no effect in read mode. |

## Related pages

- [KV primitive](/docs/kv)
- [Official capabilities](/docs/agents/capabilities/official)
- [Runtime policy, approvals, and traces](/docs/agents/runtime-policy)
