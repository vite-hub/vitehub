---
title: OpenAPI
description: Expose selected OpenAPI operations as bounded Agent tools or a generated Capability CLI.
navigation.title: OpenAPI
navigation.order: 145
navigation.group: External context
icon: i-lucide-route
---

`openapi()` turns selected OpenAPI `operationId`s into bounded HTTP operations.
Use it when an Agent should call a known API contract instead of a hand-written `fetch()` tool for each endpoint.

Attaching the Capability is the opt-in.
Channel, customer, or tenant admission belongs in `access()`, Agent Trigger routing, or separate Agent Definitions, not in `openapi()`.

## Installation

Import the Capability factory from `@vite-hub/agent/capabilities`. Add it to `defineAgent({ capabilities })` when every invocation needs it, or to one [Channel's capabilities](/docs/agents/channels#scope-abilities-to-one-channel) when only that Channel should receive it.

```ts [server/agents/support.ts]
import { defineAgent } from '@vite-hub/agent'
import { access, openapi } from '@vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model },
  capabilities: [
    access({
      chat: {
        resolve({ invoker }) {
          return invoker.kind === 'portal'
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

## What it adds

By default, `openapi()` creates one model-facing tool per selected operation.
Each tool uses the OpenAPI request path, query parameters, request body schema, operation summary, and response parser.

When `cli` is set, ViteHub replaces those operation tools with one Capability CLI tool.
The generated CLI has one subcommand per selected operation and can also run through `vitehub agent dev --cli`.

## Select operations

Always pass the operation allowlist directly.
ViteHub does not expose every operation by default.

```ts [server/agents/support.ts]
openapi({
  spec: 'https://billing.example.com/openapi.json',
  operations: ['billingListCustomers', 'billingGetInvoice'],
})
```

Unsupported HTTP methods are ignored unless the operation is selected.
In v1, selected operations can use `GET`, `HEAD`, or `POST`.

## Configure requests

ViteHub derives the request server from the OpenAPI document by default:

1. `servers[0].url`
2. the OpenAPI spec URL origin

Use `hooks.request` for runtime auth, cookies, tenant values, body additions, query additions, and timeout changes.
The hook receives the selected operation, Agent Capability context, visible model input, and a mutable draft request.
When the hook owns OpenAPI fields such as tenant path params or runtime body tokens, declare them in `provides`; ViteHub removes those fields from the model and generated CLI schemas, strips them from caller input, then validates the final prepared request after the hook runs.

```ts [server/agents/support.ts]
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

ViteHub still keeps caller-owned required fields in the model and generated CLI schemas. If the hook only provides `tenantId`, another required path param such as `orderId` remains required from the caller.

For a broken, missing, or environment-neutral `servers` entry, use `server` as an override escape hatch.
`server` can also be a callback when the override comes from the current Agent Invocation context.

```ts [server/agents/support.ts]
openapi({
  spec: './openapi.json',
  server: 'https://preview.example.com/api',
  operations: ['listCustomers'],
})
```

## Generate a Capability CLI

Use `cli` when agents and developers should call the same operation catalog through a command-shaped surface.

```ts [server/agents/support.ts]
openapi({
  spec: 'https://billing.example.com/openapi.json',
  operations: ['billingListCustomers', 'billingGetInvoice'],
  cli: {
    name: 'billing',
    description: 'Inspect live billing API data.',
  },
})
```

`cli` can also resolve from the current Agent Invocation. Return `false` or `undefined` to omit the generated CLI for that invocation without detaching the OpenAPI Capability or changing its lifecycle.

```ts [server/agents/support.ts]
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

Treat Channel metadata as an availability hint, not authorization. Check trusted request, Agent Actor, or `access()` evidence before privileged API calls.

Run the generated CLI through the Agent Dev Loop.
Agents expose generated Capability CLI Contributions by default; use `defineAgent({ cli: { capabilities: false } })` to attach the OpenAPI Capability without exposing its CLI surface.

```bash [Terminal]
pnpm vitehub agent dev --url http://localhost:3000 --agent support --cli billing -- list-customers --json
```

## Shape responses

Use `transformResponse` when the raw API response contains transport fields or verbose provider-specific rows.

```ts [server/agents/support.ts]
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
| Model-backed | Receives selected OpenAPI tools, or one generated Capability CLI tool when `cli` is set. |
| Provider-backed | Receives selected OpenAPI tools, or the generated Capability CLI tool, through the provider MCP bridge. |
| Custom-run-backed | Receives prepared context; `driver.run` decides whether to call API operations directly. |

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `spec` | `string \| URL \| object \| function` | required | OpenAPI document URL, inline document, or invocation-scoped document resolver. |
| `operations` | `readonly string[]` | required | Selected OpenAPI `operationId`s exposed by this Capability. |
| `description` | `string` | none | Prefix for generated operation-tool descriptions and fallback description for the generated Capability CLI. |
| `hooks.request` | `(context) => patch \| void` or `{ provides?, handler }` | none | Fetch-style request preparation hook for runtime headers, cookies, path, query, body, and timeout values. |
| `hooks.request.provides` | `{ body?, path?, query? }` | none | Runtime-owned OpenAPI input fields to remove from model and generated CLI schemas before caller validation. |
| `server` | `string \| URL \| function` | OpenAPI server | Override escape hatch for specs without a usable `servers[0].url` or spec URL origin. |
| `cli` | `false \| { name, description? }` | `false` | Generates a Capability CLI instead of one model-facing tool per operation. |
| `responseType` | `"json" \| "text"` | `"json"` | Response parser for operation results. |
| `transformResponse` | `(response, context) => output` | none | Maps parsed operation responses before returning them to the Agent. |
| `specHeaders` | `Record<string, string>` | none | Headers used only when fetching the OpenAPI document. |
| `timeout` | `number` | none | Default request timeout in milliseconds. |

## Reference

- [Fetch](/docs/capabilities/fetch)
- [Access](/docs/capabilities/access)
- [Custom capabilities](/docs/capabilities/custom-capabilities)
- [CLI](/docs/development/cli)
- Source: `packages/agent/src/capabilities/openapi.ts`
