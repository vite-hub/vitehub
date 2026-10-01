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

The Capability normalizes MCP tool names with the server name, attaches sanitized MCP metadata, and closes MCP clients created from configs or resolvers after the invocation.
Static direct clients stay application-owned so they can be reused across invocations.
Tool names, descriptions, and schemas stay with the MCP tool contract. Put broader guidance about when to use an MCP server in Agent Driver Instructions.
An optional approved fingerprint map can block added or changed tool definitions before they reach an Agent Driver.

## Configure MCP servers

Pass a server map.
Each entry can be a static direct MCP client borrowed from the application, or a client config or resolver whose resolved client is owned by the Agent Invocation.
Use `false`, `null`, or `undefined` when a server is not configured for the current deployment or invocation.

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
import { mcp } from 'vite-hub/agent/capabilities'
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

Optional servers do not need a conditional Capability array. Declare credentials that may be absent as optional in Server Env, for example `analyticsToken: env({ optional: true, secret: true })`, then resolve only the server whose credentials are available:

```ts [server/agents/support.ts]
import { useServerEnv } from '#vitehub/env/server'
import { defineAgent } from 'vite-hub/agent'
import { mcp } from 'vite-hub/agent/capabilities'
import { remoteMcpServer } from 'vite-hub/agent/mcp'

export default defineAgent({
  driver: { model },
  capabilities: [
    mcp({
      servers: {
        analytics: () => {
          const token = useServerEnv().analyticsToken
          return token
            ? remoteMcpServer({
                headers: { Authorization: `Bearer ${token.unseal()}` },
                url: 'https://analytics.example.com/mcp',
              })
            : undefined
        },
      },
    }),
  ],
})
```

## How MCP connections work

During resolution, `mcp()` connects to each configured MCP Server and asks for its tool set.
ViteHub prefixes normalized tool names with `mcp_<server>_` and rejects duplicate normalized names.
Pass a resolver or client config for an invocation-owned connection, or a static direct client when the application owns its lifetime.
An absent entry contributes no tools and creates no MCP client. Other configured servers still resolve.
Transient transport failures during resolution or discovery mark the affected server unavailable and let other servers contribute tools. Authentication, configuration, cancellation, protocol, integrity, cleanup, and other resolver failures remain fatal.

Generic MCP client configurations default top-level `protocolVersionDiscovery` to `false` so existing initialize-first servers remain compatible. Set it to `true` on a client configuration when the server supports protocol-version discovery.

The Capability redacts secret-shaped metadata keys before exposing MCP metadata.

## Call a tool from application code

Use `callMcpTool()` when application code needs one tool result outside an Agent Invocation, for example in a Channel Trigger or a Schedule. Pass the same value that you use as an `mcp({ servers })` entry, so both paths share one server definition:

```ts [server/agents/support.ts]
import { useServerEnv } from '#vitehub/env/server'
import { callMcpTool, remoteMcpServer } from 'vite-hub/agent/mcp'

export const productlaneServer = () => remoteMcpServer({
  headers: { Authorization: `Bearer ${useServerEnv().productlane.token.unseal()}` },
  url: 'https://productlane.com/api/mcp',
})

const [error, thread] = await callMcpTool(productlaneServer, 'threads_get', { id: threadId })
```

The call opens a client, sends `tools/call`, and closes a client that it created. A static direct client stays open. Streamable HTTP servers can answer with JSON or with Server-Sent Events.

The result is a tuple. On success, the value is the tool's `structuredContent`. Without structured content, the value is the text content, parsed as JSON when it is valid JSON. A tool result with `isError`, a missing tool, or a connection failure returns `[error, null]`. A server function receives no Agent context, and `callMcpTool()` does not record `vitehub.mcp.warnings`.

The optional fourth argument accepts `signal` for cancellation and `timeout` in milliseconds. The timeout bounds tool discovery and execution after the client connects. Both direct calls and fallback tool execution receive the cancellation signal.

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
import { defineAgent } from 'vite-hub/agent'
import { mcp } from 'vite-hub/agent/capabilities'
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

`mcp({ servers })` requires a server map. Each present entry must resolve to an MCP client or MCP client configuration. `false`, `null`, and `undefined` skip that entry.
MCP client configuration uses the optional `@ai-sdk/mcp` runtime package when ViteHub creates the client from config.
Tool integrity requires `ai` 7.0.19 or newer only when `integrity` is configured.

