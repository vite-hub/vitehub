---
title: MCP server API
description: Every option of defineMcpTool(), what a tool handler gets and returns, and how a tool reports an error to the Agent.
navigation.title: Server API
navigation.order: 4
icon: i-lucide-code-2
---

Import `defineMcpTool()` from `vite-hub/mcp`. It re-exports `@vite-hub/mcp`.

## Define a tool

Put one `defineMcpTool()` default export in each file of `server/mcp/tools/`. The tool name is the file path below `mcp/tools/` without the extension.

```ts [server/mcp/tools/add.ts]
import { defineMcpTool } from 'vite-hub/mcp'
import { z } from 'zod'

export default defineMcpTool({
  description: 'Add two numbers.',
  input: z.object({ a: z.number(), b: z.number() }),
  handler: ({ a, b }) => ({ sum: a + b }),
})
```

| Option | Use |
| --- | --- |
| `description` | What the tool does and when an Agent calls it. Agents read it to pick the tool. Required. |
| `title` | A short name for people, such as "List drops". |
| `input` | The arguments: a Standard Schema that also gives its JSON Schema, such as a Zod 4 object or a Valibot schema in `toStandardJsonSchema()`. `tools/list` shows its JSON Schema. |
| `annotations` | The MCP tool annotations that clients read before a call: `readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint`. |
| `public` | Set `true` to include the tool on `mcp.publicRoute`. See [Public tools](/docs/mcp/configure#serve-public-tools-without-sign-in). |
| `handler` | Runs the call. |

The server checks the arguments with `input` before the handler runs. Invalid arguments are a tool error for protocol `2025-11-25`, or JSON-RPC `-32602` for `2025-06-18`.

## Write the handler

The handler gets the checked input and `{ event, caller }`:

- `event` is the H3 event of the MCP request. `event.req` is the web `Request`.
- `caller` is the signed-in caller when `mcpOAuth()` protects the server, else `undefined`. It has the Auth `user`, the approved `scopes`, the OAuth `clientId`, and the `clientName`, such as `Claude Code`. The server reads the user again for each request, so a deleted or banned person has no access.

The return value becomes the tool result:

| Return | Result |
| --- | --- |
| A string | One text block. |
| `{ content: [...] }` | The MCP content blocks as they are, such as an image. |
| Another value | JSON text. An object is also the `structuredContent`. |

## Report an error

Throw an error with a 4xx `status`, such as H3's `HTTPError`, to tell the Agent what to fix. The Agent reads its message as a tool error. Other errors are logged, and the Agent reads only `<name> failed on the server.`

## Public imports

| Import | Use |
| --- | --- |
| `vite-hub/mcp` | `defineMcpTool()` and its types. |
| `@vite-hub/mcp/vite` | `hubMcp()`, the Vite plugin that `vitehub({ mcp })` adds, and `discoverMcpTools()`. |
| `@vite-hub/mcp/runtime` | `createMcpHandler()` and `createMcpOAuthDiscoveryHandler()`, which the generated server entry imports. |
