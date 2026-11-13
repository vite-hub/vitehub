---
title: MCP
seo.title: "MCP capability: tools from MCP servers"
description: Give an Agent the tools of external MCP servers, log in through a Connection, and lock the tool definitions you reviewed.
navigation.title: MCP
navigation.order: 220
navigation.group: Capabilities
icon: i-lucide-plug
---

`mcp()` gives your Agent the tools of external MCP (Model Context Protocol) servers.

- It prefixes tool names with the server name, so they do not clash, and attaches MCP metadata with secrets removed.
- It closes clients it creates from configs or resolvers after each Invocation (one Agent run). Static direct clients belong to your app and are not closed, so you can reuse them.
- Optional approved fingerprints block new or changed tool definitions before they reach the Agent Driver.

Tool names, descriptions, and schemas come from the server. Put guidance on when to use it in the Driver Instructions.

If a server's contract is incomplete or unstable, `toolOverrides` fixes the part your app needs. Key each override by server name and original tool name. It changes the description or schema the Agent sees, not the arguments sent to the server. Use overrides only for a contract you own and review:

```ts [server/agents/support.ts] fragment
mcp({
  servers: { support: supportMcpServer },
  toolOverrides: {
    support: {
      threads_get: {
        inputSchema: {
          additionalProperties: false,
          properties: { id: { type: 'string' } },
          required: ['id'],
          type: 'object',
        },
      },
    },
  },
})
```

- They do not make an unavailable server available or change server-side validation.
- Input overrides use object JSON Schema, without transforms or coercion.
- An unknown server name makes resolution fail.
- An unknown tool name fails only for servers whose discovery succeeded.

## Configure MCP servers

Pass a map of servers. Each entry is:

- a static direct client that your app owns
- a client config or resolver, whose client the Invocation owns
- `false`, `null`, or `undefined` when the server is not configured for this deployment or run

```ts [server/agents/support.ts] fragment
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

No `if` around the Capability list is needed. Declare optional credentials in Server Env, such as `analyticsToken: env({ optional: true, secret: true })`, and return the server only when they exist:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
import { env } from 'vite-hub/env'

export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    host: 'node',
    env: {
      server: {
        analyticsToken: env({ optional: true, secret: true }),
      },
    },
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'

export default defineConfig({
  plugins: [vitehub({
    host: 'node',
    env: {
      server: {
        analyticsToken: env({ optional: true, secret: true }),
      },
    },
  }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'

export default defineConfig({
  plugins: [vitehub({
    host: 'node',
    env: {
      server: {
        analyticsToken: env({ optional: true, secret: true }),
      },
    },
  })],
})
```
:::
::

```ts [server/agents/support.ts]
import { useServerEnv } from 'vite-hub/env'
import { defineAgent } from 'vite-hub/agent'
import { mcp } from 'vite-hub/agent/capabilities'
import { remoteMcpServer } from 'vite-hub/agent/mcp'

export default defineAgent({
  driver: { model: 'openai/gpt-5.1-mini' },
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

## Limit a server to some Channels

Each MCP server adds its tools, with their full input schemas, to every model request of the Invocation. Set `channels` on a server entry to connect it only for Invocations that those Channels start. Use the Channel keys of the Agent's `channels`.

```ts [server/agents/support.ts] fragment
export default defineAgent({
  channels: { github: github(), teams: teams() },
  capabilities: [
    mcp({
      servers: {
        airtable: { connection: 'airtable' },
        productlane: { connection: 'productlane', channels: ['teams'] },
      },
      unavailableNotice: true,
    }),
  ],
})
```

A pull request Invocation from `github` gets only the `airtable` tools. ViteHub does not connect to `productlane` for it and records no unavailable warning or notice. An Invocation that no Channel starts, such as a direct `runAgent()` call, also leaves the server out. A server without `channels` applies to every Invocation. A resolver can also return `channels` with its config.

## Extend the parent's servers

In an Agent that [`extends`](/docs/agents/agent-presets#extend-an-agent) another, `mcp()` adds to the parent's `mcp()`. `servers`, `integrity`, and `toolOverrides` merge by server name. A child entry replaces the parent's whole entry for that server, with per-server options such as `optional`. Unset options, such as `unavailableNotice`, are inherited.

```ts [server/agents/bot-dev/agent.ts] fragment
export default defineAgent({
  extends: bot,
  capabilities: [mcp({ servers: { portal: { connection: 'portal' }, drop: false } })],
})
```

`drop: false` removes the inherited `drop` server. `inherit: false` replaces the parent's `mcp()`:

```ts
import { mcp } from 'vite-hub/agent/capabilities'

