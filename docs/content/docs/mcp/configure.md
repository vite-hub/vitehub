---
title: MCP server configuration
description: Change the route of the MCP server, name it for MCP clients, sign MCP clients in with MCP OAuth, or make the server public.
navigation.title: Configure
navigation.order: 3
icon: i-lucide-sliders-horizontal
---

Set `mcp: true` in the ViteHub options, or pass an object with these options:

| Option | Default | Use |
| --- | --- | --- |
| `route` | `/mcp` | The path of the server below the application base. |
| `auth` | `true` with `auth` | Require an access token from `mcpOAuth()`. |
| `publicRoute` | none | A second path that serves the tools, prompts, and resources with `public: true` without sign-in. |
| `instructions` | A short generic text | What `initialize` tells the Agent about the server. |
| `serverInfo` | The app name, version `"1"` | The `name`, `title`, `version`, `description`, `websiteUrl`, and `icons` that MCP clients show. |

A `route` that is not a path, such as one with a query or `//`, fails the build with [`MCP_B0001`](/docs/mcp/limits-and-errors#mcp_b0001).

## Name the server

MCP clients show the `serverInfo` of the server, and Agents read its `instructions` when they connect. Use the instructions to tell the Agent what the server is for and which tool to call first:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    mcp: {
      instructions: 'Drop stores docs for review. Call list_folders before you publish.',
      serverInfo: { name: 'drop', title: 'Drop', version: '0.1.0', websiteUrl: '/', icons: [{ src: '/favicon.svg', mimeType: 'image/svg+xml', sizes: ['any'] }] },
    },
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({
    mcp: {
      instructions: 'Drop stores docs for review. Call list_folders before you publish.',
      serverInfo: { name: 'drop', title: 'Drop', version: '0.1.0', websiteUrl: '/', icons: [{ src: '/favicon.svg', mimeType: 'image/svg+xml', sizes: ['any'] }] },
    },
  }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({
    mcp: {
      instructions: 'Drop stores docs for review. Call list_folders before you publish.',
      serverInfo: { name: 'drop', title: 'Drop', version: '0.1.0', websiteUrl: '/', icons: [{ src: '/favicon.svg', mimeType: 'image/svg+xml', sizes: ['any'] }] },
    },
  })],
})
```
:::
::

An icon `src` or a `websiteUrl` that starts with `/` is a path on the origin of the request, so one build serves the right URL on each domain. Include the application base in the path when the app has one.

## Sign in with MCP OAuth

With `auth` in `vitehub()`, the MCP server needs an access token. Install `@better-auth/oauth-provider` at the same version as ViteHub's `better-auth`. Then add `mcpOAuth()` to the Auth, with the URL of the server as its resource:

```ts [server/auth.ts]
import { defineAuth } from 'vite-hub/auth'
import { mcpOAuth } from 'vite-hub/auth/mcp'

export default defineAuth(({ requestOrigin }) => ({
  baseURL: requestOrigin,
  plugins: [...mcpOAuth({ resource: `${requestOrigin}/mcp`, loginPage: '/sign-in' })],
}))
```

A request without a valid token gets `401` with `WWW-Authenticate: Bearer resource_metadata="…"`, and the MCP client starts the OAuth flow. The server also answers the discovery documents at `/.well-known/`. The `caller` of a handler has the `user`, the approved `scopes`, and the `clientName`, such as `Claude Code`. See [MCP OAuth](/docs/auth/configure#sign-mcp-clients-in) for the options of `mcpOAuth()`.

Set `mcp: { auth: false }` for a public server in an app with Auth, or to check callers in each handler.

## Serve the app below a base path

For a Nuxt application with `app.baseURL: "/portal/"` (or Nitro `baseURL: "/portal/"`), the MCP URL is `/portal/mcp`. Set the resource to `${requestOrigin}/portal/mcp` and connect the client to that URL. OAuth discovery stays at the origin-root `/.well-known/` paths. Include the base in the resource when you set a custom `mcp.route` too.

## Serve public tools without sign-in

MCP clients do not sign in on an address that answers without a token. To give some tools to anyone and all tools to people who sign in, serve two addresses:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { auth: true, mcp: { route: '/mcp/account', publicRoute: '/mcp' } },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ auth: true, mcp: { route: '/mcp/account', publicRoute: '/mcp' } }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ auth: true, mcp: { route: '/mcp/account', publicRoute: '/mcp' } })],
})
```
:::
::

```ts [server/mcp/tools/search.ts]
import { defineMcpTool } from 'vite-hub/mcp'

export default defineMcpTool({
  description: 'Search the public pages.',
  public: true,
  handler: () => 'results',
})
```

`/mcp` lists only the tools with `public: true`. Prompts and resources with `public: true` are on it too. It answers without a token and never sends an OAuth challenge, and the protected resource metadata names only `/mcp/account`. `/mcp/account` lists every tool and needs a token, so set the `mcpOAuth()` resource to `${requestOrigin}/mcp/account`. On `/mcp`, `caller` is `undefined`.
