# @vite-hub/mcp

The MCP server of a ViteHub app. Each file in `server/mcp/tools/` is one tool, each file in `server/mcp/prompts/` is one prompt, and each file in `server/mcp/resources/` is one resource. The server answers at `/mcp`. Apps install this package and import `vite-hub/mcp`. This README is the contract for ViteHub packages.

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
- A prompt is the default export of `defineMcpPrompt()` in `server/mcp/prompts/<name>.ts`. Its `input` is an object Standard Schema with string fields. `prompts/list` shows each field as an argument, with its `description` and whether it is required. `prompts/get` checks the arguments, then runs `handler(input, { event, caller })`. A string is one user message, an array is the messages, and an object with `messages` is the result. Invalid arguments and a thrown 4xx error are JSON-RPC `-32602` with the message. Other errors are logged and answer `-32603`.
- A resource is the default export of `defineMcpResource()` in `server/mcp/resources/<name>.ts`. It has a fixed `uri`, or a `uriTemplate` where `{name}` matches one path segment and `{+name}` also matches `/`. `resources/list` shows the fixed resources and the entries of each template's `list()`. `resources/templates/list` shows the templates. `resources/read` runs `handler(uri, { event, caller, variables })` of the first resource with that `uri`, else of the first template that matches. A string is text, a `Uint8Array` is a base64 `blob`, and `{ contents }` is sent as it is. `undefined` and an unknown URI are JSON-RPC `-32002`.
- `initialize` advertises the `prompts` and `resources` capabilities only when the app has prompts or resources. Without them, their methods are JSON-RPC `-32601`.
- `mcp.instructions` replaces the generic `instructions` of `initialize`. `mcp.serverInfo` sets `name`, `title`, `version`, `description`, `websiteUrl`, and `icons`. They default to the app name, the name, and `"1"`. An icon `src` or `websiteUrl` that starts with `/` becomes a URL on the request origin.
- `auth` defaults to `true`, in `hubMcp()` and in `vitehub({ mcp })`. Then the generated entry calls `verifyMcpRequest()` from `vite-hub/auth/mcp` for every request, answers `401` with `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource<route>"`, and serves `serveMcpOAuthDiscovery()` as middleware for `/.well-known/**`. `vitehub({ mcp })` without `auth` fails with `VITE_HUB_R0141`. Only an explicit `auth: false` serves every tool without sign-in.
- With `publicRoute`, such as `mcp: { route: "/mcp/account", publicRoute: "/mcp" }`, a second server answers at that route with only the tools, prompts, and resources that set `public: true`. It needs no sign-in, never answers `401`, and the protected resource metadata does not name it. MCP clients do not sign in on a URL that answers without a token, so a server that has public tools and tools for a person needs two URLs. `publicRoute` with `auth: false` fails the build with `MCP_B0003`. A tool that sets `public` on a server without `publicRoute` fails `createMcpHandler()` with `MCP_R0001`, so `public: false` never looks like protection that it is not.
- With a non-root Nitro `baseURL` (including Nuxt `app.baseURL`), the MCP URL includes that base. Configure the `mcpOAuth()` resource with that full URL. OAuth discovery stays at the origin root through global middleware.
- The protocol is the stateless JSON subset of Streamable HTTP, revisions `2025-11-25` and `2025-06-18`, from `@vite-hub/internal/runtime/mcp-server`.
- `vitehub inspect definitions --kind mcp-tool` lists the tools. `--kind mcp-prompt` and `--kind mcp-resource` list the prompts and resources.

## Public imports

| Import | Use |
| --- | --- |
| `@vite-hub/mcp` | `defineMcpTool()`, `defineMcpPrompt()`, `defineMcpResource()`, and their types. Apps import it as `vite-hub/mcp`. |
| `@vite-hub/mcp/vite` | `hubMcp()`, the Vite plugin that `vitehub({ mcp })` adds, and `discoverMcpTools()`. |
| `@vite-hub/mcp/runtime` | `createMcpHandler()` and `createMcpOAuthDiscoveryHandler()`, which the generated server entry imports. |
