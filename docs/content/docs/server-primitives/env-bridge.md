---
title: Env Bridge
description: Replace application credentials at runtime with scoped access and persistent activity.
navigation.order: 3
navigation.group: Application
icon: i-lucide-key-round
---

Env Bridge connects an Env provider to a secret store, access policy, and durable activity log. Use it for credentials that must change while your application is running. Host variables, including `process.env` and Worker bindings, remain read-only through Console.

One provider is enough to start. Add another when credentials belong to a different store or access policy. Existing read-only providers continue to work without a bridge.

## Create a persistent provider

The SQLite adapter stores encrypted values, exact-key grants, and activity in the same database. It accepts a SQLite Drizzle instance, including a compatible ViteHub Database. Install `drizzle-orm` when using this adapter. Supply a persistent 32-byte encryption key from your host secret store; keep it separate from the database and retain it across restarts.

This factory keeps the database, authentication, and host bootstrap configuration in application code. Pass your existing Better Auth session reader and administrator policy when calling it.

```ts [server/env/create-credentials.ts]
import { createEnvAuthenticator } from 'vite-hub/env/auth'
import { createEnvBridge } from 'vite-hub/env/bridge'
import { createDatabaseEnvStore } from 'vite-hub/env/database'
import type { EnvHumanSession } from 'vite-hub/env/auth'
import type { EnvDatabase } from 'vite-hub/env/database'

export function createCredentials(options: {
  db: EnvDatabase
  encryptionKey: Uint8Array
  getSession(input: { headers: Headers }): Promise<EnvHumanSession | null>
  isAdmin(session: EnvHumanSession): boolean | Promise<boolean>
}) {
  const store = createDatabaseEnvStore({
    db: options.db,
    encryptionKey: options.encryptionKey,
    namespace: 'application',
    previews: true,
  })
  const bridge = createEnvBridge({
    ...store,
    runtimeContext: () => ({ actor: { kind: 'service', id: 'application' } }),
  })
  const authenticate = createEnvAuthenticator({
    getSession: options.getSession,
    isAdmin: options.isAdmin,
  })
  return {
    bridge,
    provider: {
      read: bridge.read,
      management: { bridge, authenticate },
    },
  }
}
```

Export `provider` as the default from your configured provider module. Call the factory once per application runtime. For ViteHub Auth, wrap the discovered instance's `auth.api.getSession({ headers })`; keep `isAdmin` as your own policy. Authentication alone does not grant administrator access. A provider's management authentication supplements existing Console access protection.

Declare the provider and the key your application uses:

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'

export default defineConfig({
  plugins: [vitehub({
    console: true,
    env: { providers: { credentials: './server/env/credentials.ts' } },
  })],
  env: {
    server: {
      githubToken: env({
        secret: true,
        source: env.provider('credentials', 'github/token'),
      }),
    },
  },
})
```

The configured service principal needs a `use` grant before `loadServerEnv()` can read this key. An authenticated administrator can initialize the value and grant access through trusted server code:

```ts
// owner is an EnvAccessContext returned by your server authentication policy.
await bridge.replace(owner, {
  key: 'github/token',
  value: newToken,
  expectedRevision: null,
})
await bridge.grant(owner, {
  actor: { kind: 'service', id: 'application' },
  key: 'github/token',
  permissions: ['use'],
})
```

`expectedRevision: null` creates a missing value. To replace an existing value, pass the revision returned by `bridge.inspect()`. Concurrent edits with a stale revision fail with `ENV_BRIDGE_CONFLICT`; refresh the metadata before trying again.

The database adapter reports `activation: 'next-resolution'`. The next `loadServerEnv()` reads the replacement. Existing snapshots, in-flight operations, initialized SDK clients, and child processes retain their previous value. Resolve credentials at each operation boundary and recreate clients when needed. Replacing a stored key does not renew an OAuth subscription or change a running process's environment.

## Limit inspection and use independently

Each grant targets one actor kind, actor ID, and store key. Permissions are independent:

| Permission | Allows |
| --- | --- |
| `inspect` | Revision and update metadata. |
| `preview` | An optional masked preview. |
| `replace` | Conditional replacement of the stored value. |
| `use` | Runtime resolution or a trusted `bridge.use()` operation. |

Administrators manage grants and read activity. An agent's token scope is an additional ceiling over its durable grants. Revocation takes effect on the next permission check; it cannot retract a secret already resolved by an operation.

Previews are disabled unless the store enables them. The SQLite adapter stores four leading and four trailing characters only for token-shaped values longer than 12 characters. Short and structured secrets have no preview. Treat previews as sensitive metadata when deciding who receives `preview` access and who can inspect the database.

## Connect the official Agent Auth plugin

Add [`@better-auth/agent-auth`](https://www.better-auth.com/docs/plugins/agent-auth) to your editable Better Auth configuration. Its `auth.api.getAgentSession({ headers })` verifies the agent credential and returns capability grants intersected with the token's capabilities. Env does not install or configure the plugin for you.

Pass that verified session reader to `createEnvAuthenticator`. You must map capabilities and their constraints to exact store keys. This example supports one fixed capability and rejects constrained grants until the application implements those constraints:

```ts
import { createEnvAuthenticator } from 'vite-hub/env/auth'
import type { AgentSession } from '@better-auth/agent-auth'
import type { EnvAgentScope } from 'vite-hub/env/auth'

