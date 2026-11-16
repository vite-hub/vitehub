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
| `auth` | `true` | Require an access token from `mcpOAuth()`. The app needs `auth`. `'optional'` also lets anyone call the tools with `public: true`. `false` lets anyone call every tool. |
| `publicRoute` | none | A second path that serves the tools, prompts, and resources with `public: true` without sign-in. Needs `auth: true`. |
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

The MCP server needs an access token, so set `auth` in `vitehub()`. Without `auth`, the build fails with `VITE_HUB_MCP_AUTH_MISSING`. Install `@better-auth/oauth-provider` at the same version as ViteHub's `better-auth`. Then add `mcpOAuth()` to the Auth, with the URL of the server as its resource:

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

Set `mcp: { auth: false }` to let anyone who knows the URL call every tool, or to check callers in each handler. This works with or without `auth` in `vitehub()`. Without `resolveCaller`, `caller` is always `undefined`, and `publicRoute` fails the build with [`MCP_B0003`](/docs/mcp/limits-and-errors#mcp_b0003).

To give the handlers the app's own identity, add `resolveCaller` in [`server/mcp.ts`](/docs/mcp/server-api#resolve-the-caller-and-log-tool-calls).

## Serve the app below a base path

For a Nuxt application with `app.baseURL: "/portal/"` (or Nitro `baseURL: "/portal/"`), the MCP URL is `/portal/mcp`. Set the resource to `${requestOrigin}/portal/mcp` and connect the client to that URL. OAuth discovery stays at the origin-root `/.well-known/` paths. Include the base in the resource when you set a custom `mcp.route` too.

## Let anyone call some tools

Set `public: true` on the tools that anyone may call. Then choose how the server serves them:

- `auth: 'optional'` serves one address. ChatGPT lists every tool, runs the public ones, and asks the person to sign in when they call another tool. Use it for an app in ChatGPT.
- `publicRoute` serves a second address with only the public tools. Most other MCP clients, such as Claude Code and Cursor, sign in only on an address that answers `401` without a token, so they need the second address.

### One address for ChatGPT

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { auth: true, mcp: { auth: 'optional' } },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ auth: true, mcp: { auth: 'optional' } }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ auth: true, mcp: { auth: 'optional' } })],
})
```
:::
::

```ts [server/mcp/tools/show_lesson.ts]
import { defineMcpTool } from 'vite-hub/mcp'
import { z } from 'zod'

export default defineMcpTool({
  description: 'Play a lesson in the chat.',
  input: z.object({ lessonId: z.string() }),
  public: true,
  handler: ({ lessonId }, { caller }) => `Playing ${lessonId} for ${caller ? caller.user.name : 'a guest'}.`,
})
```

```ts [server/mcp/tools/create_lesson.ts]
import { defineMcpTool } from 'vite-hub/mcp'
import { z } from 'zod'

export default defineMcpTool({
  description: 'Create a lesson in the account of the user.',
  input: z.object({ title: z.string() }),
  scopes: ['lessons:write'],
  handler: ({ title }, { caller }) => `Created "${title}" for ${caller?.user.name}.`,
})
```

- A request without a token lists every tool, with `securitySchemes` that tell ChatGPT which tools need sign-in: `[{ type: 'noauth' }, { type: 'oauth2' }]` for a public tool, `[{ type: 'oauth2', scopes }]` for another.
- A call of `show_lesson` without a token runs with `caller` set to `undefined`.
- A call of `create_lesson` without a token does not run the handler. It returns a tool error with an `insufficient_scope` challenge in `_meta["mcp/www_authenticate"]`, and ChatGPT shows the sign-in.
- A signed-in caller whose token lacks the `scopes` of a tool gets the same kind of tool error, so ChatGPT asks the person to approve them.
- A request with an invalid token gets `401`, as with `auth: true`.
- Prompts and resources without `public: true` are hidden from a request without a token. Set `public: true` on the `ui://` resource of a public MCP App tool.

### A second address for other clients

To give some tools to anyone and all tools to people who sign in, in every MCP client, serve two addresses:

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

Set `public` on a tool only with `publicRoute`. Without `publicRoute`, a tool with `public: true` or `public: false` fails the server with [`MCP_R0001`](/docs/mcp/limits-and-errors#mcp_r0001), because the option would do nothing.
