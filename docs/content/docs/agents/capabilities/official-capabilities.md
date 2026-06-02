---
title: Official capabilities
description: Use the ViteHub capability catalog by agent ability, not by package boundary.
navigation.title: Official capabilities
navigation.group: Capabilities
navigation.order: 27
icon: i-lucide-list-checks
---

Official Capabilities are imported from `@vite-hub/agent/capabilities`.

```ts
import {
  access,
  blob,
  chat,
  db,
  entry,
  kv,
  llmGate,
  llmRoute,
  mcp,
  sandbox,
  transcribe,
  webSearch,
  workspaceShell,
} from '@vite-hub/agent/capabilities'
```

## Catalog

| Ability | Capability | Use it when |
| --- | --- | --- |
| Chat behavior | `chat()` | A chat surface should start Agent Invocations and manage Chat History. |
| App entry | `entry()` | An app-owned surface should expose a trusted Chat App Route or custom Agent Trigger. |
| Workspace files | `workspaceShell()` | The model should inspect or edit Workspace files. |
| Storage | `kv()`, `blob()`, `db()` | The model needs scoped access to configured storage primitives. |
| Isolated execution | `sandbox()` | The model should run explicit commands in an isolated runtime. |
| Access scope | `access()` | Invocation identity should narrow Workspace Scope before tools are exposed. |
| Web context | `webSearch()` | The model needs web search or URL reading. |
| MCP servers | `mcp()` | The Agent should consume external MCP tools. |
| Audio input | `transcribe()` | Audio message parts should become transcript text before the Agent runs. |
| Routing and gates | `llmRoute()`, `llmGate()` | A pre-invocation model decision should select a route or reject input. |

## Storage capabilities

Storage Capabilities are intentionally small. KV and Blob expose read/edit surfaces instead of every primitive method. Database exposes database-native schema, query, and execute tools with guardrails.

Writes require approval by default unless the developer opts into autonomous behavior.

## Chat state

The Chat Capability can use an Agent State Provider for Chat History and the Concurrent Invocation Guard. Cloudflare deployments can use the Cloudflare Agent State Provider. Nitro node deployments can opt into the SQLite/libSQL provider explicitly:

```ts [vite.config.ts]
export default defineConfig({
  agent: {
    providers: {
      state: {
        provider: 'sqlite',
        url: process.env.VITEHUB_AGENT_STATE_URL,
      },
    },
  },
})
```

`file:` URLs use local SQLite. Hosted libSQL URLs use the same provider with an auth token when needed. This state is internal Agent runtime state, not model-facing Database Capability access.

## Execution capabilities

Sandbox and Workspace Shell are different.

Workspace Shell exposes shell-shaped Workspace inspection and optional structured Workspace mutation tools. Sandbox runs configured commands in an isolated runtime.

Without an execution Capability, an Agent cannot execute programs.

## Routing and gates

`llmRoute()` and `llmGate()` produce typed Pre-Invocation Decisions. They do not dynamically attach new Capabilities or mutate the Agent Definition.

Use them to record a decision, reject a request, or let later callbacks read a typed context value.
