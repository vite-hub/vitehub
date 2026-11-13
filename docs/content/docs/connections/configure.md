---
title: Connections configuration
description: Configure provider origins, API key Connections, access rules, and Connections options.
navigation.title: Configure
navigation.order: 3
icon: i-lucide-sliders-horizontal
---

## Provider origins

Each provider lists the API origins that may get its credential. For any other origin, `call` and `fetch` fail with `CONNECTIONS_ORIGIN_NOT_ALLOWED` and send no credential.

| Provider | Import | Origins that receive the credential |
| --- | --- | --- |
| `google()` | `vite-hub/connections/google` | Root URL origins of its API catalogs, such as `https://gmail.googleapis.com`. |
| `apiKey()` | `vite-hub/connections` | Its `origins` and the root URL origins of its `apis`. |

An origin is `https://host` or `https://host:port`. Origins must match exactly, so list each host. `http` works only for loopback hosts such as `localhost` and `127.0.0.1`.

ViteHub has no generic OAuth 2 provider function yet. For another service, use an [OAuth provider object](#oauth-provider-objects), or `apiKey()` for API keys and personal access tokens. `apiKey()` never refreshes the key.

## OAuth provider objects

A provider object lists the endpoints of an OAuth 2.0 authorization code flow with PKCE:

```ts [server/connections/crm.ts]
import { defineConnection } from 'vite-hub/connections'

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
| `apis` | `{}` | Typed API catalogs. Their root URLs get the token. Without them, `call` and `fetch` send the token nowhere. |
| `identityScopes` | None | Scopes added to each authorization request, so the provider names the account. |

Without `account`, a provider that requests `openid` reads the account from the ID token: `sub` is the id, and a string `email` labels it. ViteHub skips the signature check, because the token comes straight from the token endpoint over TLS, as OpenID Connect allows for this flow. A missing or bad ID token gives no account. A reconnect with no account or a different account sets the Connection to `reauth_required`.

## API key Connections

`apiKey()` defines a Connection with a static key. An admin sets the key at runtime, so it is not in code:

```ts [server/connections/executor.ts]
import { apiKey, defineConnection } from 'vite-hub/connections'

export default defineConnection({
  provider: apiKey({ id: 'executor', origins: ['https://executor.sh'] }),
})
```

`verify` checks a new key before ViteHub stores it. Return `false` to reject it, or `{ account }` to label the Connection:

```ts [server/connections/crm.ts]
import { apiKey, defineConnection } from 'vite-hub/connections'

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
| `origins` | Required | Origins that `fetch` may send the key to. `https`, or `http` for a loopback host. |
| `header` | `authorization` | Request header that carries the key. |
| `scheme` | `Bearer` for `authorization`, none for other headers | Text before the key. `''` sends the bare key. |
| `apis` | `{}` | Typed API catalogs. Their root URLs also get the key. |
| `mcp` | None | The provider's [MCP endpoint](#mcp-endpoint). It also gets the key. |
| `requests` | None | Pacing, retries, and a timeout for provider requests. See [Request policy](#request-policy). |
| `verify` | None | Checks a new key before it is stored. Gets the runtime `fetch` and a 30-second abort signal. |
| `fallback` | None | Key to use until an admin sets one, for example from Server Env. See [Fallback key](#fallback-key). |
| `id` | `'api-key'` | Provider id in inspection. |

Pipe the key to the CLI:

```bash [Terminal]
printf %s "$EXECUTOR_API_KEY" | vitehub connections set-key executor
```

The CLI reads the key only from stdin, so it stays out of shell history. It sends the key only over HTTPS or to a loopback host.

ViteHub encrypts the key like an OAuth grant. Access rules, approvals, dry run, and activity work as for OAuth. A key has no scopes or refresh, so a `401` keeps the status. A redirect to another origin drops the key header. A revoke deletes the stored key. Revoke it at the provider too.

### Fallback key

`fallback` gives a key from Server Env until an admin sets one. A sealed secret is unsealed. Declare the GitHub token in your host configuration:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
import { env } from 'vite-hub/env'

export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    host: 'node',
    connections: true,
    env: {
      server: {
        github: {
          token: env({ secret: true, source: env.source('GITHUB_TOKEN') }),
        },
      },
    },
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vitehub({
    host: 'node',
    connections: true,
    env: {
      server: {
        github: {
          token: env({ secret: true, source: env.source('GITHUB_TOKEN') }),
        },
      },
    },
  }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vitehub({
    host: 'node',
    connections: true,
    env: {
      server: {
        github: {
          token: env({ secret: true, source: env.source('GITHUB_TOKEN') }),
        },
      },
    },
  })],
})
```
:::
::

```ts [server/connections/github.ts]
import { useServerEnv } from 'vite-hub/env'
import { apiKey, defineConnection } from 'vite-hub/connections'

export default defineConnection({
  provider: apiKey({
    id: 'github',
    origins: ['https://api.github.com'],
    fallback: () => useServerEnv().github.token,
  }),
})
```

The fallback applies only when no key was ever set, or the Connections store cannot open, for example without `VITEHUB_CONNECTIONS_KEY`. A key from `set-key` always wins, and so does a revoke. The fallback key gets the same format check, access rules, and approvals as a stored key, and is recorded as activity while the store is open. An approval requested with it does not run after an admin sets a key. Inspection reports `keySource: 'fallback'` or `'stored'` for a connected API key Connection.

## Keyed Connections

A keyed definition makes one Connection per instance, such as one per tenant, named `<name>:<instance>`:

```ts [server/connections/portal.ts]
import { defineConnection } from 'vite-hub/connections'

export default defineConnection({
  instances: ['acme', 'globex'],
  definition: tenant => ({
    provider: {
      id: 'portal',
      authorizationEndpoint: `https://${tenant}.example.com/oauth/authorize`,
      tokenEndpoint: `https://${tenant}.example.com/oauth/token`,
      clientId: 'portal-client-id',
      mcp: `https://${tenant}.example.com/mcp`,
    },
    scopes: ['openid', 'offline_access'],
  }),
})
```

This file defines `portal:acme` and `portal:globex`. Always use the full name, such as `useConnection('portal:acme')` or `mcp({ servers: { portal_acme: { connection: 'portal:acme' } } })`. The CLI lists each instance. The bare name `portal` fails and lists them. An instance key is 1 to 128 letters, digits, `.`, `_`, or `-`, and must be unique. `definition(instance)` runs once per process, on first use.

## Setup docs

A Connection often needs a person to do something first: create an app at the provider, choose the right account, or approve a scope. Write those steps next to the definition, in a Markdown file with the same name:

```md [server/connections/crm.md]
Connect the **support@** account, not your own.

1. In CRM, open **Settings → API** and turn on API access.
2. Click **Connect** and approve `offline_access`.
```

`vitehub connections inspect crm` prints it after the actions, and `inspect()` returns it as `docs`, so an Agent can read it too. A `.connection.ts` file uses a `.connection.md` file next to it.

The `docs` option of a definition replaces the file. Use it when the steps depend on the instance of a [keyed Connection](#keyed-connections), which share the file otherwise:

```ts [server/connections/crm.ts]
import { defineConnection } from 'vite-hub/connections'

export default defineConnection({
  instances: ['acme', 'globex'],
  definition: tenant => ({
    provider: {
      id: 'crm',
      authorizationEndpoint: `https://${tenant}.crm.example.com/authorize`,
      tokenEndpoint: `https://${tenant}.crm.example.com/token`,
      clientId: `${tenant}-client-id`,
    },
    scopes: ['offline_access'],
    docs: `Sign in to https://${tenant}.crm.example.com as the tenant's automation user.`,
  }),
})
```

The Markdown is part of your app. ViteHub does not read it from users or providers.

## MCP endpoint

`apiKey({ mcp })` and OAuth providers can declare an MCP endpoint with `mcp`. Its origin also gets the credential, and `inspect()` reports it. The URL must use `https`, or `http` for a loopback host, with no credentials, query, or fragment.

```ts [server/connections/crm.ts]
import { apiKey, defineConnection } from 'vite-hub/connections'

export default defineConnection({
  provider: apiKey({ id: 'crm', origins: ['https://api.crm.example.com'], mcp: 'https://mcp.crm.example.com/mcp' }),
})
```

An Agent connects with `mcp({ servers: { crm: { connection: 'crm' } } })`, without a transport URL. Server code calls one tool with `const [error, result] = await callMcpTool({ connection: 'crm' }, 'search', { query })` from `vite-hub/agent/mcp`. It returns a `Result`, `[error, undefined]` or `[undefined, value]`, instead of rejecting. See [MCP](/docs/agents/capabilities/mcp#authenticate-through-a-connection).

## Request policy

`requests` on an OAuth provider or `apiKey()` sets pacing, retries, and timeouts for `fetch` and API methods. It skips the [MCP endpoint](#mcp-endpoint), whose sessions are long streams. Without it, each request is sent once, with no pacing and no timeout.

```ts [server/connections/airtable.ts]
import { apiKey, defineConnection } from 'vite-hub/connections'

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
  }),
})
```

| Option | Default | Description |
| --- | --- | --- |
| `bucket` | The Connection name | Connections in one bucket share a request schedule and a 429 pause. |
| `rate` | None | `{ intervalMs }` or `{ limit, perMs }`. Starts are spaced evenly: `{ limit: 5, perMs: 1000 }` starts one request every 200 ms. |
| `retry.attempts` | `3` | Total attempts, with the first. Omit `retry` to send each request once. |
| `retry.methods` | `['GET', 'HEAD', 'OPTIONS']` | Methods retried after a network error or a `5xx`. Other methods may have reached the provider, so they are sent once. |
| `retry.delayMs` | `250` | First wait after a network error or a `5xx`. It doubles each attempt. |
| `retry.on429.minDelayMs` | `0` | Shortest pause after a `429`. |
| `timeoutMs` | None | Aborts each attempt after this time, also while you read the body. |

A `429` pauses the bucket until its `Retry-After` time (seconds or an HTTP date), then retries for any method. The last attempt returns its response as is. If your `signal` aborts, the request stops with no retry.

The schedule and the pause live in memory, per server process or isolate. Replicas do not share them.

## Access rules

`access` has rules for `server`, `routes` (by route id, such as `POST /api/sync`), and `agents` (by Agent id). A route without its own rule uses `server`. Each rule has `read`, `write`, and `approve`. With an `access` map, an actor with no rule is denied. Without a map, reads and normal server writes pass, but high-risk writes and fetches are denied.

An Agent in `server/agents/` with no rule uses the rule of the nearest Agent it [extends](/docs/agents/agent-presets#extend-an-agent). With `agent:bot` in the map, `bot-dev` from `defineAgent({ extends: bot })` uses the `agent:bot` rule, and a grandchild uses the first rule up its chain. A rule that names the child wins, even when it grants less. An inline Agent, such as `defineAgent({ extends })` run by `runAgent()`, gets only rules that name it. Server, route, and schedule actors never inherit. An approval replays with the rules from when the Agent asked.

ViteHub checks the rule before the operation. A write list holds exact Operation ids or `*` patterns. High-risk writes need an explicit matching pattern.

An actor that only uses the [MCP endpoint](#mcp-endpoint) can use the `'mcp'` preset instead of a rule:

```ts [server/connections/docs.ts] fragment
access: {
  'agent:support': 'mcp',
},
```

The preset allows every method on the `mcp` endpoint without approval, because MCP sends each message as a POST and cannot wait for approval. It denies every other request, including typed API methods. The provider must declare `mcp`.

| Decision | Result |
| --- | --- |
| `allow` | The call runs. |
| `require-approval` | Server code fails with `CONNECTIONS_APPROVAL_REQUIRED`. An Agent tool asks for approval, and the call runs when a user approves it in a provider Agent session. `deny` rules still apply. |
| `deny` | The call fails with `CONNECTIONS_DENIED`. |

## Configuration options

| Option | Default | Description |
| --- | --- | --- |
| `activityRetention` | `{ maxAgeMs: 1209600000, maxRecords: 10000 }` | How long activity is kept. See [Activity retention](#activity-retention). |
| `database` | `'default'` | Database for grants and activity. An app with only named Databases picks one, such as `'users'`. |
| `encryptionKey` | `env({ secret: true, optional: true, source: env.source('VITEHUB_CONNECTIONS_KEY') })` | Secret Env declaration for the key. No `env.provider()` and no default. |
| `projectRoot` | Vite root | Where ViteHub discovers `server/connections/`. |

`vitehub({ connections })` and `vite-hub/nuxt` turn on `database` when unset. Without a Database Definition, Connections use an empty `default` Database, and `vitehub inspect` says why. `database: false` fails with `VITE_HUB_R0124`. The Nuxt module also builds Connections for production, including Cloudflare Workers. Production mounts the management API only with `management: { actor }`, the access policy of your app.

## Activity retention

Connections write one activity event per provider request. By default the database keeps 14 days and at most 10,000 events. Change the limits, or set `false` to keep everything:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    database: true,
    connections: { activityRetention: { maxAgeMs: 30 * 24 * 60 * 60 * 1000, maxRecords: 50_000 } },
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
      database: true,
      connections: { activityRetention: { maxAgeMs: 30 * 24 * 60 * 60 * 1000, maxRecords: 50_000 } },
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
      database: true,
      connections: { activityRetention: { maxAgeMs: 30 * 24 * 60 * 60 * 1000, maxRecords: 50_000 } },
    }),
  ],
})
```
:::
::

Limits are positive integers; a missing one uses its default. ViteHub prunes after each event, so limits hold across processes. A failed prune logs a warning and does not fail the request. It deletes only Connections activity, not other Env activity.
