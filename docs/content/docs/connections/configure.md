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

An origin is `https://host` or `https://host:port`. ViteHub compares origins exactly, so list each host. `http` is accepted only for loopback hosts such as `localhost` and `127.0.0.1`.

ViteHub has no generic OAuth 2 provider yet. For another service, use `apiKey()` when the service issues API keys or personal access tokens. An API key Connection does not refresh its key.

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
