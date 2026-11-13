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
- It answers `initialize`, `ping`, `tools/list`, and `tools/call`. With prompts, it also answers `prompts/list` and `prompts/get`. With resources, it also answers `resources/list`, `resources/templates/list`, and `resources/read`. Other methods get JSON-RPC `-32601`.
- It keeps no session between requests and has no event stream. A request that is not `POST` gets `405`.
- It has no resource subscriptions, no list change notifications, and no pagination. A list returns all its entries.
- An unknown resource URI, or a resource handler that returns `undefined`, gets JSON-RPC `-32002`. Invalid prompt arguments get `-32602`.

## Errors

A wrong route, a wrong tool file name, or a second hooks module fails the build.

### MCP_B0001

`mcp.route` is not a path, such as a route with a query or `//`. Set a path such as `/mcp`.

### MCP_B0002

A file in `server/mcp/tools/` has a name that MCP does not allow as a tool name. Rename the file.

### MCP_B0003

More than one server directory has an `mcp.ts` hooks module, such as `server/mcp.ts` and `app/mcp.ts`. Keep one `defineMcpHooks()` module.
