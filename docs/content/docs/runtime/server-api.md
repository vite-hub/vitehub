---
title: Runtime Server API
navigation.title: Server API
description: Read host bindings, pass Runtime Capabilities, check policy, record traces, hold leases, and drain a server with vite-hub/runtime.
navigation.order: 6
navigation.group: Reference
icon: i-lucide-square-function
---

This page lists the functions of `vite-hub/runtime` that server code calls. Apps import them from `vite-hub/runtime`. Libraries import the same names from `@vite-hub/runtime`. [Runtime Context](/docs/runtime/context) covers `getRuntimeContext()` and `createRuntimeContext()`, and [Errors](/docs/runtime/errors) covers `defineErrors()`.

## Host bindings

`getHostBinding(name, event?)` reads one raw binding of a Cloudflare Worker, such as an R2 bucket or a `send_email` binding. Use it for a host feature that no ViteHub primitive covers. It reads the bindings of the request event. Without an event, it reads the bindings that Nitro or ViteHub installed for the current request, Schedule, Queue message, or Workflow step.

```ts [server/api/review.post.ts] fragment
import { getHostBinding } from 'vite-hub/runtime'

const [error, email] = getHostBinding('REVIEW_EMAIL', event)
if (error) throw createError({ statusCode: 503, statusMessage: error.why })
await email.send(message)
```

It returns `[error, binding]`:

- `RUNTIME_HOST_BINDINGS_UNAVAILABLE` when the code runs without host bindings, for example on Node.
- `RUNTIME_HOST_BINDING_NOT_FOUND` when the Worker has no binding with that name.

Run `wrangler types` to type the binding from `Cloudflare.Env`. Without it, the binding is `unknown`.

`detectHost()` returns the host that `vitehub()` builds for when `preset` is not set, or `"cloudflare"` inside a Worker. It returns `undefined` when nothing names a host.

## Runtime Capabilities

`defineCapability(kind, value)` makes a named handle. `getCapability(context, name)` reads it from `context.capabilities`, and `hasCapability()` checks for it. Lookup reads only own properties, so inherited properties do not register a Capability.

A handle is not a permission boundary. Code that gets its `value` can call that implementation. Keep authentication, tenant checks, input validation, rate limits, and provider credentials at the boundary that owns the operation.

A Runtime Capability is not an Agent Capability. An Agent Capability gives an Agent one ability. See [Capabilities](/docs/agents/capabilities).

## Policy and approvals

`resolveCapabilityPolicy()` evaluates a policy and returns a `PolicyDecision`: `allow`, `deny`, `require-approval`, or `retryable-failure`. No policy gives `allow`.

- `deny` and `require-approval` have an effect only when the feature checks the decision before it does the work.
- `ApprovalRequest` and `ApprovalDecision` are records. They are not a durable approval queue or an approver service.
- The host authenticates the approver, stores and matches decisions, stops replays, and resumes or rejects the operation.

[Runtime policy, approvals, and traces](/docs/agents/runtime-policy) shows how Agents use them.

## Traces

