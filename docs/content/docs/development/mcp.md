---
title: ViteHub MCP
description: Connect an Agent to the app's Comments through the MCP server that the Console serves.
navigation.order: 32.5
navigation.group: Local tools
icon: i-lucide-plug
---

ViteHub MCP is an MCP server at `/_vitehub/mcp`. It gives an Agent, such as Claude Code or Codex, the tools of the Console sections that you may use. Today these are the [Comments](/docs/comments) tools: an Agent reads what the team said about a page, finds the code, then replies and resolves the thread.

It comes with the [Console](/docs/development/console). There is nothing to turn on. Each request runs with the Console access of the person who connects, and `console.authorize` sections apply: a person without the `comments` section gets no Comments tools.

## Connect an Agent

Start the app, then add the server to your Agent. With `console: { auth: false }`, a local app needs no sign-in, so this works at once:

```bash [Terminal]
claude mcp add --transport http vitehub http://localhost:5173/_vitehub/mcp
```

In other clients, add a remote MCP server with the type `http` and the same URL.

Ask the Agent, for example: "Read the open comments on /pricing and fix them."

## Tools

| Tool | Needs | Does |
| --- | --- | --- |
| `comments_list_threads` | `read` | Lists threads, newest activity first. Filters: `page`, `status` (default `open`), `search`, `limit` (default 25, at most 100). |
| `comments_get_thread` | `read` | Returns one thread: the page, the element, the Vue components with their source files, the browser, the build, and every comment. |
| `comments_reply` | `comment` | Replies to an open thread. |
| `comments_resolve_thread` | `resolve` | Resolves a thread, or reopens it with `resolved: false`. |

The Needs column names the `authorize` action of [`defineComments()`](/docs/comments/configure#decide-who-can-comment). Replies and resolves show the signed-in Console user as the author.

## Access in production

ViteHub MCP accepts the same access as the Console routes:

- a Console session cookie, with `auth: 'app'` or a Console Auth config;
- a request that Cloudflare Access checked, with `provider: 'cloudflare-access'`;
- any request, with `auth: false`.

A request without access gets `401`. Requests from a browser page on another origin get `403`.

ViteHub MCP has no OAuth sign-in yet, so most desktop Agents cannot connect to an app whose Console uses `auth: 'app'` or Console Auth. Use `auth: false` on a local app, or Cloudflare Access. An app that already serves its own MCP server can add the same tools to it with `commentsMcpTools(comments)` from `vite-hub/comments/runtime`.

## Protocol

ViteHub MCP speaks the stateless JSON form of the Streamable HTTP transport: one JSON-RPC message per `POST`, and one JSON answer. It supports the revisions `2025-11-25`, `2025-06-18`, `2025-03-26`, and `2024-11-05`, and the methods `initialize`, `ping`, `tools/list`, and `tools/call`. It does not stream, and it keeps no session.