The external MCP Server owns its own credentials, availability, and tool behavior.

During resolution and tool discovery, transient transport failures make only the affected server unavailable. Other servers retain their tools. HTTP 408, 409, 429, and 5xx responses, recognized network errors, and bounded timeouts produce entries in the Invocation input context at `vitehub.mcp.warnings`. Each entry records the server, phase, and HTTP status when available. Read them with `getMcpWarnings(input)`, which returns typed `McpAvailabilityWarning` entries. Inspection marks the server `Unavailable`.

Authentication, configuration, cancellation, protocol errors, duplicate tools, and tool-definition integrity drift remain fatal. This degradation applies to `mcp()`; Executor connection and discovery failures remain fatal.

### Tell chat users about unavailable servers

Set `unavailableNotice` to append a notice to the final chat reply when a server is unavailable. `true` uses the default text, for example `> ⚠️ posthog tools were temporarily unavailable. I answered with the remaining context.` A function receives the names of the unavailable servers and returns the notice.

```ts
mcp({
  servers: { posthog: posthogServer },
  unavailableNotice: servers => `${servers.join(', ')} was unavailable. This answer may be incomplete.`,
})
```

With `messages.loading` or durable delivery, the notice is part of the final reply. When the reply streams, or with `stream: false`, the notice follows as a separate message. With `messages.delivery: 'manual'`, ViteHub posts no notice. Read the warnings in a finish hook with `getMcpWarnings(event.input)`:

```ts
import { getMcpWarnings } from 'vite-hub/agent/capabilities'

hooks: {
  'agent:finish': (event) => {
    const servers = getMcpWarnings(event.input).map(warning => warning.server)
    if (servers.length) return event.reply(`Unavailable: ${servers.join(', ')}`)
  },
}
```

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Receives normalized MCP tools. |
| Provider-backed | Receives normalized MCP tools through the provider MCP bridge; runtime connection and cleanup still run around the invocation. |
| Custom-run-backed | Receives prepared context; `driver.run` decides whether to call MCP clients or tools through custom code. |

## Verify MCP connections

Successful invocations expose normalized MCP tools through `agent info` and stream tool steps through `agent dev`.
Confirm that MCP tools use normalized names such as `mcp_docs_search`.

Integrity checks run during invocation resolution. Static Agent inspection metadata does not connect to MCP Servers or claim that a configured baseline currently matches.

Run one invocation with a duplicate normalized tool name during development.
Confirm that the Capability fails before model execution.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `integrity` | `Record<string, McpToolFingerprints>` | none | Approved AI SDK tool fingerprints keyed by configured server name. Blocks added or changed definitions. |
| `servers` | `Record<string, McpServerConfig>` | required | MCP clients, client configs, optional absent values, or resolvers keyed by server name. |
| `unavailableNotice` | `boolean \| ((servers: string[]) => string)` | `false` | Append a notice to the final chat reply when a server is unavailable. `true` uses the default text. |

Cover MCP usage guidance in Agent Driver Instructions with explicit Capability coverage blocks. Keep MCP tool descriptions with the MCP Server because they are structured tool contracts.

## Related pages

- [Official capabilities](/docs/capabilities/official-capabilities)
- [Custom capabilities](/docs/capabilities/custom-capabilities)
- [AI SDK MCP tool-definition drift](https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools#detecting-tool-definition-drift-rug-pull)

## Inspect servers and tools

Open an Invocation's **Capabilities** tab and select **MCP**. Each configured server has a recorded discovery status, sanitized connection metadata, and its tools. A tool shows its original MCP name, the name exposed to the Agent, its description, and recorded input and output JSON Schema.

The snapshot distinguishes resolved servers, skipped optional servers, and resolution or discovery failures. Resolved servers can have no tools. These are observations from the selected Invocation, not current connection health. Opening the view does not reconnect or call tools. MCP resources mounted through Sources are outside this Capability's inventory.

Enable `configuration: 'content'` on the Invocation journal to retain the custom view and tool contracts. Missing schemas are shown as not recorded. The built-in Console journal enables configuration capture.