`createTraceEventLog()` makes an in-memory log of [Trace Events](/docs/runtime/events#trace-event). `entries()` returns the current entries. The log does not store or stream them.

- The default `metadata` policy omits attribute keys that usually hold content, such as `input`, `prompt`, `body`, and `output`, also in nested objects. This omits by key. It does not find secrets: names such as `token` or `authorization` are kept, and so is `error.message`.
- `{ content: 'content' }` keeps every attribute.
- The log reads own data properties and never calls getters.
- `deriveTraceRuns(entries)` groups the entries into runs for the [Trace UI](/docs/ui/trace).

Trace payload checks use the platform functions of the host. Load the Runtime before application code replaces them. The checks are not an isolation boundary for code that can change the JavaScript environment.

The host owns trace access, retention, size limits, redaction, and export.

## Execution authority

`ExecutionAuthority` is a frozen record of the filesystem, network, environment, credential, process, and isolation properties of an execution surface, such as a Sandbox. It describes them. It does not enforce them.

- `unknown` means that the provider did not prove a property. It never means `none`.
- An isolation label such as `container` or `microvm` is not a security rank.

## Leases

A lease gives one caller at a time a key, such as one Schedule occurrence or one leader. It ends at `release()` or when its TTL passes, so a holder that crashes blocks the key only until then.

| Store | Use it for | Atomic across |
| --- | --- | --- |
| `createMemoryLeaseStore()` | One process and tests | One process |
| `createSqlLeaseStore(client)` | Several instances on one Database | Every process on the Database |

```ts [server/tasks/report.ts] fragment
import postgres from 'postgres'
import { createSqlLeaseStore } from 'vite-hub/runtime'

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

On libSQL, pass `{ dialect: 'sqlite', query: async (sql, args) => (await client.execute({ sql, args })).rows }`. On `node:sqlite`, pass `{ dialect: 'sqlite', query: async (sql, params) => db.prepare(sql).all(...params) }`.

- `acquire(key, { ttl, owner? })` returns `[error, lease]`. `lease` is `null` when another caller holds the key. `ttl` is in seconds, as in KV, and can be a fraction. Leases are not reentrant: the same `owner` also gets `null`.
- Each acquire gets a new random `id`. `lease.release()` and `lease.renew({ ttl? })` act only while the stored `id` is still this one. They return `false` when the lease expired and another caller took it. `renew()` updates `lease.expiresAt`.
- `get(key)` returns the live lease with its `owner` and `expiresAt`, or `null`.
- `owner` is a label for inspection. Acquire does not compare it.
- Errors: `RUNTIME_LEASE_INVALID_TTL` when `ttl` is not a positive number, and `RUNTIME_LEASE_FAILED` when the store fails. Read `error.cause` for the Database error.

The SQL store keeps leases in the `vitehub_leases` table and creates it when it is missing. Acquire is one `INSERT ... ON CONFLICT ("key") DO UPDATE ... WHERE expires_at <= now RETURNING` statement, so when many processes acquire one key at the same time, exactly one gets it. Expiry uses the clock of the Database. Postgres and SQLite 3.35 or later work.

On SQLite, a statement that fails with `SQLITE_BUSY` runs again for up to 5 seconds. Contention gives a `null` lease, not `RUNTIME_LEASE_FAILED`. When several processes share leases, use Postgres, remote libSQL, or `node:sqlite` on one file. Do not use a local libSQL `file:` client in more than one process: after `SQLITE_BUSY`, it can lose writes that it reported as done.

There is no KV lease store yet.

::details{summary="Create the table with a migration role"}
On PostgreSQL, automatic table creation needs `CREATE` privilege on the schema. If migrations use a separate role, create the table and index before the app uses the store. These statements work on PostgreSQL and on SQLite 3.35 or later:

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

`expires_at` stores milliseconds since the Unix epoch. On PostgreSQL, the app role needs `USAGE` on the schema and `SELECT`, `INSERT`, `UPDATE`, and `DELETE` on the table:

```sql
GRANT USAGE ON SCHEMA public TO lease_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.vitehub_leases TO lease_app;
```
::

## Node process lifecycle

`vite-hub/runtime/node` has Node-only helpers. When you inspect it, it reads Node process data and, on Linux, `/proc` and cgroup v2 files.

`createProcessReconciler()` runs event-driven work for a long-lived Node service. It merges repeated triggers, runs periodic repair, stops new work, and waits for tracked work during a drain.

- Set `signal: 'SIGUSR2'` when the service manager starts the drain with `vitehub drain MAINPID [STATUS_URL]`, for example in systemd `ExecStop`.
- A lifecycle callback must return before an outside caller starts `drain()`. A `drain()` call from an active callback rejects.
- `close()` removes the signal listener after the drain ends, also after a failed drain.
- Keep the status endpoint up until `vitehub drain` sees the `drained` status. If the process exits before that, the drain failed.

## Shutdown

ViteHub packages register their stop work in a Nitro plugin. Apps do not call this API, but they set its budget. When a Node, Bun, or Deno server gets `SIGTERM` or `SIGINT`:

1. ViteHub runs every registered drain at the same time and keeps HTTP open.
2. Each drain gets the budget from `VITEHUB_SHUTDOWN_DRAIN_MS` (default `0`) and an `AbortSignal` that aborts when the budget ends. A drain that has not ended 15 seconds after the budget is reported as `timeout`.
3. The server closes HTTP, Nitro runs its `close` hooks for up to 10 seconds, and the process exits with code `0`.

Give the host a stop grace period longer than the budget plus 25 seconds. In development, during prerender, on serverless and Cloudflare hosts, and when graceful shutdown is off, ViteHub does not handle signals. The drains run when Nitro calls its `close` hooks.

`process.__vitehubShutdown` shows the registered drains, the signal, and the result of each drain. The logs have the events `shutdown.draining`, `shutdown.drained`, and `shutdown.exited`.

## Grants

ViteHub packages guard sensitive actions with grants. A check issues a grant, and the action requires it. Grants come from an internal entry and are not a public API. Apps do not use them.

- A grant is bound to what it allows, such as a path or a tool call.
- A grant from another definition, another bundled copy, or a forged object fails with `GRANT_REQUIRED`.
- Grants are request-scoped. Durable or resumed work runs the check again.

The [package README](https://github.com/vite-hub/vitehub/tree/main/packages/runtime#grants) shows how a package defines one.

## Entry points

| Import | Provides |
| --- | --- |
| `vite-hub/runtime` | Context, Capability, policy, approval, trace, lease, diagnostic, error, execution authority, public URL, and host binding APIs. |
| `vite-hub/runtime/h3` | `getRuntimeContext()`, `getStandardContext()`, and `installStandardContext()` for H3 events. |
| `vite-hub/runtime/node` | Node process data, reconciliation, and graceful drain. |

Do not import from `src`, `dist`, or `_internal` paths.
