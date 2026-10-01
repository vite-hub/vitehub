---
title: Connections
description: Connect provider accounts with OAuth 2, call their APIs with access rules, and record how routes and Agents use them.
navigation.order: 4
navigation.group: Application
icon: i-lucide-plug
---

Use Connections when server code or an Agent calls a provider API as one account that the app owns, for example one Gmail inbox.

A Connection Definition in code declares the provider, the OAuth scopes, and the access rules. The [Console](/docs/development/console) connects, reconnects, refreshes, and disconnects the account at runtime. ViteHub stores the grant sealed in the app database, refreshes the access token, checks access before each call, and records activity.

Use [Env](/docs/server-primitives/env) for static API keys. Connections do not replace Auth: they do not sign in users.

## Quick start

::steps{level="3"}

### Configure

Connections need [Database](/docs/server-primitives/database) and a 32-byte encryption key.

```ts [vite.config.ts]
import { vitehub } from 'vite-hub'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vitehub({ preset: 'node', console: true, database: true, connections: true })],
})
```

```bash [Terminal]
# 32 random bytes, base64url
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Set the result as the secret `VITEHUB_CONNECTIONS_KEY` on the host. If the key changes, every Connection must be connected again.

### Define a Connection

The file name is the Connection name. `google()` adds the `openid` and `email` scopes to show the connected account. Register an OAuth client at the provider with the redirect URI `<origin>/_vitehub/connections/<name>/callback`.

```ts [server/connections/google.ts]
import { useServerEnv } from '#vitehub/env/server'
import { defineConnection } from 'vite-hub/connections'
import { google } from 'vite-hub/connections/google'

export default defineConnection({
  provider: google({
    // Server Env with { clientId: string, clientSecret: secret string }
    client: ({ event }) => useServerEnv(event).google,
    scopes: ['https://www.googleapis.com/auth/gmail.modify'],
  }),
  access: {
    server: { allow: ['gmail.*'] },
    agents: {
      labeller: { allow: ['gmail.messages.*', 'gmail.labels.list'], approve: ['gmail.drafts.create'] },
    },
  },
})
```

### Connect the account

Open the Console, select **Connections**, and select **Connect**. You can also print a single-use connect URL from the CLI while the development server runs:

```bash [Terminal]
vitehub connections connect google
```

### Call the provider

```ts [server/api/labels.get.ts]
import { useConnection } from 'vite-hub/connections'
import { gmail } from 'vite-hub/connections/google'

export default defineEventHandler(async (event) => {
  const connection = useConnection('google', { event })
  return await gmail(connection).labels.list()
})
```

::

## Public imports

| Import | Use |
| --- | --- |
| `defineConnection`, `oauth2`, `useConnection` from `vite-hub/connections` | Define a Connection, use a generic OAuth 2 provider, and call a Connection from server code. |
| `google`, `gmail`, `gmailOperations` from `vite-hub/connections/google` | Google OAuth preset and typed Gmail REST Operations. |
| `createConnectionsRuntime`, `useConnectionsRuntime` from `vite-hub/connections/server` | Runtime access for hosts and tests. |
| `createConnectionsHandler` from `vite-hub/connections/http` | Management, connect, and callback routes. The Console mounts them. |
| `hubConnections` from `@vite-hub/connections/vite` | Standalone Vite integration. |

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
| `actor` | Route from `event`, else `{ id: 'server', kind: 'service' }` | The actor for access rules and activity. |
| `dryRun` | `false` | Write Operations return `{ skipped: 'dry-run', operation }` and do not call the provider. `fetch` returns `204` with the `x-vitehub-connection-skipped` header. |
| `audit` | `'changes'` | `'changes'` records writes, denials, skipped calls, and failures. `'all'` also records reads. |
| `trace` | None | `traceId`, `invocationId`, `runId`, and `tool` to link activity to a trace. |

## Provider origins

Each provider declares the API origins that may receive its credential. `call` and `fetch` fail with `CONNECTIONS_ORIGIN_NOT_ALLOWED` for any other origin, and ViteHub records the attempt as denied. `google()` allows `https://*.googleapis.com`. Set `origins` for `oauth2()`:

```ts [server/connections/crm.ts]
import { defineConnection, oauth2 } from 'vite-hub/connections'

export default defineConnection({
  provider: oauth2({
    authorizationUrl: 'https://crm.example.com/oauth/authorize',
    client: ({ event }) => useServerEnv(event).crm,
    id: 'crm',
    origins: ['https://api.crm.example.com'],
    scopes: ['contacts.read'],
    tokenUrl: 'https://crm.example.com/oauth/token',
  }),
})
```

