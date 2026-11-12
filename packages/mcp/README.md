# @vite-hub/mcp

The MCP server of a ViteHub app. Each file in `server/mcp/tools/` is one tool, and the server answers at `/mcp`. Apps install this package and import `vite-hub/mcp`. This README is the contract for ViteHub packages.

```ts [server/mcp/tools/add.ts]
import { defineMcpTool } from 'vite-hub/mcp'
import { z } from 'zod'

export default defineMcpTool({
  description: 'Add two numbers.',
  input: z.object({ a: z.number(), b: z.number() }),
  handler: ({ a, b }) => ({ sum: a + b }),
})
```

Turn it on with `vitehub({ mcp: true })`. User docs: [App MCP server](https://vitehub.dev/docs/development/app-mcp).

## Contract

- The tool name is the file path below `mcp/tools/` without the extension. A name that MCP does not allow fails the build with `MCP_B0002`.
- `input` is a Standard Schema with a Standard JSON Schema (`~standard.jsonSchema`). `tools/list` shows its input JSON Schema, and the server validates the arguments with it before the handler runs. Invalid arguments are a tool error for protocol `2025-11-25`, or JSON-RPC `-32602` for `2025-06-18`.
- The handler gets `(input, { event, caller })`. A string is one text block. An object with a `content` array of blocks is the MCP result. Any other value is JSON text, and an object is also `structuredContent`.
- A thrown error with a 4xx `status` is a tool error with its message. Other errors are logged and the Agent reads `<name> failed on the server.`
- With `auth: true`, the generated entry calls `verifyMcpRequest()` from `vite-hub/auth/mcp` for every request, answers `401` with `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource<route>"`, and serves `serveMcpOAuthDiscovery()` as middleware for `/.well-known/**`. `vite-hub` turns `auth` on when the app has Auth.
- With a non-root Nitro `baseURL` (including Nuxt `app.baseURL`), the MCP URL includes that base. Configure the `mcpOAuth()` resource with that full URL. OAuth discovery stays at the origin root through global middleware.
- The protocol is the stateless JSON subset of Streamable HTTP, revisions `2025-11-25` and `2025-06-18`, from `@vite-hub/internal/runtime/mcp-server`.
- `vitehub inspect definitions --kind mcp-tool` lists the tools.

## Public imports

| Import | Use |
| --- | --- |
| `@vite-hub/mcp` | `defineMcpTool()` and its types. Apps import it as `vite-hub/mcp`. |
| `@vite-hub/mcp/vite` | `hubMcp()`, the Vite plugin that `vitehub({ mcp })` adds, and `discoverMcpTools()`. |
| `@vite-hub/mcp/runtime` | `createMcpHandler()` and `createMcpOAuthDiscoveryHandler()`, which the generated server entry imports. |
