---
title: Your app's MCP server
description: Give Agents the tools of your app through the Model Context Protocol, one file per tool, with MCP OAuth sign-in.
navigation.title: App MCP server
navigation.order: 32.25
navigation.group: Local tools
icon: i-lucide-plug-zap
---

Your app can serve its own [MCP](https://modelcontextprotocol.io) server, so Agents such as Claude Code, Codex, or ChatGPT call your code. Each file in `server/mcp/tools/` is one tool. The server answers at `/mcp`.

This is not the [Console MCP](/docs/development/mcp) at `/_vitehub/mcp`, which gives the operations of ViteHub to the people of the Console.

## Turn it on

Install `@vite-hub/mcp` and set `mcp` in `vitehub()`:

```bash [Terminal]
pnpm add @vite-hub/mcp
```

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ mcp: true })],
})
```

## Write a tool

The file name is the tool name. `input` is a Standard Schema that also gives its JSON Schema, such as a Zod 4 object or a Valibot schema in `toStandardJsonSchema()`. The server checks the arguments before the handler runs:

```ts [server/mcp/tools/add.ts]
import { defineMcpTool } from 'vite-hub/mcp'
import { z } from 'zod'

export default defineMcpTool({
  description: 'Add two numbers.',
  input: z.object({ a: z.number(), b: z.number() }),
  handler: ({ a, b }) => ({ sum: a + b }),
})
```

The handler gets the checked input and `{ event, caller }`. It returns a string for one text block, or a value that the server sends as JSON text and, for an object, as `structuredContent`. Return `{ content: [...] }` to send MCP content blocks, such as an image. Throw an error with a 4xx `status`, such as H3's `HTTPError`, to tell the Agent what to fix. Other errors are logged, and the Agent reads only that the tool failed.

## Sign in with MCP OAuth

With `auth` in `vitehub()`, the MCP server needs an access token. Add `mcpOAuth()` to the Auth, with the URL of the server as its resource:

```ts [server/auth.ts]
import { defineAuth } from 'vite-hub/auth'
import { mcpOAuth } from 'vite-hub/auth/mcp'

export default defineAuth(({ requestOrigin }) => ({
  baseURL: requestOrigin,
  plugins: [...mcpOAuth({ resource: `${requestOrigin}/mcp`, loginPage: '/sign-in' })],
}))
```

For a Nuxt application with `app.baseURL: "/portal/"` (or Nitro `baseURL: "/portal/"`), the MCP URL is `/portal/mcp`. Set the resource to `${requestOrigin}/portal/mcp` and connect the client to that URL. OAuth discovery stays at the origin-root `/.well-known/` paths. Include the base in the resource when you set a custom `mcp.route` too.

A request without a valid token gets `401` with `WWW-Authenticate: Bearer resource_metadata="…"`, and the MCP client starts the OAuth flow. The server also answers the discovery documents at `/.well-known/`. `caller` has the `user`, the approved `scopes`, and the `clientName`, such as `Claude Code`. See [MCP OAuth](/docs/auth/configure#sign-in-mcp-clients-with-oauth) for the options of `mcpOAuth()`.

Set `mcp: { auth: false }` for a public server in an app with Auth.

| Option | Default | Use |
| --- | --- | --- |
| `route` | `/mcp` | The path of the server below the application base. |
| `auth` | `true` with `auth` | Require an access token from `mcpOAuth()`. |

## Connect an Agent

```bash [Terminal]
claude mcp add --transport http my-app https://app.example.com/mcp
```

## Inspect the tools

```bash [Terminal]
vitehub inspect definitions --kind mcp-tool
```
