---
title: Console MCP client
description: Connect the Console to your app's MCP server or another one, sign in with OAuth or a token, and call tools as several accounts side by side.
navigation.title: MCP client
navigation.order: 13
navigation.group: Use the Console
icon: i-lucide-cable
---

The **MCP client** section calls any MCP server from the Console: its tools, resources and prompts, with each result as the server sent it, as one account or several side by side. It runs on your app's server and connects over Streamable HTTP as the Console caller. Agents cannot use these connections.

## Turn it on

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


The section lists the server that the app announces in its [RFC 9728](https://www.rfc-editor.org/rfc/rfc9728) metadata at `/.well-known/oauth-protected-resource`, such as its own [`/mcp`](/docs/mcp), and **Connect** takes any other URL. URLs, OAuth endpoints and redirects must use HTTPS, except for this app and `localhost`.

::warning
Every MCP request starts on the server, so a caller with the `mcp-client` section can make it send requests to any URL. Give the section only to people you trust with the server's network.
::

## Sign in with OAuth

When a server answers `401`, the section runs the [MCP authorization flow](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization). It reads the protected resource metadata that `WWW-Authenticate` names, finds the authorization server through RFC 8414 or OpenID Connect discovery, and registers a public client (RFC 7591). You sign in with PKCE `S256`, `state` and `resource` (RFC 8707), plus `offline_access` when offered, and the browser returns to `/_vitehub/mcp-client/callback`, where the server checks a supplied `iss` (RFC 9207).

A rejected access token is refreshed, and without a refresh token the connection shows **Signed out**. **Disconnect** ends the MCP session and revokes the tokens when the server names a revocation endpoint (RFC 7009). For a server without OAuth, choose **Token** and paste a bearer token.

Each connection has its own grant and MCP session, so **Run as** can send one call through several accounts on the same server and show the results side by side.

## Keep connections across restarts

Connections live in server memory by default, so a restart ends them. To keep them, set `kv: true` for the default [KV](/docs/kv) store and a sealing key:

```bash [Terminal]
openssl rand -base64 32 # set as VITEHUB_CONSOLE_MCP_KEY
```

The server then seals each connection and client registration with AES-GCM under `vitehub:console:mcp-client:`, keyed by a hash of the owner, not their id or email. Use a KV driver that every instance shares, such as Cloudflare KV. Without the key, use the MCP client only in development or on one Node server. A new key makes old connections read as missing.

Connections belong to their caller, and tokens, refresh tokens, PKCE verifiers and client registrations never reach the browser.
