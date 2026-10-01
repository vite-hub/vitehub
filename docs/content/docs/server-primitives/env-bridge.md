---
title: Env Bridge
description: Replace application credentials at runtime with scoped access and persistent activity.
navigation.order: 3
navigation.group: Application
icon: i-lucide-key-round
---

Env Bridge is an [Env provider](/docs/server-primitives/env#read-external-env-storage) that connects Server Env to a secret store, an access policy, and a durable activity log. Use it for credentials that administrators must replace while the application runs, for example an API token that rotates.

Each credential has its own grants. A user, Agent, or service gets only the permissions you grant for that key. Every read, replacement, and grant change is recorded. Host variables, including `process.env` and Worker bindings, stay read-only.

::tip
- **[Env](/docs/server-primitives/env)** declares values and reads them from the host or a read-only provider. Use it for most configuration.
- **Env Bridge** adds runtime replacement, per-key grants, and activity to one provider. Use it when a credential changes without a redeploy or when you must audit who used it.
- **[Connections](/docs/server-primitives/connections)** hold OAuth account tokens and store them through Env Bridge. Use them when the app calls a third-party API for a connected account.
::

## Quick start

::steps{level="3"}

### Install

```bash [Terminal]
pnpm add vite-hub drizzle-orm
```

The SQLite adapter needs `drizzle-orm`. Owner-package users install `@vite-hub/env` and import from `@vite-hub/env/<subpath>` instead of `vite-hub/env/<subpath>`.

### Configure

Create a factory that builds the bridge from your database, encryption key, and session reader. The factory keeps database, authentication, and host bootstrap configuration in application code.

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

Call the factory once per application runtime and export its `provider` as the default export of your provider module, here `server/env/credentials.ts`. For ViteHub Auth, pass a wrapper around the discovered instance's `auth.api.getSession({ headers })`. Keep `isAdmin` as your own policy: authentication alone does not grant administrator access.

Register the provider module and declare the key your application uses.

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'

export default defineConfig({
  plugins: [vitehub({
    preset: 'node',
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

### Start using it

An administrator stores the first value and grants `use` to the service principal. Run this from trusted server code, or use the Console.

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

Server code then reads the credential through Server Env.

```ts
import { loadServerEnv } from '#vitehub/env/server'

const env = await loadServerEnv()
const token = env.githubToken.unseal()
```

::

## Public imports

| Import | Use |
| --- | --- |
| `createEnvBridge` from `vite-hub/env/bridge` | Build a bridge from a secret store, an access store, and a runtime context. |
| `createDatabaseEnvStore` from `vite-hub/env/database` | Store encrypted values, grants, and activity in a SQLite Drizzle database. |
| `createEnvAuthenticator` from `vite-hub/env/auth` | Turn a management request into a trusted `EnvAccessContext` from a Better Auth session or a verified Agent session. |
| `createEnvBridgeHandler` from `vite-hub/env/http` | Handle management requests on a server route. The Console uses it through the generated Server Env module. |
| `importSealKey`, `seal`, `unseal`, `sealKeyId` from `@vite-hub/env/seal` | AES-GCM helpers in the database store format, for owner packages that store sealed values. |

Types such as `EnvAccessContext`, `EnvPermission`, `EnvGrant`, `EnvActivity`, `EnvSecretStore`, and `EnvAccessStore` come from `vite-hub/env/bridge`. Each `vite-hub/env/<subpath>` import is also available as `@vite-hub/env/<subpath>`.

## Bridge options

| Option | Type | Description |
| --- | --- | --- |
| `secrets` | `EnvSecretStore` | Reads, inspects, and conditionally replaces stored values. |
| `access` | `EnvAccessStore` | Stores grants and appends activity. |
| `runtimeContext` | `() => EnvAccessContext \| Promise<EnvAccessContext>` | Supplies attribution when `loadServerEnv()` has no explicit access context. Derive it from trusted invocation or request context. |
| `emit` | `(event: EnvActivity) => void \| Promise<void>` | Optional. Exports each event after it is persisted. See [Export persisted events to evlog](#export-persisted-events-to-evlog). |

`createDatabaseEnvStore()` returns `secrets` and `access`, so you can spread it into `createEnvBridge()`. It accepts these options:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `db` | `EnvDatabase` | Required | A SQLite Drizzle instance, including a compatible ViteHub Database. |
| `encryptionKey` | `Uint8Array` | Required | A 32-byte key. Other lengths fail with `ENV_BRIDGE_INVALID`. |
| `namespace` | `string` | `'default'` | Separates the credentials of several bridges in one database. |
| `previews` | `boolean` | `false` | Stores a masked preview for token-shaped values. |

The store also returns `revisionCondition(key, revision)`. It builds a SQL predicate that updates related records only while that secret revision is current. A `null` revision requires the secret to be absent.

## Providers

| Store | Activation | Notes |
| --- | --- | --- |
| `createDatabaseEnvStore()` (SQLite through Drizzle) | `next-resolution` | Uses AES-256-GCM with a new IV for each write. Authenticates the namespace, key, and revision. Creates its tables on first use. |
| Custom `EnvSecretStore` and `EnvAccessStore` | `next-resolution`, `restart`, or `deploy` | The store's `replace()` returns the activation that applies to it. |

Env Bridge runs where the Env provider runs. Keep the database and the encryption key persistent across restarts. Supply the key from your host secret store, separate from the database, and back it up.

## Replace a credential

Pass the revision from `bridge.inspect()` to replace an existing value. `expectedRevision: null` creates a missing value. A concurrent edit with a stale revision fails with `ENV_BRIDGE_CONFLICT`. Refresh the metadata before you try again.

With `activation: 'next-resolution'`, the next `loadServerEnv()` reads the replacement. Existing snapshots, in-flight operations, initialized SDK clients, and child processes keep the previous value. Resolve credentials at each operation boundary and recreate clients when needed. Replacing a stored key does not renew an OAuth subscription or change the environment of a running process.

## Limit inspection and use independently

Each grant targets one actor kind (`user`, `agent`, or `service`), one actor ID, and one store key. Permissions are independent:

| Permission | Allows |
| --- | --- |
| `inspect` | Read revision and update metadata. |
| `preview` | Read an optional masked preview. |
| `replace` | Replace the stored value conditionally. |
| `use` | Resolve the value at runtime, or run a trusted `bridge.use()` operation. |

- Only administrators manage grants and read activity. An administrator context without a `scope` passes every permission check.
- A verified Agent token can add a `scope`. The scope is a ceiling over the Agent's durable grants. A context with a `scope` never gets administrator access.
- Revocation applies to the next permission check. It cannot retract a secret that an operation already resolved.
- Never accept actor IDs, administrator flags, or token scopes from a request body.

In the Console, select **Manage credential** in the provider details. Preview access works independently. Replacement controls also require `inspect`, because the Console needs the revision for a conditional write. A provider's management authentication supplements the existing Console access protection.

## Distinguish retrieval from actual use

`loadServerEnv(undefined, { access: context })` attributes credential resolution to a trusted request or invocation context. Without an explicit context, the bridge uses `runtimeContext`.

| Action | Recorded when |
| --- | --- |
| `resolve` | `loadServerEnv()` reads the credential. |
| `use` | A `bridge.use()` callback runs, with an operation name and its success or failure. |
| `inspect`, `preview`, `replace` | A management call runs. |
| `grant`, `revoke` | An administrator changes a grant. |

A successful `use` means the callback completed. Make the callback reject unsuccessful provider responses. The bridge cannot observe downstream use of a value retrieved through an ordinary Env snapshot.

`bridge.use(context, key, operation, callback)` passes `{ revision }` as the second callback argument when the store supplies a revision. Use it with `revisionCondition()` to fence related writes.

Activity persists `started` before it reads or changes a credential, then `succeeded` or `failed`. It also records `denied` attempts. If the activity store is unavailable, the bridge denies the operation with `ENV_BRIDGE_AUDIT_FAILED`. A lone `started` entry means completion is unknown, for example after a crash. It does not prove that an external service received nothing.

Administrators read `bridge.activity(context, key, before?)`. Pages contain up to 100 events, newest first. Pass the last event's ID as `before` for the next page. Activity excludes values, previews, and callback error messages. Actor IDs, operation names, trace IDs, and invocation IDs must contain identifiers, not secret data.

## Export persisted events to evlog

Use `emit` to send events to your configured evlog drain. Env calls it after the event is persisted. An export failure does not remove the activity record or undo a completed operation. The hook does not retry exports.

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

Set `traceId` and `invocationId` in the trusted access context to correlate these records with your Agent run.

## Structured errors

Bridge operations throw `ViteHubError` with a fixed public message. Other failures are sanitized to `ENV_BRIDGE_OPERATION_FAILED`.

| Code | Cause |
| --- | --- |
| `ENV_BRIDGE_DENIED` | The context lacks the permission, or the scope excludes the key. |
| `ENV_BRIDGE_CONFLICT` | The `expectedRevision` is stale. |
| `ENV_BRIDGE_MISSING` | The credential is unavailable. |
| `ENV_BRIDGE_INVALID` | The request, actor, grant, or store option is invalid. |
| `ENV_BRIDGE_AUDIT_FAILED` | Activity could not be persisted. |
| `ENV_BRIDGE_OPERATION_FAILED` | Any other failure, including a store or callback error. |

## Limits

- Previews are off unless the store enables them. The SQLite adapter stores the first four and last four characters only for token-shaped values longer than 12 characters. Short and structured secrets have no preview. Treat previews as sensitive metadata when you decide who gets `preview` access and who can read the database.
- Activity pages hold at most 100 events.
- A stored value must be non-empty and at most 32,768 bytes. Other values fail with `ENV_BRIDGE_INVALID`.
- Host administration and database backup security remain application responsibilities.
- After a self-hosted restart, confirm that the next resolution sees a replacement and that the activity page still contains the previous run's events.

## Connect Env Bridge to Agents

Agents get credential access through their own identity. They never inherit their owner's administrator access.

### Authenticate Agent Auth sessions

Add [`@better-auth/agent-auth`](https://www.better-auth.com/docs/plugins/agent-auth) to your Better Auth configuration. Its `auth.api.getAgentSession({ headers })` verifies the Agent credential and returns capability grants intersected with the token's capabilities. Env does not install or configure the plugin.

Pass that verified session reader to `createEnvAuthenticator`. You map capabilities and their constraints to exact store keys. This example supports one fixed capability and rejects constrained grants until the application implements those constraints:

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

- The Agent still needs a durable `use` grant for `github/token`.
- A request with an `Authorization` bearer header is treated as an Agent request. An invalid Agent credential never falls back to the owner's browser cookie.
- A failure in session verification, policy, or scope mapping denies access.

### Run brokered operations

For brokered use, register a capability in the plugin's `onExecute` handler. The handler receives an already verified `agentSession`. Derive the context from that session and reuse your scope mapping. Do not call `getAgentSession` again on the same credential, because Agent Auth checks replay protection.

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

Keep the callback in trusted server code and return only the tool's intended result. Never return the raw credential to an Agent. Validate capability inputs and constraints before you call external services. The Agent Auth plugin is still evolving: pin and test its version in your application.

## Next steps

- Declare provider-backed values with [Env](/docs/server-primitives/env#read-external-env-storage).
- Call third-party APIs for connected accounts with [Connections](/docs/server-primitives/connections).
- Protect management with [Auth](/docs/server-primitives/auth) and the [Console](/docs/development/console#protect-the-console-route).
