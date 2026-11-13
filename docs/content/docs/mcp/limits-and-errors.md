---
title: MCP server limits and errors
description: Know which part of MCP the server speaks, and fix the MCP build errors.
navigation.title: Limits and errors
navigation.order: 7
icon: i-lucide-circle-alert
---

## Protocol

The server is ViteHub's own MCP server. It uses no MCP SDK. The [ViteHub MCP](/docs/development/mcp) of the Console uses the same server.

- It speaks the stateless JSON subset of Streamable HTTP, revisions `2025-11-25` and `2025-06-18`.
- It answers `initialize`, `ping`, `tools/list`, and `tools/call`. Other methods get JSON-RPC `-32601`.
- It keeps no session between requests and has no event stream. A request that is not `POST` gets `405`.
- It serves tools only: no resources and no prompts.

## Errors

A wrong route, a wrong tool file name, or a `publicRoute` without sign-in fails the build. A tool that sets `public` without a `publicRoute` fails the server.

### MCP_B0001

`mcp.route` is not a path, such as a route with a query or `//`. Set a path such as `/mcp`.

### MCP_B0002

A file in `server/mcp/tools/` has a name that MCP does not allow as a tool name. Rename the file.

### MCP_B0003

`mcp.publicRoute` is set with `mcp: { auth: false }`. Then every tool on `mcp.route` is public already. Remove `publicRoute`, or remove `auth: false` and add `mcpOAuth()` from `vite-hub/auth/mcp` to `server/auth.ts`.

### MCP_R0001

A tool sets `public`, but the MCP server has no `mcp.publicRoute`. The error names the tools. Set `mcp: { route: '/mcp/account', publicRoute: '/mcp' }` to serve them without sign-in, or remove `public` from the tools.
