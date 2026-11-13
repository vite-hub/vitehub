---
title: Auth event log
description: Record auth changes and read activity or daily sign-in counts from SQLite and D1.
navigation.title: Event log
navigation.order: 9
icon: i-lucide-history
---

## Enable the log

The event log is off until you set `events.store` on the Auth Definition. Without it, Auth creates no event tables and loads no database for the log.

Use the app's SQLite Drizzle database or another one. Like the Env and Connections stores, it uses the `run` and `all` contract. It works with Node SQLite, libSQL, and Cloudflare D1, not Postgres.

Here, users and events share the `auth` Database. [`authDatabase('auth')`](/docs/auth/configure#keep-users-in-the-app-database) adds the Better Auth tables to it.

```ts [server/databases/auth/index.ts]
import { defineDatabase } from '@vite-hub/database'

export default defineDatabase({ name: 'auth', schema: {} })
```

```ts [server/auth.ts]
import { createDatabaseAuthEventStore, defineAuth } from 'vite-hub/auth'
import { authDatabase } from 'vite-hub/auth/database'
import { useDatabase } from 'vite-hub/database'

export default defineAuth(() => ({
  database: authDatabase('auth'),
  emailAndPassword: { enabled: true },
  events: {
    store: createDatabaseAuthEventStore({ db: useDatabase('auth').db }),
  },
}))
```

On first use, the store creates `vitehub_auth_events` and four indexes, so the database role needs create permission. The table has no foreign keys to users or sessions, so deleting a user keeps their history. It has no tenant namespace, so each app needs its own event database.

Better Auth 1.7.7 has a last-login-method plugin but no local audit log. ViteHub adds a plugin after your plugins and keeps your database hooks. Better Auth still owns authentication and authorization.

## Read events from code

```ts
import { aggregateAuthEvents, listAuthEvents } from 'vite-hub/auth/server'

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

Pass the Auth Definition as the second argument if Vite did not discover it. `getAuthEvents(definition?, request?)` returns its store, or `undefined` when the log is off. Pass a request if the Definition needs request context. `store.list()` and `store.aggregate()` also work. The readers throw `AUTH_R0018` when the log is off.

`list()` takes `type`, `userId`, `actor`, `from`, `to`, `cursor`, and `limit`:

- `type` is one event type or a non-empty array, matched with OR before pagination. Other filters combine with AND.
- `from` is inclusive and `to` is exclusive. Times are ISO timestamps, returned in UTC.
- Keep the same filters on each page. The limit defaults to 50, with a maximum of 200.
- Events are sorted by time, then ID, newest first. The cursor holds both, so it still works after retention removes its event. New events do not shift later pages.

A list call runs one SQL query. An aggregate runs one statement, so all counts share a snapshot. Neither loads user records. Indexes cover time, type, subject user, and actor. Aggregates take a window of up to 366 days and return each UTC day, including empty days, plus totals:

```ts fragment
{
  days: [{ day: '2026-10-01', signUps: 12, signIns: 48, activeUsers: 31,
    methods: { 'email-password': 30, 'oauth:github': 18 } }],
  totals: { signUps: 12, signIns: 48, activeUsers: 31,
    methods: { 'email-password': 30, 'oauth:github': 18 } },
}
```

Active users are distinct users who completed a sign-in in the window, so two days of sign-ins count once in `totals.activeUsers`. A session created at sign-up counts. Session refresh, a pending two-factor challenge, impersonation, page views, and use of an existing session do not. For 30-day active users, request a 30-day window. Counts cover only kept events since the log was turned on, with no backfill.

::warning
Server readers do not authorize HTTP callers. Guard the route, or the Console, before you return their results.
::

## Read from the CLI

The Auth Vite integration adds `vitehub auth events`, which calls the app's Auth route. Turn on this read endpoint with `events.authorize` and your own access policy:

```ts fragment
import type { AuthEventsConfiguration } from 'vite-hub/auth'

const events: AuthEventsConfiguration = {
  store,
  authorize: ({ user }) => user.role === 'admin',
}
```

Without `authorize`, there is no endpoint. With it, `GET <auth-base-path>/vitehub/events` needs a session read from the session store and a `true` result, so a normal user gets in only if your policy allows it. Successful reads send `Cache-Control: no-store`. The policy can return a `Response` to reject with its own status, headers, and body.

Put an authorized session cookie in the `VITEHUB_AUTH_COOKIE` shell variable, never in a command argument or shared log. Set `VITEHUB_AUTH_URL`, or pass the full Auth base URL with `--url`:

```sh
vitehub auth events --url http://localhost:5173/api/auth --type user.signed_in --limit 50
vitehub auth events --url http://localhost:5173/api/auth --user user-id --actor user:admin-id
vitehub auth events --url http://localhost:5173/api/auth --aggregate \
  --from 2026-10-01T00:00:00.000Z --to 2026-11-01T00:00:00.000Z
```

Output is JSON. List commands also take `--from`, `--to`, and `--cursor`. The CLI needs HTTPS except on loopback, does not follow redirects, and times out after 30 seconds. It uses the same readers as server code.

## Event fields

Each event has `id`, `type`, `time`, `actor`, `userId`, and `metadata`. The actor is `user:<id>` or `system`. `userId` is the subject, or `null` for a failed sign-in. In impersonated actions, the actor is the admin who started it.

| Type | Metadata and trigger |
| --- | --- |
| `user.signed_up` | `method`. Better Auth creates a user, also by admin provisioning, with method `unknown`. |
| `user.signed_in` | `method`, coarse `device`, and `sessionId`. A new session completes authentication. |
| `user.signed_out` | `sessionId`. Sign-out deletes a stored session. |
| `sign_in.failed` | `method`. A sign-in endpoint returns a Better Auth API error. No email or attempted user ID is saved. |
| `session.revoked` | `sessionId`. A stored session is deleted, other than at sign-out or the end of impersonation, including cleanup after a ban or user deletion. |
| `user.banned`, `user.unbanned` | No metadata. Admin ban, unban, or an admin update of `banned`. |
| `user.role_changed` | `role`. Admin changes the user's role. |
| `user.updated` | `fields`. Admin updates user fields or sets a password. Field values and ban reasons are omitted. |
| `user.removed` | No metadata. Better Auth deletes a user. |
| `impersonation.started`, `impersonation.stopped` | `sessionId`. Admin starts or stops impersonation. If the store cannot record a start, it does not start. |
| `oauth.consent_granted`, `oauth.consent_revoked` | `clientId`. OAuth Provider saves, updates, or deletes an `oauthConsent` record through its request adapter. Denied consent does not count. |
| `organization.member_added` | `organizationId`, `memberId`, `role`. Add a member, accept an invitation, or create the owner membership. |
| `organization.member_removed`, `organization.member_role_changed` | `organizationId`, `memberId`, `role`. Remove a member, leave, or change a role. |

The log never stores IP addresses, the raw user agent, tokens, passwords, authorization codes, email addresses, or request bodies. `device` is `desktop`, `mobile`, `tablet`, `bot`, or `unknown`. Metadata has a fixed set of fields, and unknown fields are removed.

Methods are `email-password`, `oauth:<provider-id>`, `email-otp`, `magic-link`, `username`, `phone-number`, `passkey`, `siwe`, `anonymous`, `two-factor`, and `unknown`. OAuth IDs must match a configured provider. `two-factor` names the last verification step, not the first factor.

## Retention and failure behavior

By default, the log keeps 90 days and at most 100,000 events. Set either limit, or `retention: false` to keep everything:

```ts fragment
createDatabaseAuthEventStore({
  db,
  retention: { maxAgeMs: 180 * 24 * 60 * 60 * 1000, maxRecords: 500_000 },
})
```

As with Connections activity, each append runs one DELETE for expired records and records over the count limit. Reads skip events past the age limit even before the next append deletes them. There is no timer or background service. Use the same retention options for every store instance on one database.

Auth waits for each event write, but the write is separate from the auth change. If storage fails, Auth continues and logs the fixed warning `AUTH_EVENT_WRITE_FAILED` without provider details, and the event can be lost. Except for `impersonation.started`: if it cannot be written, Auth deletes the new session and the request fails with `IMPERSONATION_NOT_RECORDED`. Failed cleanup retries on the next append, and failed setup retries too.

::warning
This log is for activity and analytics. It is not an atomic or tamper-proof compliance ledger.
::

The log records only operations through the supported Better Auth hooks and endpoints, not direct SQL writes, bulk organization deletion cascades, or custom plugin paths. A stateless cookie has no stored session, so it gives no session deletion events. Sign-ins that a proxy, rate limiter, or earlier before-hook rejects may not reach the log. Check hosted OAuth-provider flows in your app. The local tests cover only the provider's consent-adapter contract.

## Console runtime exports

`@vite-hub/auth/runtime/console` exports `listAuthEvents` and `aggregateAuthEvents`, for Console pages that need cursors or metrics. This package adds no Console UI.
