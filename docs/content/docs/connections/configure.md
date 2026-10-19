---
title: Connections configuration
description: Configure provider origins, API key Connections, access rules, and Connections options.
navigation.title: Configure
navigation.order: 3
icon: i-lucide-sliders-horizontal
---

## Provider origins

Each provider declares the API origins that may receive its credential. `call` and `fetch` fail with `CONNECTION_INVALID` for any other origin, and ViteHub does not send the credential.

| Provider | Import | Origins that receive the credential |
| --- | --- | --- |
| `google()` | `vite-hub/connections/google` | The root URL origins of its API catalogs, for example `https://gmail.googleapis.com`. |
| `apiKey()` | `vite-hub/connections` | Its `origins` and the root URL origins of its `apis` catalogs. |
| `oauthLogin()` | `vite-hub/connections` | Its `mcp` endpoint, its `origins`, and the root URL origins of its `apis` catalogs. |

An origin is `https://host` or `https://host:port`. ViteHub compares origins exactly, so list each host. `http` is accepted only for loopback hosts such as `localhost` and `127.0.0.1`.

ViteHub has no generic OAuth 2 provider function yet. For another service, declare an [OAuth provider object](#oauth-provider-objects), use [`oauthLogin()`](#oauth-login-connections) when a service account must sign in without a person, or use `apiKey()` when the service issues API keys or personal access tokens. An API key Connection does not refresh its key.

## OAuth provider objects

A provider object declares the endpoints of an OAuth 2.0 authorization code flow with PKCE:

```ts [server/connections/crm.ts]
export default defineConnection({
  provider: {
    id: 'crm',
    authorizationEndpoint: 'https://auth.crm.example.com/authorize',
    tokenEndpoint: 'https://auth.crm.example.com/token',
    clientId: 'crm-client-id',
    identityScopes: ['openid', 'email'],
  },
  scopes: ['offline_access'],
})
```

| Option | Default | Description |
| --- | --- | --- |
| `account` | The ID token claims when `identityScopes` includes `openid` | Reads the account from the token response. |
| `apis` | `{}` | Typed API catalogs. Their root URLs receive the token. Without catalogs, `call` and `fetch` send the token nowhere. |
| `identityScopes` | None | Scopes added to each authorization request so the provider identifies the account. |

Without `account`, a provider that requests `openid` reads the account from the ID token in the token response: `sub` becomes the account id and a string `email` labels it. ViteHub does not check the token signature, because the ID token comes directly from the token endpoint over TLS, as OpenID Connect allows for the authorization code flow. A missing or malformed ID token gives no account. A reconnect without an account, or with a different account, puts the Connection in `reauth_required`.

## API key Connections

`apiKey()` defines a Connection whose credential is a static key. An admin sets the key at runtime, so it is not in code:

```ts [server/connections/executor.ts]
import { apiKey, defineConnection } from 'vite-hub/connections'

export default defineConnection({
  provider: apiKey({ id: 'executor', origins: ['https://executor.sh'] }),
})
```

`verify` checks a new key before ViteHub stores it. Return `false` to reject the key, or `{ account }` to label the Connection:

```ts [server/connections/crm.ts]
export default defineConnection({
  provider: apiKey({
    id: 'crm',
    origins: ['https://api.crm.example.com'],
    verify: async (key, { fetch, signal }) => {
      const response = await fetch('https://api.crm.example.com/me', { headers: { authorization: `Bearer ${key}` }, signal })
      return response.ok
    },
  }),
})
```

| Option | Default | Description |
| --- | --- | --- |
| `origins` | Required | Origins that `fetch` may send the key to. Use `https`, or `http` for a loopback host. |
| `header` | `authorization` | Request header that carries the key. |
| `scheme` | `Bearer` for `authorization`, none for other headers | Text before the key. Set `''` to send the bare key. |
| `apis` | `{}` | Typed API catalogs. Their root URLs also receive the key. |
| `mcp` | None | The provider's [MCP endpoint](#mcp-endpoint). It also receives the key. |
| `requests` | None | Pacing, retries, and a timeout for provider requests. See [Request policy](#request-policy). |
| `verify` | None | Checks a new key before ViteHub stores it. It receives the runtime `fetch` and a 30-second abort signal. |
| `fallback` | None | Returns the key to use until an admin sets one, for example from Server Env. See [Fallback key](#fallback-key). |
| `id` | `'api-key'` | Provider id in the Console and inspection. |

Set the key in the Console with **Set key**, or pipe it to the CLI:

```bash [Terminal]
printf %s "$EXECUTOR_API_KEY" | vitehub connections set-key executor
```

The CLI reads the key only from stdin, so it does not stay in the shell history. The CLI and the Console send the key only over HTTPS or to a loopback host.

ViteHub seals the key like an OAuth grant. Access rules, approvals, dry run, and activity work as for OAuth Connections. An API key has no scopes and no refresh: a `401` response does not change the status. When a redirect leaves the first origin, ViteHub removes the key header. Revoking the Connection deletes the stored key; revoke the key at the provider too.

## OAuth login Connections

`oauthLogin()` from `vite-hub/connections` is an OAuth 2.0 provider that connects without a person, for a service account. Use it when a service accepts only its own OAuth tokens, for example an MCP server behind its own authorization server. The app supplies only `login`, which signs in and approves the request like a browser:

```ts [server/connections/portal.ts]
import { defineConnection, oauthLogin } from 'vite-hub/connections'

export default defineConnection({
  provider: oauthLogin({
    id: 'portal',
    mcp: 'https://portal.example.com/mcp',
    clientName: 'Support Agent',
    credentials: () => useServerEnv().portal.login,
    async login({ url, redirectUri, credentials, fetch }) {
      const [email, password] = credentials.split(':')
      await fetch('/api/sign-in', { method: 'POST', body: JSON.stringify({ email, password }) })
      return (await fetch(url)).headers.get('location')!
    },
  }),
  scopes: ['openid', 'email'],
  access: { 'agent:support': { read: true, write: ['fetch'], approve: false } },
})
```

ViteHub reads the protected resource metadata of `mcp` (RFC 9728) to find the authorization server, then its metadata (RFC 8414, or OpenID Connect discovery). It registers a public client (RFC 7591) once per process, builds the authorization URL with PKCE, `state`, `scope`, and `resource`, calls `login`, checks the returned `code` and `state`, and exchanges the code. A token that expires within a minute is refreshed with its refresh token or replaced by a new sign-in. A `401` signs in again once and retries the request. Concurrent requests share one sign-in, also when it fails.

| Option | Default | Description |
| --- | --- | --- |
| `login` | Required | Receives `{ url, redirectUri, credentials, fetch, signal }` and returns the URL that the provider redirects to `redirectUri`. `fetch` keeps cookies per host, sends `origin`, resolves relative URLs against `url`, and does not follow redirects unless `init.redirect` asks for it. `signal` aborts after 60 seconds. |
| `mcp` | None | The provider's MCP endpoint. Discovery starts here, and it receives the token. `mcp` or `issuer` is required. |
| `issuer` | From the `mcp` resource metadata | The authorization server issuer. |
| `resource` | `mcp` | The `resource` of authorization and token requests (RFC 8707). |
| `credentials` | None | The secret that `login` gets, for example from Server Env. A sealed secret is unsealed. While it resolves to nothing, the Connection is `disconnected`. |
| `clientId` | Registered | A registered public client id. Without it, the authorization server must support registration. |
| `clientName` | `'ViteHub'` | `client_name` for client registration. |
| `redirectUri` | `http://127.0.0.1/callback` | The redirect URI of the client. ViteHub never listens on it. |
| `authorizationParams` | None | Extra authorization request parameters. |
| `origins`, `apis` | None | Other origins and typed API catalogs that receive the token. |
| `account` | The ID token claims when `scopes` includes `openid` | Reads the account from the token response. |
| `requests` | None | The [request policy](#request-policy). |

Tokens and the client registration stay in memory, so each process signs in again, and requests work without the Connections store. While `credentials` resolves to a value, the Connection is `connected`; a failed sign-in fails only the request that needed it. An error that `login` throws becomes `CONNECTION_PROVIDER` without its message, because the message could contain the credentials. The Connection has no connect flow and no key: the Console connect route, `authorize()`, and `setKey()` reject it, and a revoke drops the tokens, so the next request signs in again.

## Keyed Connections

A keyed definition defines one Connection per instance, for example one per tenant. Each instance is a Connection named `<name>:<instance>`:

```ts [server/connections/portal.ts]
export default defineConnection({
  instances: ['acme', 'globex'],
  definition: tenant => ({
    provider: oauthLogin({ mcp: `https://${tenant}.example.com/mcp`, credentials: () => useServerEnv().portal[tenant], login }),
    scopes: ['openid'],
  }),
})
```

This file defines `portal:acme` and `portal:globex`. Use the full name everywhere, for example `useConnection('portal:acme')` or `mcp({ servers: { portal_acme: { connection: 'portal:acme' } } })`. The CLI and the Console list each instance. The bare name `portal` fails with an error that lists the instances. An instance key has 1 to 128 letters, digits, `.`, `_`, or `-`, and keys must be unique. `definition(instance)` runs once per process, when the instance is first used.

## MCP endpoint

A provider can declare its MCP endpoint with `mcp`. `apiKey({ mcp })` and OAuth providers accept it. The endpoint origin also receives the credential, and `inspect()` reports it. The URL must use `https`, or `http` for a loopback host, and must not have credentials, a query, or a fragment.

```ts [server/connections/crm.ts]
export default defineConnection({
  provider: apiKey({ id: 'crm', origins: ['https://api.crm.example.com'], mcp: 'https://mcp.crm.example.com/mcp' }),
})
```

An Agent connects with `mcp({ servers: { crm: { connection: 'crm' } } })`, without a transport URL. Server code calls one tool with `callMcpTool({ connection: 'crm' }, 'search', { query })` from `vite-hub/agent/mcp`. See [MCP](/docs/agents/capabilities/mcp#authenticate-through-a-connection).

## Request policy

`requests` on an OAuth provider, in `oauthLogin()`, or in `apiKey()` sets how ViteHub sends provider requests. It applies to `fetch` and to API method calls, but not to the provider's [MCP endpoint](#mcp-endpoint), whose sessions are long-lived streams. Without it, ViteHub sends each request once, with no pacing and no timeout.

```ts [server/connections/airtable.ts]
export default defineConnection({
  provider: apiKey({
    id: 'airtable',
    origins: ['https://api.airtable.com'],
    requests: {
      bucket: 'airtable-base',
      rate: { limit: 5, perMs: 1000 },
      retry: { attempts: 4, methods: ['GET'], on429: { minDelayMs: 30_000 } },
      timeoutMs: 15_000,
    },
### Fallback key

`fallback` gives a key from Server Env until an admin sets one. A sealed Server Env secret is unsealed:

```ts [server/connections/github.ts]
import { useServerEnv } from '#vitehub/env/server'

export default defineConnection({
  provider: apiKey({
    id: 'github',
    origins: ['https://api.github.com'],
    fallback: () => useServerEnv().github.token,
  }),
})
```

| Option | Default | Description |
| --- | --- | --- |
| `bucket` | The Connection name | Connections with the same bucket share one request schedule and one 429 pause. |
| `rate` | None | `{ intervalMs }` or `{ limit, perMs }`. ViteHub spaces request starts evenly: `{ limit: 5, perMs: 1000 }` starts one request every 200 ms. |
| `retry.attempts` | `3` | Attempts in total, including the first. Omit `retry` to send each request once. |
| `retry.methods` | `['GET', 'HEAD', 'OPTIONS']` | Methods that ViteHub retries after a network error or a `5xx` response. Other methods can have reached the provider, so they are sent once. |
| `retry.delayMs` | `250` | First backoff after a network error or a `5xx` response. It doubles for each attempt. |
| `retry.on429.minDelayMs` | `0` | Shortest pause after a `429`. |
| `timeoutMs` | None | Aborts each attempt after this time, also while you read the body. |

A `429` response pauses every request in the bucket until its `Retry-After` time (seconds or an HTTP date), and ViteHub then retries it for every method. The last attempt returns its response as is. When your own `signal` aborts, the request stops at once and ViteHub does not retry it.

The schedule and the pause are in memory. Each server process or isolate has its own. They do not coordinate several replicas.
The fallback applies only when no key was ever set for the Connection, or when the Connections store cannot open, for example without `VITEHUB_CONNECTIONS_KEY`. A key set in the Console or with `set-key` always wins. A revoke also wins: a revoked Connection stays disconnected. The fallback key must pass the same format check as a stored key. Requests with it use the same access rules and approvals, and ViteHub records them as activity while the store is open. An approval requested with the fallback key does not run after an admin sets a key. Inspection reports `keySource: 'fallback'` or `'stored'` for a connected API key Connection.

## Access rules

`access` has rules for `server`, `routes` (by route id such as `POST /api/sync`), and `agents` (by Agent id). A route without its own rule uses `server`. Each rule has `read`, `write`, and `approve` settings. When an `access` map is present, actors without a matching rule are denied. Without the map, reads and ordinary server writes are allowed, while high-risk writes and fetches are denied.

An Agent discovered under `server/agents/` that has no rule of its own uses the rule of the nearest Agent it [extends](/docs/agents/agent-definitions#extend-an-agent). With `agent:bot` in the map, `bot-dev` from `defineAgent({ extends: bot })` uses the `agent:bot` rule, and a grandchild uses the first rule up its chain. A rule that names the child always wins, also when it grants less. An Agent that is not discovered, such as an inline `defineAgent({ extends })` that `runAgent()` runs, gets only the rules that name it. Server, route, and schedule actors never inherit a rule. An approval replays with the rules that applied when the Agent requested it.

ViteHub checks the actor rule before the operation. A write list can contain exact Operation ids or `*` patterns; high-risk writes require an explicit matching pattern.

| Decision | Result |
| --- | --- |
| `allow` | The call runs. |
| `require-approval` | Server code fails with `CONNECTIONS_APPROVAL_REQUIRED`. An Agent tool asks for tool approval. When a user approves it in a provider Agent session, the call runs. `deny` rules still apply. |
| `deny` | The call fails with `CONNECTIONS_DENIED`. |

## Configuration options

| Option | Default | Description |
| --- | --- | --- |
| `activityRetention` | `{ maxAgeMs: 1209600000, maxRecords: 10000 }` | How long the database keeps activity. See [Activity retention](#activity-retention). |
| `database` | `'default'` | Database that stores grants and activity. |
| `encryptionKey` | `env({ secret: true, optional: true, source: env.source('VITEHUB_CONNECTIONS_KEY') })` | Secret Env declaration for the key. It cannot use `env.provider()` or a default. |
| `projectRoot` | Vite root | Where ViteHub discovers `server/connections/`. |

`vitehub({ connections })` enables `database` when it is unset. Without a Database Definition, Connections use the empty Default Database. `database: false` fails with `VITE_HUB_R0124`. The Nuxt module does not support Connections yet.

## Activity retention

Connections write one activity event per provider request. By default the database keeps 14 days and at most 10,000 events. Change the limits, or set `false` to keep all activity:

```ts [vite.config.ts]
vitehub({
  database: true,
  connections: { activityRetention: { maxAgeMs: 30 * 24 * 60 * 60 * 1000, maxRecords: 50_000 } },
})
```

Each limit is a positive integer. A missing limit uses its default. ViteHub prunes after each event, so the limits hold across multiple server processes. A failed prune logs a warning and does not fail the request. Pruning deletes only Connections activity; other Env activity stays.
