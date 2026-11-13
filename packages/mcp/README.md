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

Turn it on with `vitehub({ auth: true, mcp: true })` and `mcpOAuth()` from `vite-hub/auth/mcp`, or with `vitehub({ mcp: { auth: false } })` to let anyone call every tool. User docs: [MCP server](https://vitehub.dev/docs/mcp).

## Contract

- The tool name is the file path below `mcp/tools/` without the extension. A name that MCP does not allow fails the build with `MCP_B0002`.
- `input` is a Standard Schema with a Standard JSON Schema (`~standard.jsonSchema`). `tools/list` shows its input JSON Schema, and the server validates the arguments with it before the handler runs. Invalid arguments are a tool error for protocol `2025-11-25`, or JSON-RPC `-32602` for `2025-06-18`.
- The handler gets `(input, { event, caller })`. A string is one text block. An object with a `content` array of blocks is the MCP result. Any other value is JSON text, and an object is also `structuredContent`.
- A thrown error with a 4xx `status` is a tool error with its message. Other errors are logged and the Agent reads `<name> failed on the server.`
- `auth` defaults to `true`, in `hubMcp()` and in `vitehub({ mcp })`. Then the generated entry calls `verifyMcpRequest()` from `vite-hub/auth/mcp` for every request, answers `401` with `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource<route>"`, and serves `serveMcpOAuthDiscovery()` as middleware for `/.well-known/**`. `vitehub({ mcp })` without `auth` fails with `VITE_HUB_R0141`. Only an explicit `auth: false` serves every tool without sign-in.
- With `publicRoute`, such as `mcp: { route: "/mcp/account", publicRoute: "/mcp" }`, a second server answers at that route with only the tools that set `public: true`. It needs no sign-in, never answers `401`, and the protected resource metadata does not name it. MCP clients do not sign in on a URL that answers without a token, so a server that has public tools and tools for a person needs two URLs. `publicRoute` with `auth: false` fails the build with `MCP_B0003`. A tool that sets `public` on a server without `publicRoute` fails `createMcpHandler()` with `MCP_R0001`, so `public: false` never looks like protection that it is not.
- With a non-root Nitro `baseURL` (including Nuxt `app.baseURL`), the MCP URL includes that base. Configure the `mcpOAuth()` resource with that full URL. OAuth discovery stays at the origin root through global middleware.
- The protocol is the stateless JSON subset of Streamable HTTP, revisions `2025-11-25` and `2025-06-18`, from `@vite-hub/internal/runtime/mcp-server`. The Console MCP uses the same server.
- `vitehub inspect definitions --kind mcp-tool` lists the tools.

## Public imports

| Import | Use |
| --- | --- |
| `@vite-hub/mcp` | `defineMcpTool()` and its types. Apps import it as `vite-hub/mcp`. |
| `@vite-hub/mcp/vite` | `hubMcp()`, the Vite plugin that `vitehub({ mcp })` adds, and `discoverMcpTools()`. |
| `@vite-hub/mcp/runtime` | `createMcpHandler()` and `createMcpOAuthDiscoveryHandler()`, which the generated server entry imports. |
