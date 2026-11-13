---
title: KV capability
description: Give an Agent a KV read tool and, in write mode, a tool that puts or deletes one key.
navigation.title: Agent capability
navigation.order: 5
icon: i-lucide-key-round
---

The `kv()` Capability gives an Agent the `kv_read` tool, plus `kv_edit` in write mode. Both call the [KV primitive](/docs/kv). App code uses the [KV server API](/docs/kv/server-api).

## Configure KV access

Start in read mode. Switch only when the Agent must write keys.

```ts [server/agents/support.ts] fragment
import { defineAgent } from 'vite-hub/agent'
import { kv } from 'vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model },
  capabilities: [
    kv({ mode: 'read' }),
  ],
})
```

`mode: 'write'` allows writes. `store` limits the Agent to one store. `prefix` limits it to the keys under one prefix. `policy` controls writes.

```ts [server/agents/support.ts] fragment
kv({ mode: 'write', policy: 'require-approval', store: 'agent-notes', prefix: 'support:' })
```

## Agent-visible tool contract

The docs build reads these definitions from the real Capability.

### Read mode

::agent-capability-tools{name="kv" variant="read"}
::

### Write mode

::agent-capability-tools{name="kv" variant="write"}
::

## How KV access works

When an Agent run loads its tools, the Capability reads the `kv` runtime handle, or `store(name)` of it with `store`.

- `kv_read` takes exactly one of `key` or `prefix`. It fails with both or neither.
- With `key`, it returns `get(key)`. With `prefix`, it returns key names from `keys(prefix)`, without values or a count limit.
- `kv_edit` calls `set(key, value)` for `operation: 'put'` and `delete(key)` for `operation: 'delete'`.

With `prefix`, every key must be under the prefix. The Capability normalizes keys as the KV primitive does: `/` and `\` become `:`. Then it checks the prefix at a `:` boundary. With `prefix: 'support:'`, `support:1` and `support/1` are inside, but `support`, `support-private:1`, and `support:..:secret` are not. A key outside the prefix fails with `AGENT_R1045` and the store is not called. A `kv_read` list of `support` lists `support:`. A list prefix outside the prefix fails, and the list result keeps only keys inside the prefix.

When the handle returns `[error, value]`, the tool throws the error or returns the value.

## Requirements

- Enable KV. Generated Agent routes then pass `kv` from `vite-hub/kv` to the Capability.
- Without a `kv` handle, loading tools fails with `Capability "kv" requires the kv primitive to be configured.` and the Agent Driver gets no KV tools.
- `store` needs a KV handle with `store()`.

## Security and approval

- Without `prefix`, read mode lets the Agent read any key and list any prefix in the selected store, and write mode lets it put or delete any key.
- With `prefix`, both tools stay inside the prefix. The tool descriptions tell the Agent the prefix.
- To keep the Agent away from other data completely, give it its own store with `store`.
- `policy` applies only to `kv_edit`, never to `kv_read`.
- `policy` accepts `'allow'`, `'require-approval'`, `'deny'`, `'retryable-failure'`, or a function that gets `{ name, input }` and returns one of them.
- Without `policy`, `kv_edit` runs when the Agent calls it.
- `'require-approval'` stops the call with `APPROVAL_REQUIRED` and an Approval Request. The write runs after approval ([Runtime policy, approvals, and traces](/docs/agents/runtime-policy)).

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Gets `kv_read`, and `kv_edit` in write mode. |
| Provider-backed | Gets the same tools through the provider MCP bridge. |
| Custom-run-backed | `driver.run` gets the tools in `context.tools` and decides whether to call them. |

## Verify KV access

1. Start the Vite dev server.
2. Run `vitehub agent info --agent support --json`. Check that `tools` has an entry with `name: "kv"`. It lists one entry per Capability, not per tool.
3. Run `vitehub agent dev "Read the key app:1" --agent support`. Check that the output shows a `[tool] kv_read` call.
4. In read mode, ask the Agent to change a key. It must have no `kv_edit` tool.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `mode` | `"read" \| "write"` | `"read"` | `"write"` adds `kv_edit`. Other values fail when the Agent Definition loads. |
| `store` | `string` | default store | Picks a named store through `store()` on the KV handle. |
| `prefix` | `string` | none (whole store) | Limits `kv_read` and `kv_edit` to keys under this prefix, such as `support:`. An empty prefix or one with `.` or `..` segments fails with `AGENT_R1044` when the Agent Definition loads. |
| `policy` | `AgentToolPolicyDecision \| (context) => AgentToolPolicyDecision \| Promise<AgentToolPolicyDecision>` | none (calls run) | Policy for `kv_edit`. No effect in read mode. |

## Related pages

- [KV primitive](/docs/kv)
- [Official capabilities](/docs/agents/capabilities/official)
- [Runtime policy, approvals, and traces](/docs/agents/runtime-policy)
