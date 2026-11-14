---
title: OpenAPI
description: Turn the API endpoints you choose from an OpenAPI file into Agent tools or a command-line tool.
navigation.title: OpenAPI
navigation.order: 245
navigation.group: Capabilities
icon: i-lucide-route
---

`openapi()` turns selected OpenAPI operations, picked by `operationId`, into bounded HTTP tools, so you do not write one `fetch()` tool per endpoint.

Do not use it to decide which Channels, customers, or tenants get in. Use `access()`, Agent Trigger routing, or separate Agent Definitions.

## Configure an OpenAPI Capability

Add `openapi()` to the Agent when every Invocation (Agent run) needs the API, or to one [Channel's capabilities](/docs/agents/channels#scope-abilities-to-one-channel) when only it does.

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
import { access, openapi } from 'vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model: 'openai/gpt-5.1-mini' },
  capabilities: [
    access({
      chat: {
        resolve({ invoker }) {
          return invoker?.kind === 'portal'
        },
      },
    }),
    openapi({
      spec: 'https://portal.example.com/_openapi.json',
      operations: ['portalProductSearch', 'portalPurchaseOrders'],
    }),
  ],
})
```

By default, each selected operation becomes one model tool, built from its path, query parameters, body schema, summary, and response parser.

With `cli`, one Capability CLI tool replaces them, with one subcommand per operation. `vitehub agent dev --cli` also runs it.

## Select operations

Always pass the allowed operations; none are exposed by default.

```ts [server/agents/support.ts] fragment
openapi({
  spec: 'https://billing.example.com/openapi.json',
  operations: ['billingListCustomers', 'billingGetInvoice'],
})
```

Only selected operations are read, so others may use unsupported methods, repeat an `operationId`, or have invalid tool names. In v1, selected operations can use `GET`, `HEAD`, or `POST`.

### Name operations

The `operationId` is the tool name, and its kebab-case form the CLI command. Generated ids such as `read_flow_run_flow_runs__id__get` are hard for Agents, so map names to `operationId`s:

```ts [server/agents/support.ts] fragment
openapi({
  spec: 'https://prefect.example.com/api/openapi.json',
  operations: {
    'flow-run': 'read_flow_run_flow_runs__id__get',
    'logs': 'read_logs_logs_filter_post',
  },
  cli: { name: 'prefect' },
})
```

Each name is used as written for the tool and CLI command, giving `prefect flow-run` and `prefect logs`. Names start with a letter and use letters, numbers, underscores, and hyphens. `hooks.request` and `transformResponse` still get the `operationId` as `operation.id`.

## Configure requests

The server URL is `servers[0].url`, else the spec URL origin.

`hooks.request` changes each request before it is sent: runtime auth, cookies, tenant values, body and query fields, and the timeout or response-size limit, within bounds. It gets the operation, the Capability context, the model input, and a mutable draft request.

List fields your server must supply, such as a tenant path param or runtime body token, in `provides`. ViteHub removes them from the model and CLI schemas and from caller input, and validates the final request after the hook.

```ts [server/agents/support.ts] fragment
openapi({
  spec: 'https://portal.example.com/_openapi.json',
  operations: ['portalProductSearch', 'portalPurchaseOrders'],
  hooks: {
    request: {
      provides: {
        body: ['cubeToken'],
        path: ['tenantId'],
      },
      async handler({ context, operation, request }) {
        const session = context.get<{
          cubeToken: string
          tenantId: string
          token: string
        }>('portalSession')
        if (!session) throw new Error('Portal session missing.')

        request.headers.set('authorization', `Bearer ${session.token}`)
        request.path.tenantId = session.tenantId

        if (operation.id === 'portalPurchaseOrders') {
          request.body = {
            ...(request.body as Record<string, unknown> | undefined),
            cubeToken: session.cubeToken,
          }
        }
      },
    },
  },
})
```

Required fields the hook does not provide stay in the schemas. If it provides only `tenantId`, the caller still sends `orderId`.

## Authenticate through a Connection

Set `connection` to send requests with an OAuth 2 [Connection](/docs/connections), a stored login to an external account.

```ts [server/agents/support.ts] fragment
openapi({
  spec: 'https://billing.example.com/openapi.json',
  operations: ['billingListCustomers', 'billingCreateTicket'],
  connection: 'billing',
})
```

> [!NOTE]
> With a Connection, the body must be a string, stored so the request can be resent after approval. JSON bodies are converted for you. A hook that supplies `URLSearchParams`, `FormData`, or binary data must convert it, or the request fails before sending.

Credentials are added after `hooks.request`, so hooks never see the token. Requests go through the Connection client as the `fetch` action. `GET` and `HEAD` are reads, other methods are writes, and writes are denied without a matching `fetch` rule:

```ts [server/connections/billing.ts] fragment
access: {
  'agent:support': { read: true, write: ['fetch'] },
},
```

Access is checked before a tool runs:

- A denied request fails with `CONNECTIONS_DENIED`.
- A write that needs approval creates a stored approval and fails with `CONNECTIONS_APPROVAL_REQUIRED` until an administrator approves.
- Each call is recorded as activity with the Agent actor, trace id, and `fetch` action.

## Override the request server

Set `server` when the `servers` entry is broken, missing, or not environment-specific. A callback can read the run context.

```ts [server/agents/support.ts] fragment
openapi({
  spec: './openapi.json',
  server: 'https://preview.example.com/api',
  operations: ['listCustomers'],
})
```

## Generate a Capability CLI

`cli` gives Agents and developers the operations as commands.

```ts [server/agents/support.ts] fragment
openapi({
  spec: 'https://billing.example.com/openapi.json',
  operations: ['billingListCustomers', 'billingGetInvoice'],
  cli: {
    name: 'billing',
    description: 'Inspect live billing API data.',
  },
})
```

A `cli` callback reads the current run and returns `false` or `undefined` to omit the CLI. The Capability stays attached with an unchanged lifecycle.

```ts [server/agents/support.ts] fragment
openapi({
  spec: 'https://portal.example.com/_openapi.json',
  operations: ['portalProductSearch', 'portalPurchaseOrders'],
  cli: ({ run }) => run?.channelId === 'portal'
    ? {
        name: 'portal-api',
        description: 'Inspect live Portal data.',
      }
    : false,
})
```

Treat Channel metadata as an availability hint, not authorization. Check trusted request, Agent Invoker, or `access()` evidence before privileged API calls.

Run the CLI through the Agent Dev Loop. Generated CLIs are shown by default; `defineAgent({ cli: { capabilities: false } })` hides them.

```bash [Terminal]
pnpm vitehub agent dev --url http://localhost:3000 --agent support --cli billing -- list-customers --json
```

## Shape responses

`transformResponse` gives the Agent a smaller result when the raw response has transport fields or long provider rows.

```ts [server/agents/support.ts] fragment
openapi({
  spec: 'https://billing.example.com/openapi.json',
  operations: ['billingGetInvoice'],
  transformResponse(response, { operation, response: http }) {
    return {
      operationId: operation.id,
      status: http.status,
      data: response,
    }
  },
})
```

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Gets the operation tools, or one CLI tool with `cli`. |
| Provider-backed | Gets the same through the provider MCP bridge. |
| Custom-run-backed | Gets prepared context. `driver.run` decides whether to call operations. |

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `spec` | `string \| URL \| object \| function` | required | Document URL, inline document, or per-run resolver. |
| `operations` | `readonly string[] \| Record<string, string>` | required | Selected `operationId`s, or a record of tool and CLI names to `operationId`s. |
| `description` | `string` | none | Prefix for tool descriptions and fallback CLI description. |
| `hooks.request` | `(context) => patch \| void` or `{ provides?, handler }` | none | Fetch-style hook for headers, cookies, path, query, body, timeout, and `maxResponseBytes`. |
| `hooks.request.provides` | `{ body?, path?, query? }` | none | Runtime-owned fields removed from model and CLI schemas before validation. |
| `connection` | `string` | none | Connection in `server/connections/`. Adds credentials, checks `fetch` access, records activity. |
| `server` | `string \| URL \| function` | OpenAPI server | Override for specs without a usable `servers[0].url` or spec URL origin. |
| `cli` | `false \| { name, description? }` | `false` | One Capability CLI instead of one tool per operation. |
| `responseType` | `"json" \| "text"` | `"json"` | Response parser. |
| `transformResponse` | `(response, context) => output` | none | Maps parsed responses for the Agent. |
| `specHeaders` | `Record<string, string>` | none | Headers only for fetching the document. |
| `timeout` | `number` | `30000` | Default request and body timeout in milliseconds. |
| `maxResponseBytes` | `number` | `5242880` | Maximum decoded spec and response size. Hooks may change it up to 25 MiB. |

## Related pages

- [Fetch](/docs/agents/capabilities/fetch)
- [Access](/docs/agents/capabilities/access)
- [Connections](/docs/connections)
- [Custom capabilities](/docs/agents/capabilities/custom)
- [CLI](/docs/cli)
