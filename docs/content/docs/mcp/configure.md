---
title: MCP server configuration
description: Change the route of the MCP server, sign MCP clients in with MCP OAuth, or make the server public.
navigation.title: Configure
navigation.order: 3
icon: i-lucide-sliders-horizontal
---

Set `mcp: true` in the ViteHub options, or pass an object with these options:

| Option | Default | Use |
| --- | --- | --- |
| `route` | `/mcp` | The path of the server below the application base. |
| `auth` | `true` | Require an access token from `mcpOAuth()`. The app needs `auth`. `false` lets anyone call every tool. |
| `publicRoute` | none | A second path that serves the tools with `public: true` without sign-in. Needs `auth`. |

A `route` that is not a path, such as one with a query or `//`, fails the build with [`MCP_B0001`](/docs/mcp/limits-and-errors#mcp_b0001).

## Sign in with MCP OAuth

The MCP server needs an access token, so set `auth` in `vitehub()`. Without `auth`, the build fails with `VITE_HUB_R0141`. Install `@better-auth/oauth-provider` at the same version as ViteHub's `better-auth`. Then add `mcpOAuth()` to the Auth, with the URL of the server as its resource:

```ts [server/auth.ts]
import { defineAuth } from 'vite-hub/auth'
import { authDatabase } from 'vite-hub/auth/database'
import { mcpOAuth } from 'vite-hub/auth/mcp'

export default defineAuth(({ requestOrigin }) => ({
  baseURL: requestOrigin,
  database: authDatabase(),
  plugins: [...mcpOAuth({ resource: `${requestOrigin}/mcp`, loginPage: '/sign-in' })],
}))
```

A request without a valid token gets `401` with `WWW-Authenticate: Bearer resource_metadata="…"`, and the MCP client starts the OAuth flow. The server also answers the discovery documents at `/.well-known/`. The `caller` of a handler has the `user`, the approved `scopes`, and the `clientName`, such as `Claude Code`. See [MCP OAuth](/docs/auth/configure#sign-mcp-clients-in) for the options of `mcpOAuth()`.

## Make every tool public

Set `mcp: { auth: false }` to let anyone who knows the URL call every tool, or to check callers in each handler. This works with or without `auth` in `vitehub()`. Then `caller` is always `undefined`, and `publicRoute` fails the build with [`MCP_B0003`](/docs/mcp/limits-and-errors#mcp_b0003).

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

`/mcp` lists only the tools with `public: true`. It answers without a token and never sends an OAuth challenge, and the protected resource metadata names only `/mcp/account`. `/mcp/account` lists every tool and needs a token, so set the `mcpOAuth()` resource to `${requestOrigin}/mcp/account`. On `/mcp`, `caller` is `undefined`.

Set `public` on a tool only with `publicRoute`. Without `publicRoute`, a tool with `public: true` or `public: false` fails the server with [`MCP_R0001`](/docs/mcp/limits-and-errors#mcp_r0001), because the option would do nothing.
