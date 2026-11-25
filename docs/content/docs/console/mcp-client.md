---
title: Console MCP client
description: Connect the Console to your app's MCP server or another one, sign in with OAuth or a token, and call tools as several accounts side by side.
navigation.title: MCP client
navigation.order: 13
navigation.group: Use the Console
icon: i-lucide-cable
---

The **MCP client** section calls any MCP server from the Console: its tools, resources and prompts, with each result as the server sent it, as one account or several side by side. The ViteHub Console server runs it, not your app. It connects over Streamable HTTP as the Console user. Agents and API keys cannot use these connections.

You do not set anything in the app. Open the app in the [ViteHub Console](/docs/console) and select **MCP client**. The app needs no `@modelcontextprotocol/sdk` and no `console` option for it.

The section lists the server that the app announces in its [RFC 9728](https://www.rfc-editor.org/rfc/rfc9728) metadata at `/.well-known/oauth-protected-resource`, such as its own [`/mcp`](/docs/mcp), and **Connect** takes any other URL. URLs, OAuth endpoints and redirects must use HTTPS.

The Console reads all pages of a list of tools, resources or prompts in one MCP session. A list of more than 20 pages fails with [`CONSOLE_MCP_LIST_TOO_LONG`](/docs/development/diagnostics/console_mcp_list_too_long).

## Private MCP servers

The Console refuses private addresses, such as `localhost` and `10.0.0.8`. To use an MCP server that listens only on your computer or network:

- Run a [self-hosted Console](/docs/console/get-started#self-host-the-console) on the same computer or network with `VITEHUB_CONSOLE_ALLOW_PRIVATE=true`. It then also accepts `http:` for private addresses.
- Or put the server behind an HTTPS tunnel and connect to the tunnel URL.

::warning
Every MCP request starts on the Console server. On a self-hosted Console with `VITEHUB_CONSOLE_ALLOW_PRIVATE=true`, a person with the `mcp-client` section can make it send requests to its network. Give the section only to people you trust with that network.
::

## Sign in with OAuth

When a server answers `401`, the section runs the [MCP authorization flow](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization). It reads the protected resource metadata that `WWW-Authenticate` names, finds the authorization server through RFC 8414 or OpenID Connect discovery, and registers a public client (RFC 7591). You sign in with PKCE `S256`, `state` and `resource` (RFC 8707), plus `offline_access` when offered. The browser returns to `<console origin>/mcp-client/callback`, such as `https://console.vitehub.dev/mcp-client/callback`, where the Console checks a supplied `iss` (RFC 9207). Register that URL when a server needs a fixed callback.

A rejected access token is refreshed, and without a refresh token the connection shows **Signed out**. **Disconnect** ends the MCP session and revokes the tokens when the server names a revocation endpoint (RFC 7009). For a server without OAuth, choose **Token** and paste a bearer token.

Each connection has its own grant and MCP session, so **Run as** can send one call through several accounts on the same server and show the results side by side.

## Where connections live

Each connection belongs to one person on one project. The Console keeps it in its own database, sealed with its secret, so connections stay across restarts. Tokens, refresh tokens, PKCE verifiers and client registrations never reach the browser or the app.
