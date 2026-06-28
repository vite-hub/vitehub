---
title: Capabilities API
description: Understand how Agents attach controlled model-facing abilities without raw top-level tools.
navigation.order: 8
icon: i-lucide-blocks
---

A Capability is a shareable ViteHub bundle that adds a named Agent ability. Capabilities attach through `defineAgent({ capabilities })` and can contribute tools, requirements, trigger behavior, policy, metadata, and invocation context values.

Tools belong to Capability Definitions. They are not top-level Agent Definition fields.

## Why it exists

Raw tools make validation, policy, DevTools metadata, and driver support hard to inspect. A Capability keeps the ability, requirements, tool contracts, and runtime behavior together.

Capabilities also keep primitive access explicit. Installing KV does not let every Agent read KV; attaching `kv()` decides whether a model receives KV read or edit tools.

## Official capability imports

Official Capability factories live on `@vite-hub/agent/capabilities`.

```ts [server/agents/support.ts]
import { gateway } from '@ai-sdk/gateway'
import { defineAgent } from '@vite-hub/agent'
import { kv, workspaceShell } from '@vite-hub/agent/capabilities'

export default defineAgent({
  driver: {
    instructions: [
      'Answer from the workspace before using storage.',
      'Use KV only for configured support records.',
    ].join('\n\n'),
    model: gateway('openai/gpt-5.1-mini'),
  },
  workspace: {
    sources: {},
  },
  capabilities: [
    workspaceShell({ mode: 'read' }),
    kv({ mode: 'read' }),
  ],
})
```

The Agent Package root stays focused on Agent Definition, invocation, message, and composition primitives. Capability factories stay on the capability subpath so model-facing abilities remain visible.

## What a Capability can contribute

| Contribution | Purpose |
| --- | --- |
| Requirements | Primitive, Workspace mode, path, store, or policy requirements checked early. |
| Tools | Model-facing operations such as read, edit, query, execute, search, or transcribe. |
| Trigger behavior | Product events that start Agent Invocations. |
| Policy | Approval and safety decisions for model-facing actions. |
| Invocation context values | Typed data that later Agent and Capability callbacks can read. |
| Metadata | Inspectable configuration for runtime and DevTools surfaces. |

## Static attachment

Capabilities are attached before the Agent Invocation runs. Pre-Invocation Decisions can record context values, reject, or influence conditional contributions, but they do not dynamically attach new Capabilities.

Capabilities run in array order. A Capability can include nested default Capabilities, but an explicitly listed Capability keeps its top-level position.

Free-form Capability guidance belongs in Agent Driver Instructions or deterministic imported instruction Markdown. Tool descriptions and schemas stay with the tool because they are structured tool contracts, not arbitrary system instructions.

## Next steps

- Read the [Capabilities](/docs/capabilities) section.
- Read [Runtime policy, approvals, and traces](/docs/concepts/runtime-policy-approvals-and-traces).
- Read [First agent](/docs/getting-started/first-agent) for a minimal Agent Definition.
