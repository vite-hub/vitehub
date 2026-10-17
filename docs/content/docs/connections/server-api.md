---
title: Connections server API
description: Call a Connection from server code, read its activity, and manage Connections from the CLI.
navigation.title: Server API
navigation.order: 4
icon: i-lucide-code-2
---

## Public imports

| Import | Use |
| --- | --- |
| `defineConnection`, `apiKey` from `vite-hub/connections` | Define a Connection and use an API key provider. |
| `google` from `vite-hub/connections/google` | Google OAuth preset with typed Gmail methods. |
| `useConnection`, `createConnectionsRuntime`, `getConnectionsRuntime`, `setConnectionsRuntime` from `vite-hub/connections/server` | Call a Connection from server code, and runtime access for hosts and tests. |
| `createConnectionsHandler` from `vite-hub/connections/http` | Management, connect, and callback routes. The Console mounts them. It requires an `actor` access policy. |
| `hubConnections` from `@vite-hub/connections/vite` | Standalone Vite integration. |

## Management routes

The management routes are `POST /_vitehub/connections`, `GET /_vitehub/connections/connect/:name`, and `GET /_vitehub/connections/callback`. With a Vite `base`, they start with that base.

Each route checks access itself before it reads or changes a Connection. With the Console, it runs the same access policy as the Console data routes, then names the manager for activity:

| Console access | Check | Manager |
| --- | --- | --- |
| `auth: { ... }` (Console Auth) | The Console Auth session and its `authorize` callback. | The signed-in user. |
| `auth: 'app'` | The app Auth session and the access routes that protect the Console. | The signed-in user. |
| `auth: { provider: 'cloudflare-access' }` | The Cloudflare Access token. | `user:cloudflare-access` |
| `auth: false` | No sign-in. | `user:open` |

`console.authorize` runs after each of these checks. When it returns `{ sections }`, the routes also need the `connections` section.

A rejected request returns `403` with `CONNECTION_FORBIDDEN`. With the Console, the route returns the Console access rejection instead. For example, a Console Auth session without a user id returns `403` with `CONSOLE_MANAGER_REQUIRED`. See [Console error codes](/docs/development/console#console-error-codes). With `createConnectionsHandler()`, pass `actor`: a function that returns `user:<id>` for an authorized manager, `undefined` to reject the request with `CONNECTION_FORBIDDEN`, or a `Response` to reject it with that response. You can also pass `'development'`. `'development'` allows `user:local` only when `NODE_ENV` is `development`, and returns `500` with `CONNECTION_AUTH_REQUIRED` elsewhere.

The OAuth callback is reached by a redirect from the provider. It completes the flow only for the browser that started it (the `state` cookie) and for the same manager. The `state` works one time only and expires after 10 minutes. A `state` from another manager returns `403`.

### Origin checks

The `POST` action route accepts only `application/json` requests from the app origin. It compares the browser `Origin` header with the origin of the request URL that the server sees. A different origin returns `403` with `CONNECTION_ORIGIN_REJECTED`, and `details` has `expectedOrigin` and `receivedOrigin`. A request without a JSON content type returns `403` with `CONNECTION_CONTENT_TYPE_REJECTED`.

Behind a TLS-terminating proxy, the server can see `http://` while the browser sends an `https://` origin. Make the server see the public origin: trust `X-Forwarded-Proto` and `X-Forwarded-Host`, or configure the public URL. The connect route builds the OAuth `redirectUri` from the same request URL, so this also fixes an `http://` callback URL.

## Calls

`useConnection(name, options)` returns a client:

| Method | Behavior |
| --- | --- |
| `call(operation, input)` | Runs a typed Operation. An Operation has an `id`, an `effect` (`read` or `write`), and a `request(input)` builder. |
| `fetch(url, init)` | Sends a request with the access token. `GET` and `HEAD` are reads with the id `fetch.get` or `fetch.head`. Other methods are writes. |
| `status()` | Returns the Connection summary without tokens. |

Each call checks access, gets a valid access token, and sends the request. ViteHub refreshes the token 60 seconds before it expires. When the provider returns `401`, ViteHub refreshes once and retries once. When the provider rejects the refresh token, the status changes to `needs-reconnect`.

Options:

| Option | Default | Description |
| --- | --- | --- |
| `event` | None | The request event. The route becomes the actor, for example `GET /api/labels`. |
| `actor` | Route from `event`, else `{ id: 'server', kind: 'service' }` | The actor for access rules and activity. An `agent:` actor fails with `CONNECTION_INVALID`: Agent actors come only from the ViteHub Agent runtime, through the Connection capabilities of the Agent. |
| `dryRun` | `false` | Write Operations return `{ skipped: 'dry-run', operation }` and do not call the provider. `fetch` returns `204` with the `x-vitehub-connection-skipped` header. |
| `audit` | `'changes'` | `'changes'` records writes, denials, skipped calls, and failures. `'all'` also records reads. |
| `signal` | None | Cancels token refresh, refresh-lease waits, and the Operation request, including its response body. |
| `trace` | None | `traceId`, `invocationId`, `runId`, and `tool` to link activity to a trace. |

## Activity

ViteHub stores activity in the `vitehub_connection_activity` table. Each entry has the actor, action (`call`, `connect`, `refresh`, `disconnect`), Operation id, effect, outcome, provider status, duration, target host and path, and trace ids. Activity never contains request bodies, response bodies, headers, or tokens.

Agent tools record every call, reads included. MCP protocol messages record successful, denied, and failed requests. The Console shows activity for each Connection.

## CLI

The CLI calls the management route of a running development server with the Console enabled. `--url` defaults to `VITEHUB_DEV_SERVER_URL`, then `http://localhost:5173`.

| Command | Description |
| --- | --- |
| `vitehub connections list` | List Connections and their status. |
| `vitehub connections status <name>` | Show one Connection. |
| `vitehub connections activity [name]` | Show recent activity. |
| `vitehub connections connect <name>` | Print a single-use connect URL. |
| `vitehub connections set-key <name>` | Store the key of an API key Connection from stdin. |
| `vitehub connections refresh <name>` | Refresh the access token now. |
| `vitehub connections disconnect <name>` | Revoke the grant at the provider and delete it. If revocation fails, ViteHub still deletes the local grant and records the error in the `disconnect` activity. Revoke the app at the provider then. |
