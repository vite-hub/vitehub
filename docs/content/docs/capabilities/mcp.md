---
title: mcp()
description: Connect an Agent to external MCP server tools.
navigation.title: mcp()
navigation.order: 120
icon: i-lucide-plug
---

`mcp()` connects an Agent to external Model Context Protocol servers.
It resolves each configured MCP Server and exposes its tools as model-facing Agent tools.

## What it adds

The Capability normalizes MCP tool names with the server name, attaches sanitized MCP metadata, and closes MCP clients after the invocation.
It can also contribute instructions that name the configured MCP servers.

## Minimum attach example

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
| Model-backed | Receives normalized MCP tools and optional instructions. |
| Harness-backed | Runtime connection and cleanup can run; model-facing MCP tools are not passed by default. |
| Custom-run-backed | Receives prepared context; `driver.run` decides whether to call MCP clients or tools through custom code. |

## Inspect and verify

Inspect the Agent tool list in DevTools.
MCP tools should use normalized names such as `mcp_docs_search`.

Run one invocation with a duplicate normalized tool name during development.
The Capability should fail before model execution.

## Reference

- [Official capabilities](/docs/capabilities/official-capabilities)
- [Custom capabilities](/docs/capabilities/custom-capabilities)
- Source: `packages/agent/src/capabilities/mcp.ts`
