---
title: fetch()
description: Expose named HTTP request tools for developer-approved endpoints.
navigation.title: fetch()
navigation.order: 140
icon: i-lucide-send
---

`fetch()` adds model-facing HTTP tools that the developer names and defines.
Use it for specific endpoints, not for unrestricted web browsing.

## What it adds

The Capability creates one tool per entry in `tools`.
Each tool can validate input, build a request, parse JSON or text, validate the response, and transform the output.

## Minimum attach example

Define at least one named fetch tool.
Keep the endpoint and method explicit.

```ts [server/agents/status.ts]
import { defineAgent } from '@vite-hub/agent'
import { fetch } from '@vite-hub/agent/capabilities'

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

## Runtime behavior

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
| Harness-backed | Runtime requirements apply; model-facing fetch tools are not passed by default. |
| Custom-run-backed | Receives prepared context; `driver.run` decides whether to call HTTP endpoints directly. |

## Inspect and verify

Inspect the Agent tool list and confirm only the named fetch tools appear.
Run one invocation with invalid input when a schema is configured and verify the request does not leave the process.

## Reference

- [webSearch()](/docs/capabilities/web-search)
- [Custom capabilities](/docs/capabilities/custom-capabilities)
- Source: `packages/agent/src/capabilities/fetch.ts`