function agentScope(session: AgentSession): EnvAgentScope {
  const allowed = session.agent.capabilityGrants.some(grant =>
    grant.capability === 'github-review'
    && grant.status === 'active'
    && grant.constraints === null,
  )
  return allowed ? [{ key: 'github/token', permissions: ['use'] }] : []
}

const authenticate = createEnvAuthenticator({
  getSession: ({ headers }) => auth.api.getSession({ headers }),
  isAdmin: session => session.user.id === ownerUserId,
  agents: {
    getSession: ({ headers }) => auth.api.getAgentSession({ headers }),
    scope: agentScope,
  },
})
```

The agent still needs a durable `use` grant for `github/token`. Invalid agent credentials never fall back to an owner's browser cookie. Agents keep their own identity and cannot inherit their owner's administrator access. Session verification, policy, or scope-mapping failures deny access.

For brokered use, register a capability in the official plugin's `onExecute` handler. It receives an already verified `agentSession`; derive the context from that session and reuse your scope mapping. Do not call `getAgentSession` again on the same credential, because Agent Auth checks replay protection.

```ts
// Inside the plugin's onExecute handler for the fixed github-review capability:
const context = {
  actor: { kind: 'agent' as const, id: agentSession.agent.id },
  scope: agentScope(agentSession),
}
const result = await bridge.use(context, 'github/token', 'github.review', async secret => {
  const response = await fetch('https://api.github.com/user', {
    headers: { authorization: `Bearer ${secret.unseal()}` },
  })
  if (!response.ok) throw new Error('GitHub request failed')
  const user = await response.json()
  return { login: user.login }
})
```

Keep the callback in trusted server code and return only the tool's intended result. Never return the raw credential to an agent. Validate capability inputs and constraints before calling external services. The official plugin is still evolving; pin and test its version in your application.

## Distinguish retrieval from actual use

`loadServerEnv(undefined, { access: context })` attributes credential resolution to a trusted request or invocation context. Without an explicit context, the bridge uses `runtimeContext`. Never accept actor IDs, administrator flags, or token scopes directly from a request body.

Resolution records `resolve`. A `bridge.use()` callback records `use` with an operation name and its success or failure. A successful `use` means the callback completed; make the callback reject unsuccessful provider responses. The bridge cannot observe downstream use of a value retrieved through an ordinary Env snapshot.

Activity persists `started` before reading or changing a credential, then `succeeded` or `failed`. It also records denied attempts. If the audit store is unavailable, the bridge denies the operation. A lone `started` entry means completion is unknown, for example after a crash; it does not prove that an external service received nothing.

Administrators read `bridge.activity(context, key)`. Pages contain up to 100 newest-first events; pass the last event's ID as `before` for the next page. Values, previews, and callback error messages are excluded from activity. Actor IDs, operation names, trace IDs, and invocation IDs should contain identifiers rather than secret data.

## Export persisted events to evlog

Use `emit` to send events to your configured evlog drain. Env calls it after durable persistence. Export failure does not remove the activity record or undo a completed operation; the hook itself does not provide durable export retries.

```ts
import { createLogger } from 'evlog'

const bridge = createEnvBridge({
  ...store,
  runtimeContext: () => trustedInvocationContext(),
  emit(event) {
    createLogger({ event: 'env.activity', env: event }).emit()
  },
})
```

Set `traceId` and `invocationId` in the trusted access context to correlate these records with your agent run. Keep the database and encryption key persistent when restarting a self-hosted deployment; confirm that the next resolution sees a replacement and the activity page still contains the previous run's events.
