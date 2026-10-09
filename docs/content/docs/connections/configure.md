---
title: Connections configuration
description: Configure provider origins, API key Connections, access rules, and Connections options.
navigation.title: Configure
navigation.order: 3
icon: i-lucide-sliders-horizontal
---

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
    tokenUrl: 'https://crm.example.com/oauth/token',
  }),
  scopes: ['contacts.read'],
})
```

An origin is `https://host`, `https://host:port`, or `https://*.host` for subdomains. `http` is accepted only for loopback hosts such as `localhost` and `127.0.0.1`. The `userInfoUrl` of `oauth2()` receives the access token, so its origin must be in `origins` too.

## API key Connections

`apiKey()` defines a Connection whose credential is a static key. An admin sets the key at runtime, so it is not in code or Server Env:

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
| `verify` | None | Checks a new key before ViteHub stores it. It receives the runtime `fetch` and a 30-second abort signal. |
| `id` | `'api-key'` | Provider id in the Console and inspection. |

Set the key in the Console with **Set key**, or pipe it to the CLI:

```bash [Terminal]
printf %s "$EXECUTOR_API_KEY" | vitehub connections set-key executor
```

The CLI reads the key only from stdin, so it does not stay in the shell history. The CLI and the Console send the key only over HTTPS or to a loopback host.

ViteHub seals the key like an OAuth grant. Access rules, approvals, dry run, and activity work as for OAuth Connections. An API key has no scopes and no refresh: a `401` response does not change the status. When a redirect leaves the first origin, ViteHub removes the key header. Revoking the Connection deletes the stored key; revoke the key at the provider too.

## Access rules

`access` has rules for `server`, `routes` (by route id such as `POST /api/sync`), and `agents` (by Agent id). A route without its own rule uses `server`. Each rule has `read`, `write`, and `approve` settings. When an `access` map is present, actors without a matching rule are denied. Without the map, reads and ordinary server writes are allowed, while high-risk writes and fetches are denied.

ViteHub checks the actor rule before the operation. A write list can contain exact Operation ids or `*` patterns; high-risk writes require an explicit matching pattern.

| Decision | Result |
| --- | --- |
| `allow` | The call runs. |
| `require-approval` | Server code fails with `CONNECTIONS_APPROVAL_REQUIRED`. An Agent tool asks for tool approval. When a user approves it in a provider Agent session, the call runs. `deny` rules still apply. |
| `deny` | The call fails with `CONNECTIONS_DENIED`. |

## Configuration options

| Option | Default | Description |
| --- | --- | --- |
| `database` | `'default'` | Database that stores grants and activity. |
| `encryptionKey` | `env({ secret: true, optional: true, source: env.source('VITEHUB_CONNECTIONS_KEY') })` | Secret Env declaration for the key. It cannot use `env.provider()` or a default. |
| `projectRoot` | Vite root | Where ViteHub discovers `server/connections/`. |

`vitehub({ connections })` requires `database`. The Nuxt module does not support Connections yet.