capabilities: [mcp({ servers: {}, inherit: false })]
```

## Authenticate through a Connection

Set `connection` on a client config to log in with a [Connection](/docs/connections), a stored login to an external account. It sends the `Authorization` header, refreshes the token, checks access per request, and records activity. The Agent and client never see the token.

```ts [server/agents/support.ts] fragment
mcp({
  servers: {
    docs: {
      connection: 'docs',
      transport: { type: 'http', url: 'https://docs.example.com/mcp' },
    },
  },
})
```

- `connection` needs an `http` or `sse` transport without `authProvider`, and replaces `transport.fetch`.
- A resolver can return a config with `connection`, such as to pick the URL per run.
- Without `vitehub({ connections: true })`, resolution fails with an error naming the Connection.

If the provider declares an [`mcp` endpoint](/docs/connections/configure#mcp-endpoint), omit `transport` and ViteHub connects to it over HTTP. `transport` can still set `type` or `headers`. With no `transport.url` and no `mcp` endpoint, resolution fails with an error naming the Connection.

```ts [server/agents/support.ts] fragment
mcp({
  servers: {
    crm: { connection: 'crm', optional: true, tools: ['search', 'get_record'] },
  },
})
```

- `optional: true` leaves the server out, with no unavailable notice, until the Connection is connected.
- `tools` exposes only the named tools, with or without a Connection.

Outside an Agent, `callMcpTool()` from `vite-hub/agent/mcp` calls one tool through the Connection as the `server` actor. Allow it with `access: { server: { read: true, write: ['fetch'] } }`. It returns a `Result` from `vite-hub/runtime`, `[error, undefined]` or `[undefined, value]`, and does not reject for a failed call. `value` is the tool's `structuredContent`, or its text content parsed as JSON when possible.

```ts [server/api/crm/search.get.ts]
import { createError, defineEventHandler, getQuery } from 'h3'
import { callMcpTool } from 'vite-hub/agent/mcp'

export default defineEventHandler(async (event) => {
  const { query } = getQuery(event)
  const [error, result] = await callMcpTool({ connection: 'crm' }, 'search', { query }, { retries: 2 })
  if (error) throw createError({ statusCode: 502, message: error.message })
  return result
})
```

`error` is set when the server cannot be reached, the tool reports an error, the call times out, or `signal` aborts. Approval-gated writes fail like the Agent client. A tool that is not in `tools` returns an `MCP_TOOL_NOT_FOUND` error. See [callMcpTool() errors](#callmcptool-errors) for each code. `retries` repeats a failed call after 100 ms, then 200 ms, and so on, and stops when `signal` aborts. It returns the last error.

Each request maps to a Connection Operation:

| Request | Operation id | Effect | Activity |
| --- | --- | --- | --- |
| HTTP `GET` or `HEAD` request | `fetch` | read | Every request. |
| HTTP write request, including a tool call or protocol message | `fetch` | write | Every request. |

The transport uses the Connection's native `fetch` client. Writes are denied without a matching `fetch` rule, so allow the transport in the Agent rule:

```ts [server/connections/docs.ts] fragment
access: {
  'agent:support': { read: true, write: ['fetch'], approve: false },
},
```

If the Agent uses the provider's [`mcp` endpoint](/docs/connections/configure#mcp-endpoint), the `'mcp'` preset is shorter and narrower. `access: { 'agent:support': 'mcp' }` allows every method on that endpoint without approval and denies all other requests, typed API methods included.

Access is checked before the tool runs. Denied requests fail with `CONNECTIONS_DENIED`.

> [!WARNING]
> MCP needs protocol responses in the active session, so a call cannot pause for approval. Writes that need approval fail with `CONNECTIONS_DENIED` before an approval is created. Set `approve: false` on the Agent rule, or use the `'mcp'` preset.

## Install a server's Skills

A server can share [Agent Skills](/docs/agents/capabilities/skills) (instruction packs) as `skill://<name>/<path>` resources, per the MCP Skills extension. During discovery, `mcp()` installs each Skill with a `SKILL.md`, text files only, into the run's Workspace at `.agents/skills/<name>/`, where Provider Agents such as Codex find them.

