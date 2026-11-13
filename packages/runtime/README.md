# @vite-hub/runtime

<p>
  <a href="https://vitehub.dev"><img alt="ViteHub" src="https://comark-ui.onmax.me/badge.svg?label=ViteHub&amp;value=vitehub.dev"></a>
  <img alt="TypeScript" src="https://comark-ui.onmax.me/badge.svg?label=TypeScript&amp;value=ready">
  <img alt="Runtime" src="https://comark-ui.onmax.me/badge.svg?label=Runtime&amp;value=context+%7C+policy+%7C+trace">
</p>

`@vite-hub/runtime` provides the shared Runtime Host Context, Runtime Capability,
policy, approval, trace, error, lease, and execution-authority contracts used by
ViteHub packages and custom host integrations.

## Choose an import

| You are building                              | Install                   | Import                                              |
| --------------------------------------------- | ------------------------- | --------------------------------------------------- |
| A ViteHub application                         | `vite-hub`                | `vite-hub/runtime`                                  |
| A reusable package or custom host integration | `@vite-hub/runtime`       | `@vite-hub/runtime`                                 |
| Node diagnostics and process lifecycle        | The same selected package | `vite-hub/runtime/node` or `@vite-hub/runtime/node` |

Use the `vite-hub` facade when it is already your application dependency. Install
this owner package directly when the integration should depend only on Runtime's
portable contracts. This package does not register Vite, Nuxt, routes, providers,
or Agent Definitions.

## Install the owner package

```sh
pnpm add @vite-hub/runtime
```

The package declares Node.js 22.18 or newer. Import the root entry for portable
Runtime contracts. When inspected, the `/node` entry reads Node process
information and, on Linux, `/proc` and cgroup v2 files.

Trace payload inspection relies on the host's platform intrinsics. Load the
Runtime before application code replaces platform methods. The Runtime captures
`WebAssembly.Module.exports` at import time to recognize foreign modules even
when that method is later replaced. It cannot recover the original intrinsic
if the host replaces it before import; payload inspection is not an isolation
boundary for code that can modify the host's JavaScript environment.

Long-lived Node services can also use `createProcessReconciler()` from the `/node`
entry to coalesce event-driven work, run periodic repair, stop admission, and await
tracked work during a graceful drain. Set `signal: "SIGUSR2"` when the service
manager should trigger that drain through `vitehub drain MAINPID [STATUS_URL]`
from the `vite-hub` package, for example in systemd `ExecStop`. Lifecycle callbacks
must return before an external caller starts `drain()`; calling `drain()` from an
active callback rejects to prevent that callback from waiting on itself. `close()`
removes the configured signal listener after the drain settles, including a failed
drain. Keep the
status endpoint available until `vitehub drain` observes the terminal `drained`
status; process exit or endpoint loss before that acknowledgement is a failed drain.

ViteHub packages register their stop work with `onShutdown(nitroApp, name, drain)`
from the `/shutdown` entry, in a Nitro plugin. Applications do not call it. When a server
that owns stop signals gets `SIGTERM` or `SIGINT`, ViteHub runs every registered drain
in parallel and keeps HTTP open. Each drain gets the shared budget from
`VITEHUB_SHUTDOWN_DRAIN_MS` (default 0) and an `AbortSignal` that aborts when the
budget ends. A drain that does not settle 15 seconds after the budget ends is
reported as `timeout`. Then the server closes HTTP, Nitro runs its `close` hooks
for up to 10 seconds, and the process exits once with code 0. Give the host a
termination grace period longer than the budget plus 25 seconds. The Node, Bun, and
Deno server presets own stop signals. In development, during prerender, on
serverless and Cloudflare hosts, and when the server's graceful shutdown is off,
ViteHub does not handle signals; the drains run when the Nitro app calls its
`close` hooks. `shutdownState()` (also `process.__vitehubShutdown`) shows the
registered drains, the signal, and each drain result. The logs have the events
`shutdown.draining`, `shutdown.drained`, and `shutdown.exited`.

## Get a first result

Create the host context explicitly, register one Runtime Capability, and look it
up through the public package entry:

