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

A wrong route or tool file name fails the build.

### MCP_B0001

`mcp.route` is not a path, such as a route with a query or `//`. Set a path such as `/mcp`.

### MCP_B0002

A file in `server/mcp/tools/` has a name that MCP does not allow as a tool name. Rename the file.
