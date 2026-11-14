---
title: Env Bridge
navigation.title: Env Bridge
description: Replace application credentials at runtime with scoped access and persistent activity.
navigation.order: 8
icon: i-lucide-key-round
---

Env Bridge is an [Env provider](/docs/env/server-api#read-external-env-storage) that adds a secret store, access rules, and a stored activity log to Server Env. Use it for credentials that an admin must replace while the app runs, such as an API token that rotates.

A user, Agent, or service gets only the permissions you grant for each key. Env Bridge records every read, replacement, and grant change. Host variables, such as `process.env` and Worker bindings, stay read-only.

::tip
- **[Env](/docs/env)** reads values from the host or a read-only provider. Use it for most configuration.
- **Env Bridge** adds runtime replacement, per-key grants, and activity to one provider. Use it to change a credential without a redeploy, or to audit its use.
- **[Connections](/docs/connections)** store OAuth account tokens through Env Bridge. Use them to call a third-party API for a connected account.
::

## Quick start

::steps{level="3"}

### Install

```bash [Terminal]
pnpm add vite-hub drizzle-orm
```

The SQLite adapter needs `drizzle-orm`. If you use the owner package, install `@vite-hub/env` and import from `@vite-hub/env/<subpath>`.

### Configure

Write a factory that builds the bridge from your database, encryption key, and session reader, in your app code.

```ts [server/env/create-credentials.ts]
import { createEnvAuthenticator, createEnvBridge } from 'vite-hub/env/bridge'
import { createDatabaseEnvStore } from 'vite-hub/env/database'
import type { EnvHumanSession } from 'vite-hub/env/bridge'
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
    runtimeActor: { kind: 'service', id: 'application' },
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

Call the factory once per runtime. Export its `provider` as the default export of your provider module, here `server/env/credentials.ts`. For ViteHub Auth, pass a wrapper around `auth.api.getSession({ headers })`. Write your own `isAdmin`: being signed in does not make a user an admin.

Register the provider module and declare the key you use.

:::tabs{sync="framework"}
::::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
import { env } from 'vite-hub/env'

export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    host: 'node',
    console: { auth: false },
    env: {
      providers: { credentials: './server/env/credentials.ts' },
      server: {
        githubToken: env({
          secret: true,
          source: env.provider('credentials', 'github/token'),
        }),
      },
    },
  },
})
```
::::

::::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'

export default defineConfig({
  plugins: [vitehub({
    host: 'node',
    console: { auth: false },
    env: {
      providers: { credentials: './server/env/credentials.ts' },
      server: {
        githubToken: env({
          secret: true,
          source: env.provider('credentials', 'github/token'),
        }),
      },
    },
  }), nitro()],
})
```
::::

::::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'

export default defineConfig({
  plugins: [vitehub({
    host: 'node',
    console: { auth: false },
    env: {
      providers: { credentials: './server/env/credentials.ts' },
      server: {
        githubToken: env({
          secret: true,
          source: env.provider('credentials', 'github/token'),
        }),
      },
    },
  })],
})
```
::::
:::

### Start using it

An admin stores the first value and grants `use` to the service, from trusted server code.

```ts fragment
// owner is the administrator context that authenticate(request) returns.
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

Server code then reads it through Server Env.

```ts
import { loadServerEnv } from 'vite-hub/env'

const env = await loadServerEnv()
const token = env.githubToken.unseal()
```

::

## Public imports

| Import | Use |
| --- | --- |
| `createEnvBridge` from `vite-hub/env/bridge` | Build a bridge from a secret store, an access store, and the runtime actor. |
| `createDatabaseEnvStore` from `vite-hub/env/database` | Store encrypted values, grants, and activity in a SQLite Drizzle database. |
| `createEnvAuthenticator` from `vite-hub/env/bridge` | Turn a request into an `EnvAccessContext` from a Better Auth session or a verified Agent session. It is the only way to get a user, Agent token, or administrator context. |
| `createEnvBridgeHandler` from `vite-hub/env/bridge` | Handle management requests on a server route. The Console uses it through the generated Server Env module. |
| `importSealKey`, `sealWithKey`, `unsealWithKey`, `sealKeyId` from `vite-hub/env/seal` or `@vite-hub/env/seal` | AES-GCM helpers in the database store format, for owner packages. |

Types such as `EnvAccessContext`, `EnvPermission`, `EnvGrant`, `EnvActivity`, `EnvSecretStore`, and `EnvAccessStore` come from `vite-hub/env/bridge`. `vite-hub/env/database` is a separate entry because it loads the optional `drizzle-orm` peer. Each `vite-hub/env/<subpath>` import is also available as `@vite-hub/env/<subpath>`.

## Bridge options

| Option | Type | Description |
| --- | --- | --- |
| `secrets` | `EnvSecretStore` | Reads, inspects, and safely replaces stored values. |
| `access` | `EnvAccessStore` | Stores grants and appends activity. |
| `runtimeActor` | `EnvActor` | Fixed identity of this runtime, for `loadServerEnv()` without an access context. It gets only its own grants, on this bridge only. |
| `runtimeAttribution` | `() => { traceId?, invocationId? } \| undefined` | Optional. Adds trace and invocation IDs to runtime reads, but cannot change the actor. |
| `emit` | `(event: EnvActivity) => void \| Promise<void>` | Optional. Exports each event after it is saved. See [Export persisted events to evlog](#export-persisted-events-to-evlog). |

`createDatabaseEnvStore()` returns `secrets` and `access`, so you can spread it into `createEnvBridge()`. Its options:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `db` | `EnvDatabase` | Required | A SQLite Drizzle instance, or a compatible ViteHub Database. |
| `encryptionKey` | `Uint8Array` | Required | A 32-byte key. Other lengths fail with `ENV_BRIDGE_INVALID`. |
| `namespace` | `string` | `'default'` | Keeps the credentials of several bridges apart in one database. |
| `previews` | `boolean` | `false` | Stores a masked preview for token-shaped values. |

The store also returns `revisionCondition(key, revision)`, a SQL condition that updates related records only while that secret revision is current. A `null` revision means the secret must not exist.

## Providers

| Store | Activation | Notes |
| --- | --- | --- |
| `createDatabaseEnvStore()` (SQLite through Drizzle) | `next-resolution` | AES-256-GCM with a new IV per write. Authenticates the namespace, key, and revision. Creates its tables on first use. |
| Custom `EnvSecretStore` and `EnvAccessStore` | `next-resolution`, `restart`, or `deploy` | The store's `replace()` returns its activation. |

Env Bridge runs where the Env provider runs. The database and key must survive restarts. Keep the key in your host secret store, apart from the database, and back it up.

## Replace a credential

To replace a value, pass the revision from `bridge.inspect()`. `expectedRevision: null` creates a missing value. An edit with an old revision fails with `ENV_BRIDGE_CONFLICT`. Inspect again, then retry.

With `activation: 'next-resolution'`, the next `loadServerEnv()` reads the new value. Old snapshots, running operations, SDK clients, and child processes keep the old value, so resolve credentials per operation and rebuild clients. A new key does not renew an OAuth subscription or change a running process's environment.

## Limit inspection and use independently

A grant covers one actor kind (`user`, `agent`, or `service`), one actor ID, and one store key, with separate permissions:

| Permission | Allows |
| --- | --- |
| `inspect` | Read the revision and update metadata. |
| `preview` | Read an optional masked preview. |
| `replace` | Replace the stored value, with a revision check. |
| `use` | Resolve the value at runtime, or run a trusted `bridge.use()` operation. |

- Only admins manage grants and read activity. An admin context passes every permission check.
- Only Env creates an `EnvAccessContext`. Each source gets only the identity it can prove:
  - The bridge runtime reads as its `runtimeActor`.
  - `createEnvAuthenticator()` returns the signed-in user, or the Agent of a verified Agent token. It returns an admin context only when your `isAdmin` returns `true`.
  - The ViteHub Agent runtime creates `agent:<name>` for the running Agent and gives it to its Connection capabilities. A caller cannot pick the name.
- The context is frozen. Use it only in the request or invocation that made it. Never store it.
- The bridge rejects any context that Env did not create with `ENV_BRIDGE_UNTRUSTED`: `{ actor }`, `{ actor, admin: true }`, a spread copy, or a JSON copy. TypeScript rejects them too. Grants are stored per actor, so a context you build cannot claim another actor's grants.
- A verified Agent token can add a `scope`, which limits the Agent's grants. A context with a `scope` never gets admin access.
- A revoke applies from the next permission check. It cannot take back a secret that an operation already read.
- Never accept actor IDs, admin flags, or token scopes from a request body.

Env management in the Console (**Manage credential**, Access, and Activity) needed the Console that the app served, which is removed. Preview works alone. Replace also needs `inspect`, because a replace needs the revision.

## Distinguish retrieval from actual use

`loadServerEnv(undefined, { access: context })` records the read for that context. Without a context, the bridge uses `runtimeActor`.

| Action | Recorded when |
| --- | --- |
| `resolve` | `loadServerEnv()` reads the credential. |
| `use` | A `bridge.use()` callback runs, with an operation name and its result. |
| `inspect`, `preview`, `replace` | A management call runs. |
| `grant`, `revoke` | An admin changes a grant. |

A successful `use` means the callback finished, so make it reject failed provider responses. The bridge cannot see how a value from a normal Env snapshot is used.

`bridge.use(context, key, operation, callback)` passes `{ revision }` as the second callback argument when the store has one. Use it with `revisionCondition()` to guard related writes.

Activity saves `started` before it reads or changes a credential, then `succeeded` or `failed`. It also records `denied` attempts. If the activity store is down, the bridge denies the operation with `ENV_BRIDGE_AUDIT_FAILED`. A lone `started` entry, for example after a crash, means the result is unknown. An outside service may still have got the value.

Admins read `bridge.activity(context, key, before?)`: up to 100 events per page, newest first. Pass the last event's ID as `before` for the next page. Activity never holds values, previews, or callback error messages. Actor IDs, operation names, trace IDs, and invocation IDs must be identifiers, not secret data.

## Export persisted events to evlog

`emit` sends each saved event to your evlog drain. It does not retry. A failed export does not remove the record or undo the operation.

```ts fragment
import { createLogger } from 'evlog'

const bridge = createEnvBridge({
  ...store,
  runtimeActor: { kind: 'service', id: 'application' },
  runtimeAttribution: () => trustedInvocationIds(),
  emit(event) {
    createLogger({ event: 'env.activity', env: event }).emit()
  },
})
```

Return `traceId` and `invocationId` from `runtimeAttribution` to link runtime reads to your Agent run. Contexts from the ViteHub Agent runtime carry the invocation ID.

## Structured errors

Bridge operations throw `ViteHubError` with a fixed message. Other failures become `ENV_BRIDGE_OPERATION_FAILED`. The management route returns `{ code, message, fix, docs }`, where `fix` is the repair and `docs` links here.

| Code | Cause |
| --- | --- |
| `ENV_BRIDGE_DENIED` | The context lacks the permission, or its scope leaves out the key. |
| `ENV_BRIDGE_CONFLICT` | The `expectedRevision` is old. |
| `ENV_BRIDGE_MISSING` | The credential does not exist. |
| `ENV_BRIDGE_INVALID` | The request, actor, grant, or store option is invalid. |
| `ENV_BRIDGE_AUDIT_FAILED` | Activity could not be saved. |
| `ENV_BRIDGE_UNTRUSTED` | Env did not create the access context. The management route returns `503`. |
| `ENV_BRIDGE_OPERATION_FAILED` | Any other failure, including a store or callback error. |

## Limits

- Previews are off by default. The SQLite adapter keeps the first and last four characters of token-shaped values over 12 characters. Short and structured secrets get no preview. Previews are sensitive, so limit `preview` access and database access.
- A stored value must be 1 to 32,768 bytes. Other values fail with `ENV_BRIDGE_INVALID`.
- Your app owns host administration and database backup security.
- After a self-hosted restart, check that the next read sees a replacement and that the activity page still has the last run's events.

## Connect Env Bridge to Agents

Agents use their own identity, never their owner's admin access.

### Authenticate Agent Auth sessions

Add [`@better-auth/agent-auth`](https://www.better-auth.com/docs/plugins/agent-auth) to your Better Auth config. Its `auth.api.getAgentSession({ headers })` verifies the Agent credential and returns the grants that the token's capabilities allow. Env does not install or configure the plugin.

Pass that reader to `createEnvAuthenticator`, and map capabilities and their constraints to exact store keys. This example supports one fixed capability and rejects grants with constraints:

```ts fragment
import { createEnvAuthenticator } from 'vite-hub/env/bridge'
import type { AgentSession } from '@better-auth/agent-auth'
import type { EnvAgentScope } from 'vite-hub/env/bridge'

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
- A request with an `Authorization` bearer header is an Agent request. A bad Agent credential never falls back to the owner's browser cookie.
- A failure in session checks, policy, or scope mapping denies access.

### Run brokered operations

ViteHub Agents call third-party APIs through Connection capabilities, such as `gmail()`, `mcp()`, and `openapi()`. Each gets the `agent:<name>` context, and the Connection access map decides what that Agent can do.

An Agent Auth `onExecute` handler cannot create an Env context, because Env cannot verify its session object again. Send the Agent request to a route that calls `authenticate(request)`.

Keep callbacks in trusted server code and return only the tool result, never the raw credential. Check capability inputs and constraints before you call outside services. The Agent Auth plugin still changes, so pin and test its version.

## Migrate to Env-created contexts

A context that your code builds now fails with `ENV_BRIDGE_UNTRUSTED`.

- Replace `runtimeContext: () => ({ actor })` with `runtimeActor: actor`. Move dynamic trace IDs to `runtimeAttribution`.
- Get request contexts from `createEnvAuthenticator()`, also in a custom `authenticate`.
- For an Agent, use a Connection capability in a ViteHub Agent, or an Agent token through `createEnvAuthenticator()`.
- Keep `EnvAccessContext` in your types. Only the value must come from Env.

## Next steps

- Declare provider-backed values with [Env](/docs/env/server-api#read-external-env-storage).
- Call third-party APIs for connected accounts with [Connections](/docs/connections).
- Protect management with [Auth](/docs/auth) and the [Console](/docs/console/access#who-can-call-the-endpoint).
