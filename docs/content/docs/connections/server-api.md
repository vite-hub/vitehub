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
| `defineConnection`, `apiKey` from `vite-hub/connections` | Define a Connection or a [keyed Connection](/docs/connections/configure#keyed-connections), with an [OAuth provider object](/docs/connections/configure#oauth-provider-objects) or an API key. |
| `google` from `vite-hub/connections/google` | Google OAuth preset with typed Gmail methods for messages, attachments, drafts, labels, threads, history, the profile, and filters. `fetch()` reaches the other Gmail endpoints. |
| `useConnection`, `createConnectionsRuntime`, `getConnectionsRuntime`, `setConnectionsRuntime` from `vite-hub/connections/server` | Call a Connection from server code, and runtime access for hosts and tests. |
| `createConnectionsHandler` from `vite-hub/connections` | Management, connect, and callback routes. `connections.management` mounts them. It requires an `actor` access policy. |
| `hubConnections` from `@vite-hub/connections/vite` | Standalone Vite integration. |

The runtime methods that make a decision are `approve`, `deny`, `authorize`, `complete`, `revoke`, and `setKey`. Each one requires `actor`, such as `user:<id>`, and records it as the manager. There is no default actor. Pass the signed-in user of your app:

```ts fragment
const runtime = getConnectionsRuntime()
await runtime.approve({ actor: `user:${session.user.id}`, id })
```

A missing or empty `actor` fails with `CONNECTIONS_INVALID_ACTOR`. The management routes pass the actor that your `actor` policy returns.

## Management routes

The routes are `POST /_vitehub/connections`, `GET /_vitehub/connections/connect/:name`, and `GET /_vitehub/connections/callback`, after the Vite `base` if set.

These routes are an API of your app, not of the Console. The development server mounts them with the `'development'` actor. A production build mounts them only with `connections: { management: { actor: './server/connections-actor.ts' } }`, a module whose default export is the actor policy below. Each route checks it before it reads or changes a Connection, and names the manager in activity.

A rejected request returns `403` with `CONNECTIONS_FORBIDDEN`. `createConnectionsHandler()` returns a Fetchable route, `{ fetch(request) }`. Nitro mounts it as a route, and you can call `fetch()` with a Web `Request`. With `createConnectionsHandler()`, pass `actor`: a function that gets the `Request` and returns `user:<id>` for an authorized manager, `undefined` to reject the request with `CONNECTIONS_FORBIDDEN`, or a `Response` to reject it with that response. In a ViteHub app, the `Request` carries the [Standard Context](/docs/reference/runtime-context#standard-context) of the event, so `getStandardContext(request)` and the Auth helpers accept it. You can also pass `'development'`. `'development'` allows `user:local` only when `NODE_ENV` is `development`, and returns `500` with `CONNECTIONS_AUTH_REQUIRED` elsewhere.

With `createConnectionsHandler()`, pass `actor` as one of these:

- a function that returns `user:<id>` to allow a manager, `undefined` to reject with `CONNECTIONS_FORBIDDEN`, or a `Response` to reject with it
- `'development'`, which allows `user:local` only when `NODE_ENV` is `development` and the request comes from this machine. A request from another machine returns `403` with `CONNECTIONS_FORBIDDEN`, and another runtime returns `500` with `CONNECTIONS_AUTH_REQUIRED`

The provider redirects to the OAuth callback. It finishes the flow only for the browser that started it (the `state` cookie) and the same manager. The `state` works once and expires after 10 minutes. A `state` from another manager returns `403`.

Add `?return=/path` to the connect route to pick the page to return to, such as `/_vitehub/connections/connect/google?return=/settings`. Only a same-origin path is kept. The callback shows a result page in light or dark mode:

- A success returns to that page after two seconds and shows a **Back to Connections** link. Without `return`, it asks the user to close the tab.
- A failure shows the error code, the fix, a docs link, and the same link, and stays.

The action route takes only `POST`.

### Origin checks

The `POST` route accepts only `application/json` from the app origin. It compares the browser `Origin` header with the `vitehub({ publicUrl })` origin and the request URL origin. Another origin returns `403` with `CONNECTIONS_ORIGIN_REJECTED`. A request that is not JSON returns `403` with `CONNECTIONS_CONTENT_TYPE_REJECTED`.

Behind a proxy that ends TLS, the server can see `http://` while the browser sends `https://`. Set `vitehub({ publicUrl })` to the public origin. The connect route then builds the OAuth `redirectUri` from it and marks cookies `Secure` for `https://`. Without `publicUrl`, both routes use the request URL, so the server must trust `X-Forwarded-Proto` and `X-Forwarded-Host`.

## Calls

`useConnection(name, options)` returns a client:

| Method | Behavior |
| --- | --- |
| `call(operation, input)` | Runs a typed Operation: an `id`, an `effect` (`read` or `write`), and a `request(input)` builder. |
| `fetch(url, init)` | Sends a request with the access token. `GET` and `HEAD` are reads with the id `fetch.get` or `fetch.head`. Other methods are writes. |
| `status()` | Resolves the status, such as `'connected'`. It never rejects. If it cannot inspect the Connection, for example when the store cannot open, it returns `'disconnected'`. |

Each call checks access, gets a valid token, and sends the request. ViteHub refreshes the token 60 seconds before it expires. On a `401`, it refreshes and retries once. If the provider rejects the refresh token, the status becomes `needs-reconnect`.

| Option | Default | Description |
| --- | --- | --- |
| `event` | None | The request event. Its route is the actor, such as `GET /api/labels`. |
| `actor` | Route from `event`, else `{ id: 'server', kind: 'service' }` | Actor for access rules and activity. An `agent:` actor fails with `CONNECTIONS_INVALID_ACTOR`, because only the Agent runtime gives Agent actors, through Connection capabilities. |
| `dryRun` | `false` | Writes return `{ skipped: 'dry-run', operation }` without calling the provider. `fetch` returns `204` with the `x-vitehub-connection-skipped` header. |
| `audit` | `'changes'` | `'changes'` records writes, denials, skipped calls, and failures. `'all'` also records reads. |
| `signal` | None | Cancels token refresh, lease waits, and the request with its response body. |
| `trace` | None | `traceId`, `invocationId`, `runId`, and `tool`, to link activity to a trace. |

## Activity

Activity goes to the `vitehub_connection_activity` table. Each entry has the actor, action (`call`, `connect`, `refresh`, `disconnect`), Operation id, effect, outcome, provider status, duration, target host and path, and trace ids. It never holds bodies, headers, or tokens.

Agent tools record every call, reads too. MCP messages record successful, denied, and failed requests. `vitehub connections activity <name>` lists the activity of a Connection.

## CLI

The CLI calls the management route of a running dev server. `--url` defaults to `VITEHUB_CONNECTIONS_URL`, then the project's dev server, then `VITEHUB_DEV_SERVER_URL`, then `http://localhost:5173`. The commands do not load the project, so the dev server does not rebuild.

For an app that you name with `--url` or `VITEHUB_CONNECTIONS_URL`, pass a session cookie that your `actor` accepts with `--cookie` or `VITEHUB_CONNECTIONS_COOKIE`. The dev server that the CLI finds by itself gets no credentials.

| Command | Description |
| --- | --- |
| `vitehub connections list` | List Connections and their status. |
| `vitehub connections inspect <name>` | Show one Connection: account, scopes, and actions. |
| `vitehub connections connect <name>` | Grant access with the provider OAuth flow. For a loopback app, it waits for the browser on `127.0.0.1`. Otherwise it prints the connect URL. |
| `vitehub connections set-key <name>` | Store the key of an API key Connection from stdin. |
| `vitehub connections activity <name>` | Show audited calls, refreshes, and denials. |
| `vitehub connections approvals [approve\|deny <id>]` | List, approve, or deny pending writes. |
| `vitehub connections models <name>` | List the models of a ChatGPT plan Connection. |
| `vitehub connections export <name> --file <path>` | Move a ChatGPT grant to a protected file for another host. |
| `vitehub connections import <name> --file <path>` | Import a ChatGPT credential file. |
| `vitehub connections revoke <name> --confirm <name>` | Revoke the provider grant and delete the stored token. |