```ts
import { createRuntimeContext, defineCapability, getCapability } from "@vite-hub/runtime";

const context = createRuntimeContext({
  capabilities: {
    health: defineCapability("health", { status: "ready" }),
  },
  runtime: "node",
});

const health = getCapability(context, "health");
console.log(`${context.runtime}:${health.kind}`);
await context.flushWaitUntil();
```

Running the file prints:

```text
node:health
```

## Understand the boundaries

### Runtime Host Context

`createExecutionContext()` normalizes a complete object supplied by the host.
`createRuntimeContext()` also supplies memo storage and background-work tracking.
The host still owns the runtime name, request or event data, provider bindings,
background-work lifetime, and cleanup. Runtime does not discover framework globals, propagate an
ambient context, or isolate concurrent requests.

Treat every value on the context as available to code that receives it. Runtime
does not clone, redact, encrypt, or restrict `request`, `event`, `cloudflare.env`,
`runtimeConfig`, or Runtime Capability values. Pass only the bindings and secrets
needed by that operation, and do not copy secrets into traces or approval input.

### Host bindings

`getHostBinding(name, event?)` reads one raw binding of a Cloudflare Worker, such
as an R2 bucket or a `send_email` binding, for host features that no ViteHub
primitive covers. It reads the bindings of the request event, else the bindings
that Nitro or ViteHub installed for the current request, Schedule, Queue
message, or Workflow step. It returns `[error, binding]`:

- `RUNTIME_HOST_BINDINGS_UNAVAILABLE` when the code runs without host bindings,
  for example on Node.
- `RUNTIME_HOST_BINDING_NOT_FOUND` when the Worker has no binding with that name.

Run `wrangler types` to type the binding from `Cloudflare.Env`. Without it, the
binding is `unknown`.

```ts fragment
import { getHostBinding } from "vite-hub/runtime"

const [error, email] = getHostBinding("REVIEW_EMAIL", event)
if (error) throw createError({ statusCode: 503, statusMessage: error.why })
await email.send(message)
```

`detectHost()` returns the host that `vitehub()` builds for when `host` is
omitted, or `"cloudflare"` inside a Worker. It returns `undefined` when nothing
names a host.

### Runtime Capabilities

`defineCapability()` and `getCapability()` pass a named implementation between
packages. Lookup accepts only own properties of `context.capabilities`; inherited
properties do not register capabilities. A handle is not a permission boundary: code that receives its `value`
can call that implementation. Keep authentication, tenant checks, input
validation, rate limits, and provider credentials at the application or provider
boundary that owns the operation.

### Policy and approvals

`resolveCapabilityPolicy()` evaluates a decision. An omitted policy resolves to
`allow`; `deny` and `require-approval` have an effect only when the calling
feature checks the decision before performing work. The approval interfaces are
records, not a durable approval queue or trusted approver service. The host must
authenticate the actor, persist and correlate decisions when required, prevent
replay, and resume or reject the operation.

### Traces

`createTraceEventLog()` is an in-memory log. Its default `metadata` policy omits
known content-bearing attribute keys such as `input`, `prompt`, `body`, and
`output`, including nested keys. This is bounded omission by key, not general
secret detection. Arbitrary names such as `token` or `authorization` are not
automatically redacted, and `error.message` is retained. `{ content: "content" }`
retains all supplied attributes.

Attribute projection reads own data properties. It does not invoke attribute
getters. In `metadata` mode this also applies to nested objects and array entries;
accessor-backed content keys are recorded as omitted, and other accessors are
skipped. In `content` mode nested attribute values remain unchanged.

Own trace access, retention, size limits, redaction, and durable export in the
host. `entries()` returns the current in-memory entries; it does not persist or
stream them by itself.

### Execution authority and public errors

`ExecutionAuthority` is an immutable snapshot of the filesystem, network,
environment, credentials, process, and isolation properties reported when an
execution surface is resolved. It describes those properties; it does not enforce
them. `unknown` means the provider did not prove a dimension; it never means
`none`. An isolation label such as `container` or `microvm` is not a security rank.

