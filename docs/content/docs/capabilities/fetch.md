---
title: Fetch
description: Expose named HTTP request tools for developer-approved endpoints.
navigation.title: Fetch
navigation.order: 140
navigation.group: External context
icon: i-lucide-send
---

`fetch()` gives the Agent one model-facing tool for each HTTP endpoint that you name and define.
Use it for specific endpoints, not for unrestricted web browsing.
It does not wrap a Server Primitive. Each tool calls the runtime `fetch` with the request that your tool definition builds.

## Configure HTTP requests

Define at least one named fetch tool.
Keep the endpoint and method explicit.

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

The key in `tools` is the tool name that the Agent sees.

## How requests work

ViteHub creates one Agent tool for each entry in `tools`.
At invocation time, each tool:

1. Validates the tool input with `inputSchema`, when set.
2. Resolves the request from `url`, `method`, and `request`. A `request` function receives the validated input.
3. Sends the request and parses the response as JSON or text.
4. Validates the parsed data with `schema`, when set.
5. Returns the data, or the result of `transform(data, input)`.

Each request attempt times out after 30 seconds by default. Responses are limited to 5 MiB by default. The limit applies to decoded streamed bytes, so a missing or incorrect `Content-Length` cannot bypass it.
`GET` and `HEAD` requests retry once after a timeout, a network error, or a `408`, `429`, or `5xx` response. `POST` requests do not retry.
A response that is not `2xx` fails the tool call.

## Requirements

`fetch({ tools })` requires at least one tool definition.
Each tool must provide a URL directly or return one from its `request` resolver.
Supported methods are `GET`, `HEAD`, and `POST`. Supported response types are `json` and `text`.

## Security and approval

The Agent can call only the endpoints that your tool definitions build. It cannot choose a different host unless your `request` function derives the URL from tool input.
The Agent sees the tool name, `description`, and `inputSchema`. It does not see `headers`, `body`, or `query` values that you set in server code, so you can add credentials there.
Use `inputSchema` when the endpoint accepts arguments, and `schema` when model behavior depends on the response shape.

`fetch()` has no `policy` option. Calls run without an approval step. Use a [custom Capability](/docs/capabilities/custom-capabilities) with a tool `policy` when a request needs approval.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Receives the named fetch tools. |
| Provider-backed | Receives the named fetch tools through the private MCP bridge. |
| Custom-run-backed | Receives the tools in the prepared run context; `driver.run` decides whether to call them. |

## Verify HTTP requests

Run `vitehub agent info --agent <name> --json` and confirm that `tools` contains a `fetch` entry. Entries use the Capability id, not the individual tool names.
Run one invocation and confirm that the trace shows only the named fetch tools.
Run one invocation with invalid input when `inputSchema` is configured. Confirm that the tool fails before the request leaves the process.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `tools` | `Record<string, FetchCapabilityToolOptions>` | required | Named fetch tools exposed to the model. |
| `tools.*.description` | `string` | `Fetch <name>.` | Tool description. |
| `tools.*.url` | `string \| URL` | none | Static request URL. |
| `tools.*.request` | `object \| function` | none | Static or input-derived request definition. |
| `tools.*.method` | `"GET" \| "HEAD" \| "POST"` | `"GET"` | HTTP method used when the request definition does not override it. |
| `tools.*.request.url` | `string \| URL` | `tools.*.url` | Request URL. A request resolver can derive it from validated tool input. |
| `tools.*.request.method` | `"GET" \| "HEAD" \| "POST"` | `tools.*.method`, then `"GET"` | Per-request HTTP method override. |
| `tools.*.request.headers` | `Record<string, string>` | none | Request headers. |
| `tools.*.request.query` | `Record<string, unknown>` | none | Query parameters appended to the URL. |
| `tools.*.request.body` | `unknown` | none | Request body. |
| `tools.*.request.timeout` | `number` | `30000` | Timeout for each attempt, including the response body, in milliseconds. |
| `tools.*.request.maxResponseBytes` | `number` | `5242880` | Maximum decoded response size. Explicit limits must not exceed 25 MiB. |
| `tools.*.inputSchema` | Standard Schema | none | Validates model tool input before request construction. |
| `tools.*.schema` | Standard Schema | none | Validates parsed response data. |
| `tools.*.responseType` | `"json" \| "text"` | `"json"` | Response parser. |
| `tools.*.transform` | `(data, input) => output` | none | Maps validated response data before returning it to the model. |

## Related pages

- [webSearch()](/docs/capabilities/web-search)
- [openapi()](/docs/capabilities/openapi)
- [Custom capabilities](/docs/capabilities/custom-capabilities)
- [Official capabilities](/docs/capabilities/official-capabilities)
