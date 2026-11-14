---
title: Console MCP client
description: Connect the Console to your app's MCP server or another one, sign in with OAuth or a token, and call tools as several accounts side by side.
navigation.title: MCP client
navigation.order: 13
navigation.group: Use the Console
icon: i-lucide-cable
---

The MCP client section runs on your app's server. It connects to MCP servers over Streamable HTTP as the Console caller. It lists and calls their tools, reads their resources, gets their prompts, and shows each result as the server sent it. Agents cannot use these connections.

## Turn it on

Set `console.mcpClient` to `true`, and install the MCP SDK in your app:

```sh
pnpm add @modelcontextprotocol/sdk
```

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    console: { mcpClient: true },
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
  plugins: [
    vitehub({
      console: { mcpClient: true },
    }),
    nitro(),
  ],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      console: { mcpClient: true },
    }),
  ],
})
```
:::
::

The section lists the MCP server that the app announces in its [RFC 9728](https://www.rfc-editor.org/rfc/rfc9728) metadata at `/.well-known/oauth-protected-resource`, such as its own [`/mcp`](/docs/mcp). **Connect** also takes the URL of another server. URLs must use HTTPS. Plain HTTP works only for this app and `localhost`. The same rule applies to OAuth endpoints and every redirect.

> [!WARNING]
> Every MCP request starts on the server. A caller with the `mcp-client` section can make the server send requests to any URL. Give the section only to people you trust with the server's network.

## Sign in with OAuth

When a server answers `401`, the section starts the [MCP authorization flow](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization):

1. It reads the protected resource metadata that the `WWW-Authenticate` header names, then the metadata of the authorization server, with RFC 8414 or OpenID Connect discovery.
2. It registers a public client with dynamic client registration (RFC 7591), and reuses registrations for the same MCP resource and callback URL.
3. The browser opens the authorization URL with PKCE `S256`, `state`, and `resource` (RFC 8707). The authorization server sends the browser back to `/_vitehub/mcp-client/callback`, and the server exchanges the code. It checks a supplied `iss` (RFC 9207) against discovery. When the authorization server lists `offline_access`, the section asks for it.
4. When the MCP server rejects an access token, the section uses its refresh token. Without one, the connection shows **Signed out**.
5. **Disconnect** ends the MCP session, and revokes the tokens when the authorization server names a revocation endpoint (RFC 7009).

When a server has no OAuth, choose **Token** and paste a bearer token.

Each connection has its own grant and MCP session, so you can open one server as several accounts. **Run as** sends the same call through other connections to the server and shows the results side by side.

## Keep connections across restarts

The server keeps MCP connections per caller. Tokens, refresh tokens, PKCE verifiers, and client registrations never reach the browser.

By default, connections live in server memory, and a restart ends them. To keep them, turn on the default [KV](/docs/kv) store with `kv: true` and set `VITEHUB_CONSOLE_MCP_KEY`. Generate the key with `openssl rand -base64 32`.

With the key, the server seals each connection and client registration with AES-GCM under `vitehub:console:mcp-client:`. Key names hold a hash of the owner, not their id or email. A key change makes old connections read as missing. Use a KV driver that all instances share, such as Cloudflare KV. Without the key, use the MCP client only in development or on one Node server.
