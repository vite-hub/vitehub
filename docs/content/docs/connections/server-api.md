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
| `defineConnection`, `apiKey`, `oauthLogin` from `vite-hub/connections` | Define a Connection or a [keyed Connection](/docs/connections/configure#keyed-connections), and use an API key provider or an [OAuth login provider](/docs/connections/configure#oauth-login-connections). |
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

A rejected request returns `403` with `CONNECTIONS_FORBIDDEN`. With the Console, the route returns the Console access rejection instead. For example, a Console Auth session without a user id returns `403` with `CONSOLE_MANAGER_REQUIRED`. See [Console error codes](/docs/development/console#console-error-codes). `createConnectionsHandler()` returns a handler that takes a Web `Request` or a request event with [Standard Context](/docs/reference/runtime-context#standard-context) properties, such as an H3 1 or H3 2 event in a ViteHub app. With `createConnectionsHandler()`, pass `actor`: a function that gets the request and the request event and returns `user:<id>` for an authorized manager, `undefined` to reject the request with `CONNECTIONS_FORBIDDEN`, or a `Response` to reject it with that response. You can also pass `'development'`. `'development'` allows `user:local` only when `NODE_ENV` is `development`, and returns `500` with `CONNECTIONS_AUTH_REQUIRED` elsewhere.

The OAuth callback is reached by a redirect from the provider. It completes the flow only for the browser that started it (the `state` cookie) and for the same manager. The `state` works one time only and expires after 10 minutes. A `state` from another manager returns `403`.

Add `?return=/path` to the connect route to name the page to return to, for example `/_vitehub/connections/connect/google?return=/settings`. Only a same-origin path is kept. The callback shows a result page in light or dark mode. After a success, it returns to that page after two seconds and shows a **Back to Connections** link. A failure shows the error code, the fix, a docs link, and the same link, and it does not return by itself. Without `return`, a success asks the user to close the tab.

The action route takes only `POST`, so a `GET` of `/_vitehub/connections` reaches the Console Connections page.

### Origin checks

The `POST` action route accepts only `application/json` requests from the app origin. It compares the browser `Origin` header with the public origin from `vitehub({ publicUrl })` and with the origin of the request URL that the server sees. A different origin returns `403` with `CONNECTIONS_ORIGIN_REJECTED`. A request without a JSON content type returns `403` with `CONNECTIONS_CONTENT_TYPE_REJECTED`.

Behind a TLS-terminating proxy, the server can see `http://` while the browser sends an `https://` origin. Set `vitehub({ publicUrl })` to the public origin. The connect route then builds the OAuth `redirectUri` from that origin and marks its cookies `Secure` for `https://`. Without `publicUrl`, both routes use the request URL, so the server must trust `X-Forwarded-Proto` and `X-Forwarded-Host`.

## Calls

`useConnection(name, options)` returns a client:

| Method | Behavior |
| --- | --- |
| `call(operation, input)` | Runs a typed Operation. An Operation has an `id`, an `effect` (`read` or `write`), and a `request(input)` builder. |
| `fetch(url, init)` | Sends a request with the access token. `GET` and `HEAD` are reads with the id `fetch.get` or `fetch.head`. Other methods are writes. |
| `status()` | Resolves the Connection status, for example `'connected'`. It never rejects: a Connection that cannot be inspected, for example because the store cannot open, is `'disconnected'`. |

Each call checks access, gets a valid access token, and sends the request. ViteHub refreshes the token 60 seconds before it expires. When the provider returns `401`, ViteHub refreshes once and retries once. When the provider rejects the refresh token, the status changes to `needs-reconnect`.

Options:

| Option | Default | Description |
| --- | --- | --- |
| `event` | None | The request event. The route becomes the actor, for example `GET /api/labels`. |
| `actor` | Route from `event`, else `{ id: 'server', kind: 'service' }` | The actor for access rules and activity. An `agent:` actor fails with `CONNECTIONS_INVALID_ACTOR`: Agent actors come only from the ViteHub Agent runtime, through the Connection capabilities of the Agent. |
| `dryRun` | `false` | Write Operations return `{ skipped: 'dry-run', operation }` and do not call the provider. `fetch` returns `204` with the `x-vitehub-connection-skipped` header. |
| `audit` | `'changes'` | `'changes'` records writes, denials, skipped calls, and failures. `'all'` also records reads. |
| `signal` | None | Cancels token refresh, refresh-lease waits, and the Operation request, including its response body. |
| `trace` | None | `traceId`, `invocationId`, `runId`, and `tool` to link activity to a trace. |

## Activity

ViteHub stores activity in the `vitehub_connection_activity` table. Each entry has the actor, action (`call`, `connect`, `refresh`, `disconnect`), Operation id, effect, outcome, provider status, duration, target host and path, and trace ids. Activity never contains request bodies, response bodies, headers, or tokens.

Agent tools record every call, reads included. MCP protocol messages record successful, denied, and failed requests. The Console shows activity for each Connection.

## CLI

The CLI calls the management route of a running development server with the Console enabled. `--url` defaults to `VITEHUB_CONNECTIONS_URL`, then the dev server that runs in the current project, then `VITEHUB_DEV_SERVER_URL`, then `http://localhost:5173`. The commands do not load the project, so they do not make a running dev server rebuild.

| Command | Description |
| --- | --- |
| `vitehub connections list` | List Connections and their status. |
| `vitehub connections inspect <name>` | Show one Connection: account, scopes, and actions. |
| `vitehub connections connect <name>` | Grant access with the provider OAuth flow. For a loopback app, the CLI waits for the browser on `127.0.0.1`. For another app, it prints the Console connect URL. |
| `vitehub connections set-key <name>` | Store the key of an API key Connection from stdin. |
| `vitehub connections activity <name>` | Show audited calls, refreshes, and denials. |
| `vitehub connections approvals [approve\|deny <id>]` | List, approve, or deny writes that wait for approval. |
| `vitehub connections models <name>` | List the models of a ChatGPT plan Connection. |
| `vitehub connections export <name> --file <path>` | Move a ChatGPT grant into a protected file for another host. |
| `vitehub connections import <name> --file <path>` | Import a ChatGPT credential file. |
| `vitehub connections revoke <name> --confirm <name>` | Revoke the provider grant and delete the stored token. |
