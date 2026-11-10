---
title: MCP
seo.title: MCP server for your app operations
description: Let an agent use your app's operations over MCP, as the person who signed in.
navigation.order: 32.2
navigation.group: Local tools
icon: i-lucide-plug
---

Your app serves an [MCP](https://modelcontextprotocol.io) endpoint at `/_vitehub/mcp`, where each [operation](/docs/development/operations) is a tool. An agent such as Claude Code or Codex calls the same code as the Console and the CLI, as the person who signed in.

The endpoint uses Streamable HTTP without a session: each `POST` sends one JSON-RPC message and gets one JSON answer. It supports revisions `2025-11-25` and `2025-06-18`. It runs in `vite dev` and in builds that set [`console`](/docs/development/console). Under a base path such as `/portal`, it is at `/portal/_vitehub/mcp`.

## Connect an agent

The Console's **Connect an agent** page, at `/_vitehub/connect`, is linked from the rail and the Overview. It shows the server URL, setup for Claude Code, Codex, Cursor, and VS Code with your origin, how the agent signs in, and the sections its tools can use. For Claude Code and Codex:

```bash [Terminal]
claude mcp add --transport http vitehub https://app.example.com/_vitehub/mcp
```

```toml [~/.codex/config.toml]
[mcp_servers.vitehub]
url = "https://app.example.com/_vitehub/mcp"
```

For Cloudflare Access, create a service token and allow it in the app's Service Auth policy. Set `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` in your shell. The Console shows these commands when Cloudflare Access protects it:

```bash [Terminal]
claude mcp add --transport http vitehub https://app.example.com/_vitehub/mcp --header "CF-Access-Client-Id: ${CF_ACCESS_CLIENT_ID}" --header "CF-Access-Client-Secret: ${CF_ACCESS_CLIENT_SECRET}"
```

Claude Code saves the expanded header values in its MCP configuration. Codex reads the variables when it starts:

```toml [~/.codex/config.toml]
[mcp_servers.vitehub]
url = "https://app.example.com/_vitehub/mcp"
env_http_headers = { "CF-Access-Client-Id" = "CF_ACCESS_CLIENT_ID", "CF-Access-Client-Secret" = "CF_ACCESS_CLIENT_SECRET" }
```

## What the agent sees

`tools/list` shows an operation only when the caller may use it. Two checks decide:

- **Section access.** The Console runs `console.authorize` for the signed-in person and keeps the sections it returns. Operations of other sections are not listed, and a call to one fails as an unknown tool.
- **Scopes.** An access token has the scopes the person approved. `vitehub:read` allows `read` operations. `vitehub:write` allows `write` and `destructive` ones. Tools outside the scopes are not listed, and a call to one gets `403` with `WWW-Authenticate: Bearer error="insufficient_scope"`. A person signed in with a session has no scope limit.

A tool name is the operation name with each character other than letters, digits, `_`, and `-` changed to `_`: `content.publish` becomes `content_publish`. Calls use the tool name. Two operations with the same tool name fail the build with `INTERNAL_B0050`. The tool `title` is the operation name in words, such as "Content publish", and the `description` is the operation's sentence.

The operation `kind` sets the annotations:

| Operation `kind` | Tool annotation |
| --- | --- |
| `read` | `readOnlyHint: true` |
| `write` | `readOnlyHint: false`, `destructiveHint: false` |
| `destructive` | `destructiveHint: true`: it deletes or publishes. |

::warning
Annotations are only hints. A client may or may not ask the person before it runs a `destructive` tool, and ViteHub cannot make it ask. The real guard is section access and scopes, which the server checks on every call.
::

The tool input schema is the JSON Schema of the operation input. The Console editor transports (`documents.action`, `media.action`) are not tools. Any operation can opt out with `mcp: false`.

A call runs with `surface: "mcp"` and `context.user` set to the person. A failure is a normal result with `isError: true`, so the model can read it:

```txt
FIXTURE_R0001: The note is locked.
Fix: Unlock it first.
```

For failures below status 500, `structuredContent.error` has `code`, `message`, `fix`, and `details`. Server failures return `OPERATION_FAILED` with a generic message and no provider diagnostics. An unknown tool or message is a JSON-RPC error.

An operation with `invoke: true`, such as `workflow.start`, `queue.send`, or `schedule.run`, is a tool only when [`console.invoke`](/docs/development/console) is on. It is on in development and off in a production build.

## Tools by primitive

The agent reads the same data as the Console and the CLI. A `read` tool can return stored data: `kv_get` returns a value, `blob_get` the bytes, and `databases_browse` rows. Grant only the sections the agent needs. Use a `:read` grant, such as `'kv:read'`, for a role that must not write.

| Section | Read tools | Write and destructive tools |
| --- | --- | --- |
| `kv` | `kv_list`, `kv_get`, `kv_has` | `kv_set`, `kv_delete` |
| `blob` | `blob_list`, `blob_head`, `blob_get`, `blob_media`, `blob_variants` | `blob_put`, `blob_delete` |
| `databases` | `databases_tables`, `databases_browse` | none |
| `content` | `content_collections`, `content_list`, `content_resolve`, `content_show`, `content_status`, `content_diff`, `content_revisions`, `content_schedules`, `content_sitemap` | `content_save`, `content_restore`, `content_remove`, `content_publish`, `content_schedule`, `content_unschedule` |

Blob tools also accept a store grant. `'blob:media'` allows only the `media` store, and other stores fail with `CONSOLE_ACCESS_DENIED`. See [Grant one Blob store](/docs/development/console#grant-one-blob-store).

`content_save` needs `ifDigest`: the current draft digest from `content_show`, or explicit `null` for a new document. A missing digest fails without saving. A stale digest fails with a conflict.

[Operations](/docs/development/operations#built-in-operations) lists the other sections' operations. Their tools use the same naming rule.

## Package tools

A package can also register tools that are not operations. They use the same section grants and OAuth scopes. If one has the same name as an operation tool, the registered tool's schema and code win.

With [Comments](/docs/comments), you can ask an agent: "Read the open comments on /pricing and fix them."

### Comments, section `comments`

| Tool | Needs | Does |
| --- | --- | --- |
| `comments_list_threads` | `read` | Lists threads, newest activity first. Filters: `page`, `status` (default `open`), `search`, `limit` (default 25, at most 100). |
| `comments_get_thread` | `read` | Returns a thread's page, element, Vue components and source files, browser, build, and comments. |
| `comments_reply` | `comment` | Replies to an open thread. |
| `comments_resolve_thread` | `resolve` | Resolves a thread, or reopens it with `resolved: false`. |

Needs is the `authorize` action of [`defineComments()`](/docs/comments/configure#decide-who-can-comment). The tools need the installed `comments` Console section. A `comments:read` grant allows only listing and reading. Replies and resolutions need the full `comments` grant. OAuth tokens also need `vitehub:read` for reads or `vitehub:write` for writes. The checked Comments user is the author of replies and resolutions. An app with its own MCP server can use `commentsMcpTools(comments)` from `vite-hub/comments/runtime`.

## Sign-in

| Console access | MCP sign-in |
| --- | --- |
| `console: { auth: 'app' }` or a session Console Auth | OAuth 2.1. The client registers itself, opens the browser once, and sends a bearer token. |
| `console: { auth: { provider: 'cloudflare-access' } }` | The Cloudflare Access service token headers (`CF-Access-Client-Id` and `CF-Access-Client-Secret`) the Console already accepts. No OAuth flow, so the `401` has no `resource_metadata`. |
| `console: { auth: false }`, or `vite dev` with no `console` option | None. Development serves only loopback requests, as for the [RPC](/docs/development/console). |

A request without valid sign-in gets `401` and a `WWW-Authenticate: Bearer resource_metadata="…"` header. An invalid token gets `error="invalid_token"` in that header. The metadata, at `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/_vitehub/mcp`, names the authorization server.

To try the tools as yourself, open the Console's [MCP client](/docs/development/console#open-vitehub-mcp). It connects with your Console session.

### Set up OAuth

This section covers the Console endpoint. An app with its own MCP server, such as `/mcp`, signs clients in with [`mcpOAuth()`](/docs/auth/configure#sign-mcp-clients-in) from `vite-hub/auth/mcp`.

Better Auth is the authorization server. A Console Auth that ViteHub generates (inline GitHub, or `vitehub/console/auth/server.ts` with `defineConsoleAuth()`) already has the `jwt()` and `oauthProvider()` plugins. The Console sign-in page is also the login and consent page. A Console Auth with `migrate: false` manages its own schema, so it adds the plugins itself. ViteHub keeps a supplied OAuth provider and adds a registration hook that accepts MCP clients' loopback redirects, also with `migrate: false`.

A bearer token still runs the Console Auth `authorize` callback with the verified user, then `console.authorize`. With `console.auth: 'app'`, it also runs the `authorize` callback of each matching app Auth access route. There is no browser session, so these callbacks get an empty `session` object. Tokens work only on the exact mounted MCP endpoint. Other routes still need a session.

For `console: { auth: 'app' }`, add `consoleMcpOAuth()` to the Auth that signs people in. It returns `jwt()`, `oauthProvider()`, and the registration hook, built with ViteHub's Better Auth, so do not install a second `@better-auth/oauth-provider`. Give it the same resource as `console.mcp.resource`. It fixes the token issuer to that origin plus Better Auth's `/api/auth` base path, or to `issuer`. Tokens then name the configured resource and issuer, also for requests through another host, such as a preview URL.

```ts [server/auth.ts]
import { defineAuth } from 'vite-hub/auth'
import { authDatabase } from 'vite-hub/auth/database'
import { consoleMcpOAuth } from 'vite-hub/console/auth'

export default defineAuth(({ requestOrigin }) => ({
  baseURL: requestOrigin,
  database: authDatabase(),
  plugins: [
    ...consoleMcpOAuth({ resource: 'https://app.example.com/_vitehub/mcp' }),
  ],
}))
```

The plugins store keys, clients, and tokens in the `jwks` and `oauth*` tables. [`authDatabase()`](/docs/auth/configure#keep-users-in-the-app-database) adds them to the app Database with the other Better Auth tables, so `vitehub db generate` writes their migration.

Better Auth sends a signed-out person to `loginPage`, and a signed-in person to `consentPage` (default: `loginPage`). The default `loginPage` is the built-in `/_vitehub/sign-in` page next to the resource. It signs the person in with email and password, when `emailAndPassword` is on, or with the Auth's social providers. Then it shows the client name and asks the person to allow or deny it.

To use your own sign-in page, set `loginPage`, such as `'/sign-in'`. Apps with two-factor authentication must do this, because the built-in page cannot complete their challenge. The flow:

1. Better Auth sends the person to your page with a signed query: the parameters named by `ba_param`, plus `sig`.
2. Send those parameters back unchanged, in order, as `oauth_query` in the sign-in request body, such as `/api/auth/sign-in/email`. The response has the `url` of the next step.
3. The signed-in person comes back to the consent page. Show the client name from `/api/auth/oauth2/public-client?client_id=…`, and send `{ accept, oauth_query }` to `/api/auth/oauth2/consent`.
4. Go to the `url` in its response.

Better Auth's `oauthProviderClient()` adds `oauth_query` to client requests for you.

To configure the provider yourself, add `jwt()`, `consoleMcpNativeClients()`, and `oauthProvider()` with the options below. Use ViteHub's Better Auth version, or the plugin types do not fit `defineAuth()`.

`resources` declares the MCP resource. `clientRegistrationDefaultResources` links dynamically registered clients to it when their registration has no resource list. Include both in a supplied `oauthProvider()`, also with `migrate: false`. Without `resources`, Better Auth issues opaque tokens, not JWTs, and the Console cannot check them. If the Auth lacks `jwt()`, `oauthProvider()`, the resource in either list, or the two `vitehub:` scopes, the Console answers `503` with `CONSOLE_MCP_OAUTH_INCOMPLETE` and the fix on both metadata endpoints.

The server never takes the issuer or resource from the request's `Host` header, because the sender picks that header. They come from configuration, in this order:

1. `console.mcp.resource`, the absolute URL of the endpoint, such as `https://app.example.com/_vitehub/mcp`.
2. `vitehub({ publicUrl })`.
3. A `baseURL` the Auth sets itself. `baseURL: requestOrigin` follows the request, so it does not count.

`vite dev` uses the request origin, because the port changes. In production without any of these, OAuth is off: the metadata endpoints answer `503` with `CONSOLE_MCP_ORIGIN_REQUIRED`, and bearer tokens are refused.

The issuer is the Auth's `jwt.issuer` or `baseURL`. Set `console.mcp.issuer` when tokens carry another one. Configured issuer URLs lose their final slash. Set `jwt.issuer` to that URL without a trailing slash: Better Auth 1.7.7 normalizes discovery but keeps the option as-is in access-token claims, so the Console rejects a noncanonical Auth issuer with `CONSOLE_MCP_OAUTH_INCOMPLETE`. Resource identifiers stay exact, trailing slash included.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    auth: true,
    console: { auth: 'app', mcp: { resource: 'https://app.example.com/_vitehub/mcp' } },
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      auth: true,
      console: { auth: 'app', mcp: { resource: 'https://app.example.com/_vitehub/mcp' } },
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
      auth: true,
      console: { auth: 'app', mcp: { resource: 'https://app.example.com/_vitehub/mcp' } },
    }),
  ],
})
```
:::
::

The Console checks access tokens only on `/_vitehub/mcp`. The request path must be exactly the endpoint (`/portal/_vitehub/mcp` under a base path). A path that only contains it, such as `/_vitehub/rpc/_vitehub/mcp`, does not count. Other Console routes use the session.

The Console reads the signing keys from the Auth in the same process, without calling the authorization server. It checks the signature against those keys' algorithms, the issuer, the audience (the resource), and the expiry, with 30 seconds of tolerance. Then it loads the person by the `sub` claim, so a deleted or banned person loses access even with a valid token, and runs `console.authorize` with that user.

### Discovery at the origin root

MCP clients look for the authorization server at the origin root, not under the Better Auth base path. Better Auth serves the document only under its base path, so the Console adds `/.well-known/oauth-authorization-server` at the root, and `/.well-known/oauth-authorization-server/api/auth` for an issuer with a path. The document must publish the same issuer as `console.mcp.issuer` (or the issuer from the Auth). A mismatch returns `503` with `CONSOLE_MCP_OAUTH_INCOMPLETE`. Set Better Auth's `jwt.issuer` to match. A reverse proxy must forward `/.well-known/*` to the app.

## Limits

- A tool call has its operation's request limit: 64 KiB by default, raised by `maxRequestBytes`. A package-registered tool, such as a Comments tool, has 256 KiB. Other messages have 2 MiB. The server counts bytes as it reads the body, so a missing or wrong `content-length` changes nothing. Over the limit, the request gets `413` before any tool runs.
- A batch (a JSON array) gets `400`, because the supported revisions removed batches.
- On `2025-11-25`, arguments that do not match the input schema return a tool result with `isError: true`, so the Agent reads the error and retries. On `2025-06-18`, a registered tool answers JSON-RPC error `-32602`. An operation always answers with its own `isError` result, which names the fields to fix.
- An `id` is a string or a number, and a message with an `id` needs a `method`. Anything else, `null` too, is `-32600`.
- An unsupported `MCP-Protocol-Version` header gets `400`.
- There is no event stream, so `GET` answers `405`. A request with an `Origin` header of another origin gets `403`. MCP clients send none.
