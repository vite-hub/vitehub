---
title: Auth event log
description: Record auth changes and read activity or daily sign-in counts from SQLite and D1.
navigation.title: Event log
navigation.order: 8
icon: i-lucide-history
---

## Enable the log

Auth events are opt-in. Set `events.store` on the Auth Definition. Apps that omit `events`, or set it to `false`, do not create event tables or load a database for the log.

Use the same SQLite Drizzle database that the app already uses, or a separate one. The store uses the `run` and `all` contract used by the Env and Connections stores. It works with Node SQLite, libSQL, and Cloudflare D1. It does not support Postgres.

This example assumes a discovered `auth` Database Definition with the Better Auth tables in its schema. Keep the existing Better Auth adapter and migrations.

```ts [server/auth.ts]
import { createDatabaseAuthEventStore, defineAuth } from '@vite-hub/auth'
import { useDatabase } from '@vite-hub/database/drizzle'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'

export default defineAuth(() => {
  const { db, schema } = useDatabase('auth')
  return {
    database: drizzleAdapter(db, { provider: 'sqlite', schema }),
    emailAndPassword: { enabled: true },
    events: {
      store: createDatabaseAuthEventStore({ db }),
    },
  }
})
```

The store creates `vitehub_auth_events` and four indexes on first use. There are no foreign keys to Better Auth users or sessions, so deletion of a user does not remove their history. Give the database role permission to create this table and its indexes. Each app must use its own event database. The table does not have a tenant namespace.

Better Auth 1.7.7 has a last-login-method plugin, but no bundled local audit log. ViteHub adds a plugin after the app's plugins and keeps the app's database hooks. Better Auth still owns authentication and authorization.

## Read events from code

```ts
import { aggregateAuthEvents, listAuthEvents } from '@vite-hub/auth/server'

const first = await listAuthEvents({
  type: 'user.signed_in',
  userId: 'user-id',
  from: '2026-10-01T00:00:00.000Z',
  to: '2026-11-01T00:00:00.000Z',
  limit: 50,
})
const next = first.nextCursor
  ? await listAuthEvents({ userId: 'user-id', type: 'user.signed_in', cursor: first.nextCursor })
  : undefined

const overview = await aggregateAuthEvents({
  from: '2026-10-01T00:00:00.000Z',
  to: '2026-11-01T00:00:00.000Z',
})
```

Pass an Auth Definition as the second argument when it is not discovered by Vite. `getAuthEvents(definition?, request?)` returns its store, or `undefined` when disabled. Pass a request when the Definition needs request context. You can also call `store.list()` and `store.aggregate()` directly. The structured readers throw `AUTH_R0018` when the log is disabled.

`list()` accepts `type`, `userId`, `actor`, `from`, `to`, `cursor`, and `limit`. Combine filters with AND. `from` is inclusive and `to` is exclusive. Times are ISO timestamps, returned in UTC. Keep the same filters on each page. The default limit is 50, and the maximum is 200. Events are ordered by time and then ID, newest first. The cursor contains both values, so it still works after retention removes its event. New events do not shift later pages.

After initialization, a list call runs one SQL query. An aggregate call runs one statement so all counts share a snapshot. Neither loads user records. Indexes cover time, type, subject user, and actor. Aggregates accept a window of at most 366 days and return UTC days, including days with zero events, plus totals for the full window:

```ts
{
  days: [{ day: '2026-10-01', signUps: 12, signIns: 48, activeUsers: 31,
    methods: { 'email-password': 30, 'oauth:github': 18 } }],
  totals: { signUps: 12, signIns: 48, activeUsers: 31,
    methods: { 'email-password': 30, 'oauth:github': 18 } },
}
```

Active users are distinct users with a completed sign-in in the window. A user who signs in on two days counts once in `totals.activeUsers`. A session created at sign-up counts as a sign-in. Session refresh, a pending two-factor challenge, and impersonation do not count. This metric does not count page views or the use of an existing session. For a 30-day active-user count, request a 30-day window. Counts cover retained events only, starting when logging was enabled. There is no backfill.

Server readers do not authorize HTTP callers. Guard a route before returning their results. The Console has the same responsibility.

## Read from the CLI

The Auth Vite Integration contributes `vitehub auth events`. It calls the app's Auth route. Enable this read endpoint with `events.authorize`, using the app's own access policy:

```ts
import type { AuthEventsConfiguration } from '@vite-hub/auth'

const events: AuthEventsConfiguration = {
  store,
  authorize: ({ user }) => user.role === 'admin',
}
```

Without `authorize`, no event HTTP endpoint is registered. When enabled, `GET <auth-base-path>/vitehub/events` requires a session read from the authoritative store and an explicit `true` result. A normal user's session is not sufficient unless your policy permits it. Responses use `Cache-Control: no-store`.

