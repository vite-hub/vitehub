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

The Capability normalizes MCP tool names with the server name, attaches sanitized MCP metadata, and closes MCP clients created from configs or resolvers after the invocation.
Static direct clients stay application-owned so they can be reused across invocations.
Tool names, descriptions, and schemas stay with the MCP tool contract. Put broader guidance about when to use an MCP server in Agent Driver Instructions.
An optional approved fingerprint map can block added or changed tool definitions before they reach an Agent Driver.

## Configuration

Pass a server map.
Each entry can be a static direct MCP client borrowed from the application, or a client config or resolver whose resolved client is owned by the Agent Invocation.

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
Pass a resolver or client config for an invocation-owned connection, or a static direct client when the application owns its lifetime.

The Capability redacts secret-shaped metadata keys before exposing MCP metadata.

## Pin tool definitions

An MCP Server can return a different tool description, title, or input schema after its tools were reviewed.
Use `fingerprintTools()` during a trusted review step, persist the approved result in application code or configuration, then pass it to `integrity` under the matching server name.

```ts [scripts/review-docs-mcp.ts]
import { fingerprintTools } from 'ai'

const approved = await fingerprintTools(await client.tools())
console.log(JSON.stringify(approved, null, 2))
```

Review that output before saving it. Do not generate the baseline during normal application startup, because that would trust whichever definitions the server returns first.

```ts [server/agents/support.ts]
import { defineAgent } from '@vite-hub/agent'
import { mcp } from '@vite-hub/agent/capabilities'
import { docsMcpServer } from '../mcp/docs'
import { docsToolFingerprints } from '../mcp/docs-tool-fingerprints'

export default defineAgent({
  driver: { model },
  capabilities: [
    mcp({
      integrity: {
        docs: docsToolFingerprints,
      },
      servers: {
        docs: docsMcpServer,
      },
    }),
  ],
})
```

ViteHub fingerprints each configured server independently before it normalizes or contributes tools.
Added and changed definitions fail Capability resolution; removal-only changes remain allowed because MCP tool lists can narrow by feature or authorization.
Drift errors include the server name and the added, changed, and removed original tool names.

Fingerprints cover tool names, string descriptions, titles, and resolved input schemas.
They do not prove that the first reviewed definition was safe or detect changed remote behavior behind an unchanged definition.

## Requirements

`mcp({ servers })` requires a server map. Each configured entry must resolve to an MCP client or MCP client configuration.
MCP client configuration uses the optional `@ai-sdk/mcp` runtime package when ViteHub creates the client from config.
Tool integrity requires `ai` 7.0.19 or newer only when `integrity` is configured.

The external MCP Server owns its own credentials, availability, and tool behavior.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Receives normalized MCP tools. |
| Provider-backed | Receives normalized MCP tools through the provider MCP bridge; runtime connection and cleanup still run around the invocation. |
| Custom-run-backed | Receives prepared context; `driver.run` decides whether to call MCP clients or tools through custom code. |

## Inspect and verify

Successful invocations expose normalized MCP tools through `agent info` and stream tool steps through `agent dev`.
MCP tools should use normalized names such as `mcp_docs_search`.

Integrity checks run during invocation resolution. Static Agent inspection metadata does not connect to MCP Servers or claim that a configured baseline currently matches.

Run one invocation with a duplicate normalized tool name during development.
The Capability should fail before model execution.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `integrity` | `Record<string, McpToolFingerprints>` | none | Approved AI SDK tool fingerprints keyed by configured server name. Blocks added or changed definitions. |
| `servers` | `Record<string, McpServerConfig>` | required | MCP clients, client configs, or resolvers keyed by server name. |

Cover MCP usage guidance in Agent Driver Instructions with explicit Capability coverage blocks. Keep MCP tool descriptions with the MCP Server because they are structured tool contracts.

## Reference

- [Official capabilities](/docs/capabilities/official-capabilities)
- [Custom capabilities](/docs/capabilities/custom-capabilities)
- [AI SDK MCP tool-definition drift](https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools#detecting-tool-definition-drift-rug-pull)
- Source: `packages/agent/src/capabilities/mcp.ts`