`ViteHubError` snapshots its JSON-safe public `name`, `code`, `message`, `details`,
and `requestId` at construction, and freezes the serialized snapshot and its
details. Never put secrets in those fields; keep raw provider failures in `cause`.
A `cause` is excluded from `toJSON()`, but remains available to code and loggers
that inspect the Error instance.

### Grants

ViteHub packages use `defineGrant()` from the internal `@vite-hub/runtime/internal/grant` entry. It is not a public API. A grant connects a check to the sensitive action that it guards: the check issues a frozen grant, and the action requires the grant and verifies it at runtime.

```ts
import { defineGrant } from "@vite-hub/runtime/internal/grant"

const sourceWrite = defineGrant("vitehub.workspace.source-write", (path: string) => path)

export function checkSourceWrite(path: string) {
  // ...the owner check...
  return sourceWrite.issue(path)
}

export function writeSource(grant: ReturnType<typeof checkSourceWrite>, data: string) {
  const path = sourceWrite.verify(grant)
  // ...write `data` to `path`...
}
```

- Keep the definition module-private. Only the module that owns the check issues grants.
- Bind the grant to what it authorizes, for example a path, a tool call, or a request. The second argument of `defineGrant()` copies or freezes that value.
- `verify()` returns the bound value or throws a `ViteHubError` with code `GRANT_REQUIRED`. `check()` returns `undefined` instead; use `isValid()` when a bound value may itself be `undefined`. `consume()` makes a grant single-use. `attach(owner, grant)` and `attached(owner)` keep a grant with a request or context object.
- Each definition has its own registry. A grant from another definition, another bundled copy of the package, or a forged object fails closed. The kind string brands the grant type, so use a unique `vitehub.<package>.<name>` kind.
- Grants are request-scoped. Never persist one. Durable or resumed work must run the check again.

### Errors

Every primitive follows one error contract:

1. A runtime operation returns `[error, data]`. Errors before a stream starts are in the tuple; errors after it starts go into the stream.
2. Definition and config errors throw, at build time, at define time, or when an operation starts.
3. A package defines a small catalog with `defineErrors()`. Each code has a guessable name, a `why`, and a `fix`.
4. Each method type lists the union of the codes that it can return.
5. Each code has a heading on the `limits-and-errors` docs page of the package, so `error.docs` opens it.

```ts
import { defineErrors, type Result } from "@vite-hub/runtime"

const errors = defineErrors({
  docs: "https://vitehub.dev/docs/kv/limits-and-errors",
  codes: {
    KV_INVALID_LIMIT: { why: "`limit` must be a positive integer.", fix: "Pass a positive integer." },
  },
})

async function list(limit: number): Promise<Result<string[], "KV_INVALID_LIMIT">> {
  if (!Number.isInteger(limit) || limit <= 0) return [errors.KV_INVALID_LIMIT(), undefined]
  return [undefined, []]
}

const [error, keys] = await list(0)
if (error) error.code // "KV_INVALID_LIMIT"
```

A `ResultError` is a Nostics diagnostic with `code`, `why`, `fix`, `docs`, and `cause`. Catalog definitions can also provide static or computed `data`. `defineErrors()` infers that data for each code; `ResultError<Code, Data>` can name its type explicitly. A bare `ResultError` or `ResultError<Code>` keeps data as `unknown` so it can accept any catalog error. Codes without data infer `undefined`.

Its `toJSON()` returns only `name`, `code`, `why`, `fix`, and `docs`. The code and name keep their literal types. For compatibility with Nostics consumers such as `formatDiagnostic()`, its return type retains Nostics serializer fields, including required `data`; those metadata fields are not present at runtime. Read metadata from the error itself. Cause, stack, sources, and diagnostic data stay in memory and are absent from public JSON.

`toResultError()` gives an allowed diagnostic this public serializer. It keeps the
same object when its `name` and `toJSON` properties can be replaced. Otherwise it
creates a new diagnostic with the same code, text, cause, data, sources, and stack,
and leaves the original unchanged. The caller owns code allowlisting and public text.

### Durability