Set `VITEHUB_AUTH_COOKIE` to an authorized session cookie in the shell environment. Do not put it in a command argument or shared log. Set `VITEHUB_AUTH_URL`, or pass the full Auth base URL with `--url`:

```sh
vitehub auth events --url http://localhost:5173/api/auth --type user.signed_in --limit 50
vitehub auth events --url http://localhost:5173/api/auth --user user-id --actor user:admin-id
vitehub auth events --url http://localhost:5173/api/auth --aggregate \
  --from 2026-10-01T00:00:00.000Z --to 2026-11-01T00:00:00.000Z
```

Output is JSON. List commands also accept `--from`, `--to`, and `--cursor`. The CLI requires HTTPS except on loopback hosts, does not follow redirects, and times out after 30 seconds. It uses the same store readers as server code.

## Event fields

Each event has `id`, `type`, `time`, `actor`, `userId`, and `metadata`. The actor is `user:<id>` or `system`. The subject is a user ID, or `null` for a failed sign-in. Impersonated actions name the initiating admin as actor.

| Type | Metadata and trigger |
| --- | --- |
| `user.signed_up` | `method`. Better Auth creates a user, including admin provisioning with method `unknown`. |
| `user.signed_in` | `method`, coarse `device`, and `sessionId`. A new session completes authentication. |
| `user.signed_out` | `sessionId`. Sign-out deletes a stored session. |
| `sign_in.failed` | `method`. A sign-in endpoint returns a Better Auth API error. No email or attempted user ID is saved. |
| `session.revoked` | `sessionId`. A stored session is deleted outside sign-out or the end of impersonation. This includes ban and user-deletion cleanup. |
| `user.banned`, `user.unbanned` | No metadata. Admin ban, unban, or an admin update of `banned`. |
| `user.role_changed` | `role`. Admin changes the user's role. |
| `user.updated` | `fields`. Admin updates user fields or sets a password. Field values and ban reasons are omitted. |
| `user.removed` | No metadata. Better Auth deletes a user. |
| `impersonation.started`, `impersonation.stopped` | `sessionId`. Admin starts or stops impersonation. |
| `oauth.consent_granted`, `oauth.consent_revoked` | `clientId`. OAuth Provider persists, updates, or deletes an `oauthConsent` record through its request adapter. A denied consent does not count. |
| `organization.member_added` | `organizationId`, `memberId`, `role`. Add a member, accept an invitation, or create the owner membership. |
| `organization.member_removed`, `organization.member_role_changed` | `organizationId`, `memberId`, `role`. Remove a member, leave, or change a role. |

IP addresses are discarded. The raw user agent is never stored. `device` is `desktop`, `mobile`, `tablet`, `bot`, or `unknown`. Metadata uses a fixed set of fields. Unknown fields are removed before storage. Tokens, passwords, authorization codes, email addresses, and request bodies are not recorded.

Methods include `email-password`, `oauth:<provider-id>`, `email-otp`, `magic-link`, `username`, `phone-number`, `passkey`, `siwe`, `anonymous`, `two-factor`, and `unknown`. OAuth IDs must match a configured provider. `two-factor` identifies the final verification step; it does not claim to identify the first factor.

## Retention and failure behavior

The default keeps 90 days and at most 100,000 events. Set either limit, or set `retention: false` to keep all events:

```ts
createDatabaseAuthEventStore({
  db,
  retention: { maxAgeMs: 180 * 24 * 60 * 60 * 1000, maxRecords: 500_000 },
})
```

Like Connections activity, one DELETE follows each append and removes expired records and records beyond the count limit. Reads exclude events past the age limit even when there have been no new writes. Physical deletion resumes on the next append. There is no timer or background service. Use the same retention options for every store instance that uses a database.

An event write is awaited, but is separate from the auth mutation. If storage fails, Auth continues and writes the fixed warning `AUTH_EVENT_WRITE_FAILED` without provider error details. That event can be lost. This log is for activity and analytics; it is not an atomic or tamper-proof compliance ledger. A failed cleanup retries on the next append. Initialization retries after a failure.

Only operations that pass through the supported Better Auth hooks and endpoints are recorded. Direct SQL writes, bulk organization deletion cascades, and custom plugin paths are not covered. A stateless cookie has no stored session to revoke, so it cannot provide stored-session deletion events. Failed sign-ins rejected by a proxy, rate limiter, or earlier before-hook may not reach the recorder. Hosted OAuth-provider flows need their own application check; the local tests cover the provider's consent-adapter contract.

## Console runtime exports

`@vite-hub/auth/runtime/console` exports `readAuthEventConsoleRecords`, a zero-argument runtime reader that follows `@vite-hub/internal/console`. It returns at most 50 recent records, or an empty array when the log is disabled. It also exports `listAuthEvents` and `aggregateAuthEvents` for pages that need cursors or structured metrics. This package adds no Console UI.
