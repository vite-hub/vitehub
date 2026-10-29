---
title: ViteHub MCP
description: Connect an Agent to Content, storage metadata, and Comments with Console access.
navigation.order: 32.5
navigation.group: Local tools
icon: i-lucide-plug
---

ViteHub MCP is an MCP server at `/_vitehub/mcp`. It gives an Agent, such as Claude Code or Codex, the tools of the Console sections that you may use. An Agent can read and save Content drafts, inspect Database schemas, list KV keys and Blob objects, and work with [Comments](/docs/comments).

It comes with the [Console](/docs/development/console). There is nothing to turn on. Each request runs with the Console access of the person who connects, and `console.authorize` sections apply: a person without the `comments` section gets no Comments tools. A `comments:read` grant lists and permits only `comments_list_threads` and `comments_get_thread`; replies and resolutions require the full `comments` grant.

## Connect an Agent

Start the app, then add the server to your Agent. With `console: { auth: false }`, a local app needs no sign-in, so this works at once:

```bash [Terminal]
claude mcp add --transport http vitehub http://localhost:5173/_vitehub/mcp
```

In other clients, add a remote MCP server with the type `http` and the same URL.

Ask the Agent, for example: "Read the open comments on /pricing and fix them."

## Tools

### Content, section `content`

| Tool | Needs | Does |
| --- | --- | --- |
| `content_list_collections` | Content `read` | Lists readable collections and their field schemas. |
| `content_list_documents` | Content `read` | Lists readable documents, draft digests, and `nextCursor`. Filters: `collection`, `search`, `state`, `cursor`, `limit`, default 50 and at most 200. |
| `content_read_document` | Content `read` | Reads the draft for `collection` and `id`. For a singleton, use its collection name as `id`. |
| `content_save_draft` | Content `write` | Saves `data` and `body` with `ifDigest`. Use the current draft digest, or `null` for a new document. Does not publish. |

These tools call the same owner actions as the Console. Each call passes the Console user to `content.can()`. Lists filter documents by that user's access. Saves preserve digest conflict checks and edit leases. They cannot override another editor's lease. Saves are marked as destructive writes because they replace a draft. MCP requests have a 256 KiB body limit, including the JSON-RPC envelope.

### Database, section `databases`

| Tool | Does |
| --- | --- |
| `database_list_databases` | Lists the Database names installed in the Console. |
| `database_get_schema` | Lists tables, columns, and relationships for `database`. Defaults to the first Database. Does not query rows. |

### KV, section `kv`

| Tool | Does |
| --- | --- |
| `kv_list_keys` | Lists keys without values. Accepts `store`, `prefix`, `cursor`, and `limit`, default 200 and at most 500. |

### Blob, section `blob`

| Tool | Does |
| --- | --- |
| `blob_list_objects` | Lists object names, sizes, content types, and upload dates. Accepts `store`, `prefix`, `cursor`, and `limit`, default 100 and at most 250. |

KV and Blob default to the `default` store. Only stores installed in the Console can be selected. A result cursor continues the listing. Blob uses the Console's default filter for ViteHub-owned paths. It returns no bytes, URLs, HTTP metadata, or custom metadata.

All Database, KV, Blob, and Content read tools are marked read-only.

### Comments, section `comments`

| Tool | Needs | Does |
| --- | --- | --- |
| `comments_list_threads` | `read` | Lists threads, newest activity first. Filters: `page`, `status` (default `open`), `search`, `limit` (default 25, at most 100). |
| `comments_get_thread` | `read` | Returns one thread: the page, the element, the Vue components with their source files, the browser, the build, and every comment. |
| `comments_reply` | `comment` | Replies to an open thread. |
| `comments_resolve_thread` | `resolve` | Resolves a thread, or reopens it with `resolved: false`. |

The Needs column names the `authorize` action of [`defineComments()`](/docs/comments/configure#decide-who-can-comment). Replies and resolves show the signed-in Console user as the author.

## Access rules

The server lists and runs a tool only when its section is installed and included in `console.authorize`. Guessing the name of a hidden tool does not grant access. Owner policies still apply, including Content and Comments authorization. An open Console passes a null user to Content.

Tools do not expose Env values, credentials, or tokens. There are no tools for Env or Auth, KV values, Database rows, or Blob contents. Content documents remain application data governed by Content access; do not store credentials in document fields or bodies.

Schedule, Queue, and Workflow tools are not included yet. There are no storage write, Content publish, delete, or lease takeover tools.

## Access in production

ViteHub MCP accepts the same access as the Console routes:

- a Console session cookie, with `auth: 'app'` or a Console Auth config;
- a request that Cloudflare Access checked, with `provider: 'cloudflare-access'`;
- any request, with `auth: false`.

A request without access gets `401`. Requests from a browser page on another origin get `403`.

ViteHub MCP has no OAuth sign-in yet, so most desktop Agents cannot connect to an app whose Console uses `auth: 'app'` or Console Auth. Use `auth: false` on a local app, or Cloudflare Access. An app that already serves its own MCP server can add the same tools to it with `commentsMcpTools(comments)` from `vite-hub/comments/runtime`.

## Protocol

ViteHub MCP speaks the stateless JSON form of the Streamable HTTP transport: one JSON-RPC message per `POST`, and one JSON answer. It supports the revisions `2025-11-25` and `2025-06-18`, and the methods `initialize`, `ping`, `tools/list`, and `tools/call`. It does not stream, and it keeps no session. Send the negotiated revision in the `MCP-Protocol-Version` header on subsequent requests; unsupported revisions receive HTTP 400.
