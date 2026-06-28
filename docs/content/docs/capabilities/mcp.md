---
title: MCP
description: Connect an Agent to external MCP server tools.
navigation.title: MCP
navigation.order: 120
navigation.group: External context
icon: i-lucide-plug
---

`mcp()` connects an Agent to external Model Context Protocol servers.
It resolves each configured MCP Server and exposes its tools as model-facing Agent tools.

## Installation

Import the Capability factory from `@vite-hub/agent/capabilities` and add it to `defineAgent({ capabilities })`.
Use the configuration example below as the starting point, then tighten modes, policies, stores, and providers for the Agent boundary.

## What it adds

The Capability normalizes MCP tool names with the server name, attaches sanitized MCP metadata, and closes MCP clients after the invocation.
Tool names, descriptions, and schemas stay with the MCP tool contract. Put broader guidance about when to use an MCP server in Agent Driver Instructions.

## Configuration

Pass a server map.
Each entry can resolve to an MCP client or MCP client configuration owned by the application.

```ts [server/agents/support.ts]
import { defineAgent } from '@vite-hub/agent'
import { mcp } from '@vite-hub/agent/capabilities'
import { docsMcpServer } from '../mcp/docs'

export default defineAgent({
  driver: { model },
  capabilities: [
    mcp({
      servers: {
        docs: docsMcpServer,
      },
    }),
  ],
})
```

## Runtime behavior

During resolution, `mcp()` connects to each configured MCP Server and asks for its tool set.
ViteHub prefixes normalized tool names with `mcp_<server>_` and rejects duplicate normalized names.

The Capability redacts secret-shaped metadata keys before exposing MCP metadata.

## Requirements

`mcp({ servers })` requires a non-empty server map.
MCP client configuration uses the optional `@ai-sdk/mcp` runtime package when ViteHub creates the client from config.

The external MCP Server owns its own credentials, availability, and tool behavior.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Receives normalized MCP tools. |
| Harness-backed | Runtime connection and cleanup can run; model-facing MCP tools are not passed by default. |
| Custom-run-backed | Receives prepared context; `driver.run` decides whether to call MCP clients or tools through custom code. |

## Inspect and verify

Inspect the Agent tool list in DevTools.
MCP tools should use normalized names such as `mcp_docs_search`.

Run one invocation with a duplicate normalized tool name during development.
The Capability should fail before model execution.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `servers` | `Record<string, McpServerConfig>` | required | MCP clients, client configs, or resolvers keyed by server name. |
| `instructions` | `string \| false` | generated | Current override for generated MCP tool instructions. Prefer explicit Capability coverage in Agent Driver Instructions for new guidance. |

## Reference

- [Official capabilities](/docs/capabilities/official-capabilities)
- [Custom capabilities](/docs/capabilities/custom-capabilities)
- Source: `packages/agent/src/capabilities/mcp.ts`