The files exist only for that run and are never saved to the Workspace store. Each run reads the server again, so changes apply at once.

- The Agent's own Skill with the same name, such as `server/agents/<agent>/skills/<name>/`, wins. Between servers, the first configured wins.
- Names must match `^[a-z0-9][a-z0-9-]{0,63}$`. Paths with `.`, `..`, empty, or control-character segments are skipped.
- Each server can add at most 64 files and 1 MiB. A Skill that does not fit is left out whole.
- Runs without a Workspace read no Skills.

If Skills fail, the server keeps its tools. Servers without the resources capability have no Skills. Set `skills: false` to turn this off:

```ts [server/agents/support.ts] fragment
mcp({
  servers: {
    drop: { skills: false, transport: { type: 'http', url: 'https://drop.example.com/mcp' } },
  },
})
```

## Executor through `mcp()`

[Executor](https://executor.sh/) keeps the credentials and policies of many services behind one MCP endpoint. Copy the endpoint from its **Connect** card.

With an OAuth 2 Connection named `executor`:

```ts [server/agents/support.ts] fragment
mcp({
  servers: {
    executor: {
      connection: 'executor',
      transport: { type: 'http', url: 'https://executor.sh/acme/mcp' },
    },
  },
})
```

Allow the transport with `access: { 'agent:support': { read: true, write: ['fetch'], approve: false } }`. The `executor` Connection can use your app's OAuth client or an [API key Connection](/docs/connections/configure#api-key-connections) with a personal Executor API key.

Without Connections, send a personal Executor API key from Server Env in a resolver. Executor rejects organization keys for MCP sessions.

```ts [server/agents/support.ts] fragment
mcp({
  servers: {
    executor: () => {
      const apiKey = useServerEnv().executorApiKey
      return apiKey
        ? remoteMcpServer({
            headers: { Authorization: `Bearer ${apiKey.unseal()}` },
            url: 'https://executor.sh/acme/mcp',
          })
        : undefined
    },
  },
})
```

The resolver runs per run, so a new key applies next run. Tools get names such as `mcp_executor_execute`. Lock them with `integrity: { executor: approvedExecutorTools }`.

## How MCP connections work

Before each run, `mcp()` connects to each server and lists its tools.

- Normalized tool names get a `mcp_<server>_` prefix. Duplicate normalized names are rejected.
- Use a resolver or config when the run owns the connection, and a static client when your app owns it.
- An absent entry adds no tools and creates no client.
- A server that fails, including one that rejects its credential, is marked unavailable and the run continues without it.
- Configuration, cancellation, protocol, integrity, cleanup, and other resolver failures stop the run.

Client configs set `protocolVersionDiscovery` to `false` by default, so older servers that expect `initialize` first work. Set `true` when the server supports discovery.

## Pin tool definitions

A server can later change a reviewed tool's description, title, or input schema. Pinning blocks changed definitions until you review them:

1. Run `fingerprintTools()` in a trusted review step and review the output.
2. Save it in app code or configuration.
3. Pass it to `integrity` under the server name.

```ts [scripts/review-docs-mcp.ts] fragment
import { fingerprintTools } from 'ai'

const approved = await fingerprintTools(await client.tools())
console.log(JSON.stringify(approved, null, 2))
```

Never build the baseline at startup; that trusts whatever the server returns first.

```ts [server/agents/support.ts] fragment
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

Each server is fingerprinted separately, before renaming. Fingerprints cover tool names, string descriptions, titles, and resolved input schemas.

- Added or changed definitions fail the Capability.
- Removed tools are allowed, since servers can hide tools by feature or authorization.
- Drift errors name the server and the original names of added, changed, and removed tools.

> [!WARNING]
> Fingerprints do not prove the first reviewed definition was safe, or detect a behavior change behind an unchanged definition.

## Requirements

- A server map. Each present entry resolves to a client or client config; `false`, `null`, and `undefined` skip it.
- The optional `@ai-sdk/mcp` package, for clients created from configs.
- `ai` 7.0.19 or newer, with `integrity`.
- The [Connections](/docs/connections) primitive and a connected Connection, with `connection`.

The server owns its credentials, availability, and tool behavior.

A server that fails during resolution or discovery is left out, and the run continues with the other servers:

- A failure is any HTTP error from the server, including 401 and 403 for an expired or revoked credential, a Connection that cannot authorize (`CONNECTIONS_NEEDS_RECONNECT`, `CONNECTIONS_NOT_CONNECTED`, `CONNECTIONS_PROVIDER_FAILED`, `CONNECTIONS_UNAVAILABLE`), recognized network errors, and bounded timeouts.
- Each adds an entry at `vitehub.mcp.warnings` in the input context, with server, phase, and the HTTP status or Connection error code when available. Inspection marks the server `Unavailable`.

Configuration errors, including a Connection whose access denies the Agent, cancellation, protocol errors, duplicate tools, and integrity drift stop the run.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Receives normalized MCP tools. |
| Provider-backed | Receives normalized MCP tools through the provider MCP bridge. Connection and cleanup still run around the run. |
| Custom-run-backed | Receives prepared context. `driver.run` decides whether to call MCP clients or tools. |

## Verify MCP connections

1. `agent info` lists the MCP tools, and `agent dev` streams tool steps.
2. Tools have normalized names such as `mcp_docs_search`.
3. A duplicate normalized name fails before the model runs.

Integrity checks run before each run. Static inspection does not connect to servers, so it cannot say whether a baseline still matches.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `integrity` | `Record<string, McpToolFingerprints>` | none | Approved AI SDK tool fingerprints by server name. Blocks added or changed definitions. |
| `servers` | `Record<string, McpServerConfig>` | required | MCP clients, client configs, optional absent values, or resolvers keyed by server name. |
| `servers.<name>.connection` | `string` | none | Connection in `server/connections/` for an `http` or `sse` config. Without `transport.url`, uses the provider's `mcp` endpoint. |
| `servers.<name>.optional` | `boolean` | `false` | With `connection`, leave the server out until the Connection is connected. |
| `servers.<name>.channels` | `string[]` | every Invocation | Connect the server only for Invocations that these Channels start. Other Invocations leave it out, without an unavailable notice. |
| `servers.<name>.tools` | `string[]` | every tool | Expose only these server tool names. |
| `inherit` | `boolean` | `true` | With `extends`, `false` replaces the parent's `mcp()`. |
| `servers.<name>.skills` | `boolean` | `true` | Install the server's `skill://` Skills at `.agents/skills/<name>/`. |

Write guidance on when to use MCP in Driver Instructions with Capability coverage blocks. Keep tool descriptions on the server; they are part of the tool contract.

## callMcpTool() errors

`callMcpTool()` returns these errors. Each one has `code`, `why`, `fix`, and `docs`. `error.cause` keeps the lower-level error, and `JSON.stringify(error)` does not include it.

### MCP_SERVER_FAILED

The client could not connect, the server failed, or the server entry is not valid. Read `error.cause` for the connection or server error. Retry when the server is available, or pass `retries`.

### MCP_TOOL_CALL_FAILED

The tool answered with `isError: true`. `error.why` has the start of the tool's text content. Change the arguments or retry.

### MCP_TOOL_CANCELLED

The `signal` option aborted the call. `error.cause` is the abort reason.

### MCP_TOOL_NOT_FOUND

The server has no tool with this name, or the server entry lists `tools` without it.

### MCP_TOOL_TIMEOUT

The tool did not answer within the `timeout` option, in milliseconds. Raise `timeout`, or pass `retries`.

## Related pages

- [Official capabilities](/docs/agents/capabilities/official)
- [Custom capabilities](/docs/agents/capabilities/custom)
- [Connections](/docs/connections)
- [AI SDK MCP tool-definition drift](https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools#detecting-tool-definition-drift-rug-pull)

## Inspect servers and tools

In a run's **Capabilities** tab, select **MCP**. Each server shows:

- its discovery status and connection metadata, secrets removed
- **Skills**: names served, or `None`, `Off` (`skills: false`), `No Workspace`, or `Discovery failed:` with the error
- each tool's original name, Agent name, description, and recorded input and output JSON Schema

It shows which servers connected, were skipped as optional, or failed. A connected server can have no tools. It reflects the selected run, not current health. Opening it does not reconnect or call tools. MCP resources mounted through Sources are not listed.

To keep the view and tool contracts, turn on `configuration: 'content'` on the journal. Missing schemas show as not recorded. The default Agent journal captures configuration.
