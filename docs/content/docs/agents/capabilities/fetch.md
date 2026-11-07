---
title: Fetch
description: Give an Agent one named HTTP tool for each endpoint that you choose, and nothing more.
navigation.title: Fetch
navigation.order: 240
navigation.group: Capabilities
icon: i-lucide-send
---

`fetch()` gives the Agent one model tool per HTTP endpoint you define, for specific endpoints, not free browsing. Each tool calls the runtime `fetch` with the request your definition builds. No Server Primitive is wrapped.

## Configure HTTP requests

Define at least one named tool. Write the endpoint and method in full so you can see what the Agent reaches. The `tools` key is the tool name the Agent sees.

```ts [server/agents/status.ts]
import { defineAgent } from 'vite-hub/agent'
import { fetch } from 'vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model },
  capabilities: [
    fetch({
      tools: {
        serviceStatus: {
          description: 'Fetch current service status.',
          method: 'GET',
          url: 'https://status.example.com/api/status',
        },
      },
    }),
  ],
})
```

## How requests work

When the Agent calls a tool during a run, the tool:

1. Validates input with `inputSchema`, if set.
2. Builds the request from `url`, `method`, and `request`. A `request` function gets the validated input.
3. Sends it and parses JSON or text.
4. Validates the data with `schema`, if set.
5. Returns the data, or `transform(data, input)`.

- Each attempt times out after 30 seconds by default.
- Responses are limited to 5 MiB by default, counted as decoded bytes stream in, so a wrong `Content-Length` cannot bypass it.
- `GET` and `HEAD` retry once after a timeout, network error, `408`, `429`, or `5xx`. `POST` never retries.
- Non-`2xx` responses fail the call.

## Requirements

- At least one tool.
- Each tool sets a URL or returns one from `request`.
- Methods: `GET`, `HEAD`, `POST`. Response types: `json`, `text`.

## Security and approval

The Agent reaches only the endpoints your definitions build, unless your `request` function builds the URL from input.

The Agent sees the tool name, `description`, and `inputSchema`, never server-set `headers`, `body`, or `query`, so credentials can go there.

Use `inputSchema` for endpoint arguments and `schema` when model behavior depends on the response shape.

> [!NOTE]
> There is no `policy` option, so calls need no approval. For approval, use a [custom Capability](/docs/agents/capabilities/custom) with a tool `policy`.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Receives the named fetch tools. |
| Provider-backed | Receives the named fetch tools through the private MCP bridge. |
| Custom-run-backed | Receives the tools in the run context. `driver.run` decides whether to call them. |

## Verify HTTP requests

1. `vitehub agent info --agent <name> --json` has a `fetch` entry in `tools` (keyed by Capability id, not tool names).
2. A run's trace shows only the named tools.
3. With `inputSchema`, invalid input fails before the request leaves the process.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `tools` | `Record<string, FetchCapabilityToolOptions>` | required | Named fetch tools exposed to the model. |
| `tools.*.description` | `string` | `Fetch <name>.` | Tool description. |
| `tools.*.url` | `string \| URL` | none | Static request URL. |
| `tools.*.request` | `object \| function` | none | Static or input-derived request definition. |
| `tools.*.method` | `"GET" \| "HEAD" \| "POST"` | `"GET"` | Method unless the request overrides it. |
| `tools.*.request.url` | `string \| URL` | `tools.*.url` | URL. A resolver can derive it from validated input. |
| `tools.*.request.method` | `"GET" \| "HEAD" \| "POST"` | `tools.*.method`, then `"GET"` | Per-request method. |
| `tools.*.request.headers` | `Record<string, string>` | none | Request headers. |
| `tools.*.request.query` | `Record<string, unknown>` | none | Query parameters appended to the URL. |
| `tools.*.request.body` | `unknown` | none | Request body. |
| `tools.*.request.timeout` | `number` | `30000` | Milliseconds per attempt, response body included. |
| `tools.*.request.maxResponseBytes` | `number` | `5242880` | Maximum decoded size. Explicit limits up to 25 MiB. |
| `tools.*.inputSchema` | Standard Schema | none | Validates input before the request is built. |
| `tools.*.schema` | Standard Schema | none | Validates parsed response data. |
| `tools.*.responseType` | `"json" \| "text"` | `"json"` | Response parser. |
| `tools.*.transform` | `(data, input) => output` | none | Maps validated data for the model. |

## Related pages

- [webSearch()](/docs/agents/capabilities/web-search)
- [openapi()](/docs/agents/capabilities/openapi)
- [Custom capabilities](/docs/agents/capabilities/custom)
- [Official capabilities](/docs/agents/capabilities/official)
