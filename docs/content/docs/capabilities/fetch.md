---
title: Fetch
description: Expose named HTTP request tools for developer-approved endpoints.
navigation.title: Fetch
navigation.order: 140
navigation.group: External context
icon: i-lucide-send
---

`fetch()` adds model-facing HTTP tools that the developer names and defines.
Use it for specific endpoints, not for unrestricted web browsing.

The Capability creates one tool per entry in `tools`.
Each tool can validate input, build a request, parse JSON or text, validate the response, and transform the output.

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

## How requests work

ViteHub validates the configured tool map and creates internal Agent tools.
At invocation time, each tool resolves the request, executes the HTTP call, parses the configured response type, and returns either the parsed data or a transformed output.

## Requirements

`fetch({ tools })` requires at least one tool definition.
Each tool must provide a URL directly or return one from its request resolver.

Use schemas for input and response validation when the endpoint accepts arguments or returns data that model behavior depends on.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Receives the named fetch tools. |
| Provider-backed | Receives the named fetch tools through the provider MCP bridge. |
| Custom-run-backed | Receives prepared context; `driver.run` decides whether to call HTTP endpoints directly. |

## Verify HTTP requests

Inspect the Agent tool list and confirm only the named fetch tools appear.
Run one invocation with invalid input when a schema is configured and verify the request does not leave the process.

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
| `tools.*.request.timeout` | `number` | none | Request timeout in milliseconds. |
| `tools.*.inputSchema` | Standard Schema | none | Validates model tool input before request construction. |
| `tools.*.schema` | Standard Schema | none | Validates parsed response data. |
| `tools.*.responseType` | `"json" \| "text"` | `"json"` | Response parser. |
| `tools.*.transform` | `(data, input) => output` | none | Maps validated response data before returning it to the model. |

## Related pages

- [webSearch()](/docs/capabilities/web-search)
- [Custom capabilities](/docs/capabilities/custom-capabilities)