An origin is `https://host`, `https://host:port`, or `https://*.host` for subdomains. `http` is accepted only for loopback hosts such as `localhost` and `127.0.0.1`. The `userInfoUrl` of `oauth2()` receives the access token, so its origin must be in `origins` too.

## Access rules

`access` has rules for `server`, `routes` (by route id such as `POST /api/sync`), and `agents` (by Agent id). A route without its own rule uses `server`. Each rule has `allow`, `approve`, and `deny` lists of Operation id patterns. `*` matches any characters.

ViteHub checks `deny` first, then `approve`, then `allow`. When no pattern matches, reads are allowed and writes are denied.

| Decision | Result |
| --- | --- |
| `allow` | The call runs. |
| `require-approval` | The call fails with `CONNECTIONS_APPROVAL_REQUIRED`. Agent tools report it to the model. |
| `deny` | The call fails with `CONNECTIONS_DENIED`. |

## Activity

ViteHub stores activity in the `vitehub_connection_activity` table. Each entry has the actor, action (`call`, `connect`, `refresh`, `disconnect`), Operation id, effect, outcome, provider status, duration, target host and path, and trace ids. Activity never contains request bodies, response bodies, headers, or tokens.

Agent tools record every call, reads included. The Console shows activity for each Connection.

## Storage and security

- Grants are sealed with AES-GCM and the encryption key. Each row stores the key id. With a different key, the status is `needs-reconnect`.
- The connect flow uses PKCE (`S256`), a single-use ticket that expires after 10 minutes, and a `state` cookie. Tokens never go to the browser or the CLI.
- Connect, callback, and management routes exist only when the Console is enabled. Console Auth protects them in production.
- Concurrent refreshes use a database lease, so only one request refreshes a rotating refresh token.

## Configuration options

| Option | Default | Description |
| --- | --- | --- |
| `database` | `'default'` | Database that stores grants and activity. |
| `encryptionKey` | `env({ secret: true, optional: true, source: env.source('VITEHUB_CONNECTIONS_KEY') })` | Secret Env declaration for the key. It cannot use `env.provider()` or a default. |
| `projectRoot` | Vite root | Where ViteHub discovers `server/connections/`. |

`vitehub({ connections })` requires `database`. The Nuxt module does not support Connections yet.

## CLI

The CLI calls the management route of a running development server with the Console enabled. `--url` defaults to `VITEHUB_DEV_SERVER_URL`, then `http://localhost:5173`.

| Command | Description |
| --- | --- |
| `vitehub connections list` | List Connections and their status. |
| `vitehub connections status <name>` | Show one Connection. |
| `vitehub connections activity [name]` | Show recent activity. |
| `vitehub connections connect <name>` | Print a single-use connect URL. |
| `vitehub connections refresh <name>` | Refresh the access token now. |
| `vitehub connections disconnect <name>` | Revoke the grant at the provider and delete it. If revocation fails, ViteHub still deletes the local grant and records the error in the `disconnect` activity. Revoke the app at the provider then. |

## Errors

| Code | Cause |
| --- | --- |
| `CONNECTIONS_NOT_CONFIGURED` | The database or the encryption key is missing. |
| `CONNECTIONS_INVALID` | The management or connect request is not valid, or the ticket or `state` does not match. |
| `CONNECTIONS_NOT_FOUND` | No Connection Definition has this name. |
| `CONNECTIONS_MISSING` | The Connection is not connected. |
| `CONNECTIONS_NEEDS_RECONNECT` | The provider rejected the refresh token. |
| `CONNECTIONS_KEY_MISMATCH` | The grant was sealed with a different key. |
| `CONNECTIONS_DENIED`, `CONNECTIONS_APPROVAL_REQUIRED` | Access rules blocked the call. |
| `CONNECTIONS_ORIGIN_NOT_ALLOWED` | The request URL is not in the provider `origins`. ViteHub did not send the credential. |
| `CONNECTIONS_PROVIDER_FAILED` | The provider returned an error. `details.status` has the HTTP status. |
| `CONNECTIONS_UNAVAILABLE` | Another request holds the refresh lease. Try again. |

When you change the provider of a Connection, the stored grant belongs to the old provider. The status becomes `needs-reconnect` with `lastError: 'CONNECTIONS_PROVIDER_CHANGED'`, and ViteHub never sends that grant to the new provider. Reconnect the Connection.
