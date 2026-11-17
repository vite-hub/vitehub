---
title: Run work one at a time with locks and leases
seo.title: "Locks and leases: run server work one at a time"
description: Stop a sync, a report, or a leader job from running twice at once on several servers, and choose between kv.lock() and a lease.
navigation.title: Locks and leases
navigation.order: 27
navigation.group: Server work
icon: i-lucide-lock
---

When an app runs on more than one server, or a client sends the same request twice, the same work can start twice at the same time. Two syncs write the same rows. Two reports send the same email. A lock or a lease lets one runner do the work while the others skip it or wait.

- A **lock** is a key that one runner holds for a fixed time. [`kv.lock()`](/docs/kv/server-api#locks) keeps it in KV.
- A **lease** is a lock that its holder can extend and that you can inspect. `createSqlLeaseStore()` from `vite-hub/runtime` keeps it in a SQL Database.

Both end at a release or when their time passes, so a server that crashes blocks the key only until then.

## Choose one

| You need | Use |
| --- | --- |
| A Schedule that runs once per time on several servers | Nothing. The [Schedule](/docs/schedule/configure#run-on-more-than-one-server) Process Runtime takes a lease for each occurrence. |
| A retried webhook or request that does its work once, and repeats that get the first result | [`withIdempotency()`](/docs/database/server-api#run-work-once-for-a-key) from `vite-hub/database` |
| A job that must not run twice at once and ends in a known time | [`kv.lock()`](#lock-a-short-job) |
| Work that runs longer than you can predict, one leader among servers, or a holder that you can see | [A lease](#hold-a-lease-for-long-work) |
| A limit on how often a user or an IP calls a route | [Rate Limit](/docs/rate-limit) |
| Background jobs that one consumer handles at a time | [Queue](/docs/queue) with `concurrency: 1` |

A lock or a lease stops two runs at the same time. It does not stop a second run after the first one ended. When a repeat must not run at all, use `withIdempotency()`.

## Lock a short job

`kv.lock(key, { ttl })` gives the key to one runner. `run()` takes the lock, calls your function, and releases the lock, also when the function throws:

```ts [server/api/sync/github.post.ts]
import { defineEventHandler, HTTPError } from 'h3'
import { kv } from 'vite-hub/kv'

async function syncGitHubIssues() {
  const response = await fetch('https://api.github.com/repos/vite-hub/vitehub/issues?per_page=100')
  const issues: { number: number, title: string }[] = await response.json()
  return issues.length
}

export default defineEventHandler(async () => {
  const [error, result] = await kv.lock('sync:github-issues', { ttl: 60 }).run(syncGitHubIssues)
  if (error) throw new HTTPError({ status: 503, message: error.why })
  if (!result.acquired) return { skipped: true }
  return { synced: result.value }
})
```

- `ttl` is required, in seconds. Pick a value longer than the work. A lock does not renew, so when the work runs longer than `ttl`, another runner can take the key while the first one still runs.
- `wait` is optional, in seconds. Without it, a held lock returns `{ acquired: false }` at once. With it, `run()` tries again until the lock is free or `wait` ends.
- The `redis`, `upstash`, and `database` KV drivers support locks. Cloudflare KV, Deno KV, and `fs-lite` return `KV_UNSUPPORTED_OPERATION` and do not call your function. On Cloudflare, give the KV store the `upstash` driver (see [KV configuration](/docs/kv/configure)), or use a lease.

## Hold a lease for long work

A lease lives in the `vitehub_leases` table of a Postgres or SQLite Database, which every server of the app shares. Create the store once:

```ts [server/utils/leases.ts]
import postgres from 'postgres'
import { createSqlLeaseStore } from 'vite-hub/runtime'

const sql = postgres(process.env.DATABASE_URL!)

export const leases = createSqlLeaseStore({
  dialect: 'postgresql',
  query: (text, params) => sql.unsafe(text, params),
})
```

Then acquire the lease, renew it while the work runs, and release it at the end:

```ts [server/api/reindex.post.ts]
import { defineEventHandler, HTTPError } from 'h3'
import { leases } from '../utils/leases'

async function reindexSearch() {
  for (const page of ['getting-started', 'guides', 'reference']) {
    await fetch(`https://search.example.com/index/${page}`, { method: 'POST' })
  }
}

export default defineEventHandler(async () => {
  const [error, lease] = await leases.acquire('search:reindex', { ttl: 30, owner: process.env.HOSTNAME ?? 'local' })
  if (error) throw new HTTPError({ status: 503, message: error.why })
  if (!lease) return { skipped: true }

  const renewal = setInterval(() => void lease.renew(), 10_000)
  try {
    await reindexSearch()
    return { reindexed: true }
  }
  finally {
    clearInterval(renewal)
    await lease.release()
  }
})
```

- `acquire()` returns `[error, lease]`. `lease` is `null` when another runner holds the key. Leases are not reentrant: the same `owner` also gets `null`.
- `renew({ ttl? })` moves the end of the lease. It returns `false` when the lease expired and another runner took it. Stop the work then.
- `get(key)` returns the live lease with its `owner` and `expiresAt`, or `null`. Use it to show who runs a job.
- `owner` is a label for inspection, such as the server name. `acquire()` does not compare it.
- Expiry uses the clock of the Database, not the clocks of the servers.

On libSQL, pass `{ dialect: 'sqlite', query: async (sql, args) => (await client.execute({ sql, args })).rows }`. On `node:sqlite`, pass `{ dialect: 'sqlite', query: async (sql, params) => db.prepare(sql).all(...params) }`. Do not share a local libSQL `file:` client between several processes: it can lose writes after `SQLITE_BUSY`. For one process and for tests, use `createMemoryLeaseStore()`.

The [runtime README](https://github.com/vite-hub/vitehub/tree/main/packages/runtime#leases) shows the SQL that creates the table, for a Database where the app role cannot run `CREATE TABLE`.

## Lock or lease

| | `kv.lock()` | Lease |
| --- | --- | --- |
| Store | KV on `redis`, `upstash`, or `database` | Postgres, or SQLite 3.35 or later |
| Extend while the work runs | No | `renew()` |
| See who holds the key | No | `get()` |
| Release after a crash | After `ttl` | After `ttl` |
| Errors | `KV_UNSUPPORTED_OPERATION`, `KV_OPERATION_FAILED` | `RUNTIME_LEASE_FAILED`, `RUNTIME_LEASE_INVALID_TTL` |

Neither one can stop a runner that paused longer than its `ttl`, such as a server that froze, from writing after another runner took the key. When a late write does damage, make the write itself safe: check a version column in the `UPDATE`, or use `withIdempotency()`.
