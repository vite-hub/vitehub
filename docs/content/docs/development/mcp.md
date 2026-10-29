---
title: MCP
description: Let an agent use your app's operations through the Model Context Protocol, as the person who signed in.
navigation.order: 32.2
navigation.group: Local tools
icon: i-lucide-plug
---

The app serves an [MCP](https://modelcontextprotocol.io) endpoint at `/_vitehub/mcp`. Every [operation](/docs/development/operations) of the app is a tool. An agent such as Claude Code or Codex calls the same code as the Console and the CLI, as the person who signed in.

The endpoint uses Streamable HTTP without a session: each `POST` carries one JSON-RPC message and gets one JSON answer. It speaks the revisions `2025-11-25` and `2025-06-18`. It is served in `vite dev` and in builds that set [`console`](/docs/development/console). An app that serves from a base path, such as `/portal`, has the endpoint at `/portal/_vitehub/mcp`.

## Connect an agent

The Console home has a **Connect an agent** panel with these commands for your origin:

```bash [Terminal]
claude mcp add --transport http vitehub https://app.example.com/_vitehub/mcp
```

```toml [~/.codex/config.toml]
[mcp_servers.vitehub]
url = "https://app.example.com/_vitehub/mcp"
```

For Cloudflare Access, create a service token and allow it in the application's Service Auth policy. Set `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` in your shell. The Console shows these commands when Cloudflare Access protects it:

```bash [Terminal]
claude mcp add --transport http vitehub https://app.example.com/_vitehub/mcp --header "CF-Access-Client-Id: ${CF_ACCESS_CLIENT_ID}" --header "CF-Access-Client-Secret: ${CF_ACCESS_CLIENT_SECRET}"
```

Claude Code saves the expanded header values in its MCP configuration. Codex reads the environment variables when it starts:

```toml [~/.codex/config.toml]
[mcp_servers.vitehub]
url = "https://app.example.com/_vitehub/mcp"
env_http_headers = { "CF-Access-Client-Id" = "CF_ACCESS_CLIENT_ID", "CF-Access-Client-Secret" = "CF_ACCESS_CLIENT_SECRET" }
```

## What the agent sees

`tools/list` shows an operation only when the caller may use it. Two checks decide:

- **Section access.** The Console runs `console.authorize` for the signed-in person and keeps the sections it returns. An operation of another section is not listed, and a call to it fails as an unknown tool.
- **Scopes.** An access token carries the scopes the person approved. `vitehub:read` lets it call `read` operations. `vitehub:write` lets it call `write` and `destructive` ones. A tool that the scopes do not cover is not listed, and a call to it gets `403` with `WWW-Authenticate: Bearer error="insufficient_scope"`. A person signed in with a session has no scope limit.

A tool is named after its operation with every character outside letters, digits, `_`, and `-` replaced by `_`: the operation `content.publish` is the tool `content_publish`. A call uses the tool name. Two operations that would share a tool name fail the build with `INTERNAL_B0050`. The `title` of a tool is the operation name in words, such as "Content publish", and the `description` is the sentence of the operation.

The annotations come from the `kind` of the operation:

| Operation `kind` | Tool annotation |
| --- | --- |
| `read` | `readOnlyHint: true` |
| `write` | `readOnlyHint: false`, `destructiveHint: false` |
| `destructive` | `destructiveHint: true`: it deletes or publishes. |

The annotations are hints for the client. A client may ask the person before it runs a `destructive` tool, or it may not, and ViteHub cannot make it ask. The guard is section access and scopes, which the server enforces on every call.

The input schema of a tool is the JSON Schema of the operation input. The Console editor transports (`documents.action`, `media.action`) are not tools, and any operation can opt out with `mcp: false`.

A call runs with `surface: "mcp"` and `context.user` set to the person. A failure is a normal result with `isError: true`, so the model can read it:

```txt
FIXTURE_R0001: The note is locked.
Fix: Unlock it first.
```

`structuredContent.error` has `code`, `message`, `fix`, and `details` for failures below status 500. A call to an unknown tool, or a message the server does not know, is a JSON-RPC error.

## Package tools

Installed packages also contribute tools alongside operations. They use the same Console section grants and OAuth scopes. When a registered tool shares an operation’s MCP name, the registered tool supplies the schema and implementation.

With [Comments](/docs/comments), ask an agent, for example: "Read the open comments on /pricing and fix them."

### Content, section `content`

| Tool | Needs | Does |
| --- | --- | --- |
| `content_list_collections` | Content `read` | Lists readable collections and their field schemas. |
| `content_list_documents` | Content `read` | Lists readable documents, draft digests, and `nextCursor`. Filters: `collection`, `search`, `state`, `cursor`, `limit`, default 50 and at most 200. |
| `content_read_document` | Content `read` | Reads the draft for `collection` and `id`. For a singleton, use its collection name as `id`. |
| `content_save_draft` | Content `write` | Saves `data` and `body` with `ifDigest`. Use the current draft digest, or `null` for a new document. Does not publish. |

These tools call the same owner actions as the Console. Each call passes the Console user to `content.can()`. Lists filter documents by that user's access. Saves preserve digest conflict checks and edit leases. They cannot override another editor's lease. Saves are marked as destructive writes because they replace a draft. These registered tools have a 256 KiB request body limit, including the JSON-RPC envelope.

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
| `comments_get_thread` | `read` | Returns a thread's page, element, Vue components and source files, browser, build, and comments. |
| `comments_reply` | `comment` | Replies to an open thread. |
| `comments_resolve_thread` | `resolve` | Resolves a thread, or reopens it with `resolved: false`. |

The Needs column names the `authorize` action of [`defineComments()`](/docs/comments/configure#decide-who-can-comment). These tools require the installed `comments` Console section. A `comments:read` grant allows only listing and reading; replies and resolutions need the full `comments` grant. OAuth tokens also need `vitehub:read` for reads or `vitehub:write` for writes. Replies and resolutions show the checked Comments user as the author. An app with its own MCP server can use `commentsMcpTools(comments)` from `vite-hub/comments/runtime`.

## Sign-in

| Console access | MCP sign-in |
| --- | --- |
| `console: { auth: 'app' }` or a session Console Auth | OAuth 2.1. The client registers itself, opens the browser once, and sends a bearer token. |
| `console: { auth: { provider: 'cloudflare-access' } }` | The Cloudflare Access service token headers (`CF-Access-Client-Id` and `CF-Access-Client-Secret`) that the Console already accepts. There is no OAuth flow, so the `401` has no `resource_metadata`. |
| `console: { auth: false }`, or `vite dev` with no `console` option | None. Only loopback requests are served in development, as for the [RPC](/docs/development/console). |

A request without a valid sign-in gets `401` and a `WWW-Authenticate: Bearer resource_metadata="…"` header. A token that is not valid gets `error="invalid_token"` in the same header. The metadata is at `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/_vitehub/mcp`, and names the authorization server.

### Set up OAuth

The authorization server is Better Auth. A Console Auth that ViteHub generates (inline GitHub, or `vitehub/console/auth/server.ts` with `defineConsoleAuth()`) already has the `jwt()` and `oauthProvider()` plugins. The sign-in page of the Console is also the login and consent page of the flow. A Console Auth with `migrate: false` manages its own schema, so it adds the plugins itself. ViteHub preserves a supplied OAuth provider and adds a registration hook that recognizes MCP clients' loopback redirects, including with `migrate: false`.

A bearer token still runs the Console Auth `authorize` callback with the verified user, followed by `console.authorize`. With `console.auth: 'app'`, it also runs every matching app Auth access route’s `authorize` callback. It has no browser session, so these callbacks receive an empty `session` object. Tokens authenticate only the exact mounted MCP endpoint; other routes continue to require a session.

For `console: { auth: 'app' }`, add them to the Auth that signs people in:

```ts [server/auth.ts]
import { oauthProvider } from '@better-auth/oauth-provider'
import { jwt } from 'better-auth/plugins'
import { defineAuth } from 'vite-hub/auth'
import { consoleMcpNativeClients } from 'vite-hub/console/auth'

export default defineAuth(({ requestOrigin }) => ({
  baseURL: requestOrigin,
  plugins: [
    jwt(),
    consoleMcpNativeClients(),
    oauthProvider({
      loginPage: '/sign-in',
      consentPage: '/oauth',
      scopes: ['openid', 'profile', 'email', 'offline_access', 'vitehub:read', 'vitehub:write'],
      resources: [`${requestOrigin}/_vitehub/mcp`],
      clientRegistrationDefaultResources: [`${requestOrigin}/_vitehub/mcp`],
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
    }),
  ],
}))
```

`resources` declares the MCP resource, and `clientRegistrationDefaultResources` links dynamically registered clients to it when their registration omits a resource list. Include both in a supplied `oauthProvider()`, including with `migrate: false`. Without `resources` Better Auth issues opaque tokens, not JWTs, and the Console cannot check them. When `jwt()`, `oauthProvider()`, the resource in either list, or the two `vitehub:` scopes are missing from the Auth, the Console answers `503` with `CONSOLE_MCP_OAUTH_INCOMPLETE` and the fix on both metadata endpoints.

A server never takes the issuer or the resource from the `Host` header of a request, since whoever sends the request picks the header. They come from configuration, in this order:

1. `console.mcp.resource`, the absolute URL of the endpoint, such as `https://app.example.com/_vitehub/mcp`.
2. `vitehub({ publicUrl })`.
3. A `baseURL` that the Auth sets itself. An Auth with `baseURL: requestOrigin` follows the request, so it does not count.

In `vite dev` the request origin is used, because the port changes. Without any of these in production, OAuth is off: the metadata endpoints answer `503` with `CONSOLE_MCP_ORIGIN_REQUIRED`, and a bearer token is not accepted. The issuer is the `jwt.issuer` or the `baseURL` of the Auth. Set `console.mcp.issuer` when tokens carry another one. Configured issuer URLs are normalized with their final slash removed. Set `jwt.issuer` to that canonical URL without a trailing slash: Better Auth 1.7.7 normalizes discovery but preserves the option in access-token claims, so the Console rejects a noncanonical Auth issuer with `CONSOLE_MCP_OAUTH_INCOMPLETE`. Resource identifiers remain exact, including any trailing slash.

```ts [vite.config.ts]
vitehub({ console: { auth: 'app', mcp: { resource: 'https://app.example.com/_vitehub/mcp' } } })
```

The Console checks an access token on `/_vitehub/mcp` and nowhere else: the path of the request must be exactly the endpoint (`/portal/_vitehub/mcp` below a base path), and a path that only contains it, such as `/_vitehub/rpc/_vitehub/mcp`, does not count. It reads the signing keys from the Auth in the same process, with no request to the authorization server. It checks the signature against the algorithms of those keys, the issuer, the audience (the resource), and the expiry with 30 seconds of tolerance. Then it reads the person by the `sub` claim from the Auth, so a deleted or banned person loses access while the token is still valid, and runs `console.authorize` with that user. Other Console routes keep to the session.

### Discovery at the origin root

MCP clients look for the authorization server at the origin root, not below the Better Auth base path. The Console serves `/.well-known/oauth-authorization-server` and, for an issuer with a path, `/.well-known/oauth-authorization-server/api/auth` at the root. Better Auth serves the same document only below its own base path, so the Console adds the routes. The authorization-server document must publish the same issuer as `console.mcp.issuer` (or the Auth-derived issuer). A mismatch returns `503` with `CONSOLE_MCP_OAUTH_INCOMPLETE`; configure Better Auth's `jwt.issuer` to match. A reverse proxy must forward `/.well-known/*` to the app.

## Limits

- A tool call has the request limit of its operation: 64 KiB by default, raised by its `maxRequestBytes`. A tool that a package registers, such as a Comments tool, has 256 KiB. Other messages have 2 MiB. The server counts the bytes while it reads the body, so a missing or wrong `content-length` changes nothing. A request over the limit gets `413` before any tool runs.
- A batch (a JSON array) gets `400`: the supported revisions removed batches.
- Arguments that do not match the input schema are a tool result with `isError: true` on `2025-11-25`, so the Agent reads the error and calls again. On `2025-06-18`, a registered tool answers the JSON-RPC error `-32602`. An operation always answers with its own `isError` result, which names the fields to fix.
- An `id` is a string or a number, and a message with an `id` needs a `method`. Anything else, `null` too, is `-32600`.
- A request with an `MCP-Protocol-Version` header that the server does not speak gets `400`.
- The endpoint has no event stream, so `GET` answers `405`. A request with an `Origin` header of another origin gets `403`: MCP clients send none.