Each primitive reports where it keeps its state for the driver that it uses:

```ts fragment
interface Durability {
  primitive: string
  name?: string
  store: string
  scope: 'shared' | 'host' | 'process'
  reason: string
  fix?: string
}
```

A primitive's Vite plugin contributes a reporter through `vitehub.durability`:
the primitive id, a module, an export, and the resolved configuration as JSON.
A Node server built with ViteHub calls each reporter at boot as
`reporter(input, context)`. `context.env` is `process.env`, so a driver that an
environment variable selects at boot, such as `REDIS_URL`, reports correctly.
`context.find(primitive, name)` returns the report of another primitive, such
as the Database that a KV store or the Queue keeps its rows in.
`classifySqliteUrl()` tells a local SQLite file from a remote libSQL server.

The server then calls `checkDurability()`. It prints one line per primitive,
records the report for `getDurabilityReport()` and `vitehub durability list`,
and throws `RUNTIME_R0017` when `VITEHUB_INSTANCES` (or `node.instances`) is
greater than 1 and a primitive is `host` or `process` scoped. A new driver
reports itself in its owner package's `durability.ts`.

### Developer diagnostics

Runtime-owned API and contract defects use Nostics diagnostics with stable `RUNTIME_R####` codes. Packages that do not follow the error contract yet keep the `ViteHubError` public contract for expected portable failures. See [Errors and diagnostics](https://vitehub.dev/docs/reference/errors-diagnostics).

`normalizeRuntimeDiagnosticError(error)` creates a bounded diagnostic record. It
preserves Nostics codes, fixes, documentation links, and source locations from
Error instances and JSON records. Causes, aggregate errors, details, and source
locations share a node budget. All strings share a size budget. Stacks require
`{ includeStack: true }`.

Use `formatRuntimeDiagnosticError(error)` for terminal output or Agent tool error
text. It prints the code, message, fix, source locations, and documentation link
with Nostics formatting. It omits causes and stacks. Plain errors return their
message. Both helpers accept `unknown` and handle failed property reads.

Use `isRuntimeDiagnostic(error)` to recognize a live Nostics error from another bundled copy. It checks the native Error and diagnostic fields without requiring the same `Diagnostic` constructor. It rejects serialized records; use `normalizeRuntimeDiagnosticError()` to inspect those. Recognition does not make diagnostic text safe for a public response. Keep the owning package's code allowlist and public error mapping.

These helpers produce developer diagnostics. They do not make arbitrary errors
safe for public responses. Use the `ViteHubError` public contract at that boundary.

### Leases

A lease gives one caller at a time a key, such as one Schedule occurrence or one leader. It ends at `release()` or when its TTL passes, so a holder that crashes blocks the key only until then.

| Store | Use it for | Atomic across |
| --- | --- | --- |
| `createMemoryLeaseStore()` | One process and tests | One process |
| `createSqlLeaseStore(client)` | Several instances on one Database | Every process on the Database |

```ts fragment
import { createSqlLeaseStore } from '@vite-hub/runtime'
import postgres from 'postgres'

const sql = postgres(process.env.DATABASE_URL!)
const leases = createSqlLeaseStore({
  dialect: 'postgresql',
  query: async (text, params) => await sql.unsafe(text, params),
})

const [error, lease] = await leases.acquire('report:2026-11-09', { ttl: 60, owner: 'instance-a' })
if (error) throw error
// `lease` is null when another instance holds the key.
if (lease) {
  try {
    await sendReport()
  }
  finally {
    await lease.release()
  }
}
```

On libSQL, pass `{ dialect: 'sqlite', query: async (sql, args) => (await client.execute({ sql, args })).rows }`. On `node:sqlite`, pass `{ dialect: 'sqlite', query: async (sql, params) => db.prepare(sql).all(...params) }`. A local libSQL `file:` client is for one process only. See the note on SQLite below.

- `acquire(key, { ttl, owner? })` returns `[error, lease]`. `lease` is `null` when another caller holds the key. `ttl` is in seconds, like KV. Fractions are allowed. Leases are not reentrant: the same `owner` also gets `null`.
- Each acquire gets a new random `id`. `lease.release()` and `lease.renew({ ttl? })` act only when the stored `id` is still this one. They return `false` when the lease expired and another caller took it. `renew()` updates `lease.expiresAt`.
- `get(key)` returns the live lease with its `owner` and `expiresAt`, or `null`. Use it to inspect who holds a key.
- `owner` is a label for inspection. Acquire does not compare it.
- Errors: `RUNTIME_LEASE_INVALID_TTL` when `ttl` is not a positive number, and `RUNTIME_LEASE_FAILED` when the store fails. Read `error.cause` for the Database error.

The SQL store keeps leases in the `vitehub_leases` table and creates it when it is missing. Each operation is one statement. Acquire is one `INSERT ... ON CONFLICT ("key") DO UPDATE ... WHERE expires_at <= now RETURNING`, so of many processes that acquire one key at the same time, exactly one gets it. Expiry uses the clock of the Database, not the clocks of the hosts. Postgres and SQLite 3.35 or later work. The store deletes expired rows at most once a minute.

There is no KV lease store yet. A KV lease store needs atomic compare-and-delete for `release()` and atomic compare-and-set with a TTL for `renew()` on every KV driver it supports, so it can check the holder in the same step. These are follow-ups. The `fs-lite` driver also ignores the TTL, so a lease on it would never expire.

On SQLite, a statement that fails with `SQLITE_BUSY` because another process holds the lock runs again for up to 5 seconds, without blocking the event loop. Contention gives a `null` lease, not `RUNTIME_LEASE_FAILED`.

When several processes share leases, use Postgres, remote libSQL, or `node:sqlite` on one file. Do not use a local libSQL `file:` client in more than one process. After `SQLITE_BUSY`, `@libsql/client` 0.18 keeps the transaction of the failed statement open, and it can lose writes that it reported as done. A busy `timeout` makes this less frequent but does not stop it under load.

#### Provision the SQL table

On PostgreSQL, automatic table creation needs `CREATE` privilege on the schema. If migrations use a separate role, create the table and index before the application uses the store. An accessible existing table skips DDL, so the application role does not need `CREATE`.

These statements work on both PostgreSQL and SQLite 3.35 or later:

```sql
CREATE TABLE IF NOT EXISTS vitehub_leases (
  "key" text PRIMARY KEY,
  id text NOT NULL,
  owner text,
  expires_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS vitehub_leases_expires_at
  ON vitehub_leases (expires_at);
```

`expires_at` stores milliseconds since the Unix epoch. Create the table in the schema that the application connection resolves. On PostgreSQL, the application role needs `USAGE` on that schema and `SELECT`, `INSERT`, `UPDATE`, and `DELETE` on the table. For example, for the `public` schema and an application role named `lease_app`, run this as the migration role:

```sql
GRANT USAGE ON SCHEMA public TO lease_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.vitehub_leases TO lease_app;
```

## Public entry points

| Import                   | Provides                                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------------------------- |
| `@vite-hub/runtime`      | Context, capability, policy, approval, trace, lease, diagnostic, error, execution-authority, public URL, and host binding APIs |
| `@vite-hub/runtime/durability` | The `Durability` contract that each primitive reports, the boot table, and the instance check |
| `@vite-hub/runtime/node` | Node process observations, reconciliation, and graceful-drain lifecycle primitives                  |
| `@vite-hub/runtime/shutdown` | Shared host shutdown: drain registration, stop signal handling, and shutdown state            |

Do not import from `src`, `dist`, or ViteHub's `_internal` paths.

## Go deeper

- [Runtime Context](https://vitehub.dev/docs/reference/runtime-context)
- [Runtime policy, approvals, and traces](https://vitehub.dev/docs/agents/runtime-policy)
- [Runtime events](https://vitehub.dev/docs/reference/runtime-events)
- [Stable import paths](https://vitehub.dev/docs/reference/import-paths)
- [Node Runtime diagnostics](https://vitehub.dev/docs/agents/capabilities/diagnostics)
- [Report a Runtime issue](https://github.com/vite-hub/vitehub/issues/new)
