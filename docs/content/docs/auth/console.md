---
title: Auth Console
description: Inspect auth activity, sign-in counts, users, sessions, organizations, and approved clients.
navigation.title: Console
navigation.order: 7
icon: i-lucide-users-round
---

The Auth section is at `/_vitehub/auth` on your app's origin. It appears when the app has a primary Auth Definition. It needs a Better Auth database adapter to read stored data. Stateless Auth shows why the data is unavailable.

Enable and protect the [Console](/docs/development/console). The section id for `console.authorize` is `auth`. That scope covers every Auth page and management request. Console access permits inspection. Changes also need a signed-in session from the primary Auth Definition and the matching Better Auth permissions. A separate Console login does not grant app admin rights.

## Pages

- **Overview** is the section index. It shows users, new users in the last seven days, active sessions, and approved agents when the OAuth provider plugin is enabled. With events enabled, it adds active users in the last seven days, daily sign-ins and sign-ups for 30 UTC days, sign-in methods, and the eight latest events.
- **Activity** lists events newest first. Filter by Sign-in, Admin actions, Agents, or Organizations, and by the subject user ID. Next and Previous use cursors. New events do not shift later pages. Refresh returns to the newest page. Actor and subject names link to the user panel. Deleted users keep their IDs in the log.
- **Users** searches names and email addresses, filters admins, banned users, or users with approved clients, and loads one page at a time. Open a user to inspect their profile, declared fields, sessions, linked accounts, organizations, approved clients, and recent events. View all opens Activity with that subject user selected.
- **Sessions** shows active sessions, devices, creation dates, and expiry dates. Revoke a session by its id.
- **Organizations** appears with the Better Auth organization plugin. Open an organization to read members, roles, and pending invitations.
- **Agents** appears with the OAuth provider or MCP plugin. It shows each user's approved clients and scopes. Last use is `Unknown` when the provider does not record it.

Active users are distinct users who completed a recorded sign-in in the last seven days. A session created at sign-up counts. The chart includes today and the previous 29 UTC days. The current day is incomplete. Method shares use recorded sign-ins in this chart window. Event counts cover retained records only, with no backfill. The default retention is 90 days or 100,000 events.

Users and new users come from the current user database. Active sessions count unexpired database sessions. This count is unavailable when the app keeps sessions only in secondary storage. Approved agents counts consent grants, one per user and client.

## Enable events

Overview and Activity stay visible without an event store. They show the required setup. Overview still shows totals from the Auth database.

Add `events.store` to `defineAuth()` in your Auth Definition. This example uses a SQLite Database Definition named `auth`. Keep the app's existing Better Auth adapter and options.

```ts [server/auth.ts]
import { createDatabaseAuthEventStore, defineAuth } from 'vite-hub/auth'
import { useDatabase } from 'vite-hub/database/drizzle'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'

export default defineAuth(() => {
  const { db, schema } = useDatabase('auth')
  return {
    database: drizzleAdapter(db, { provider: 'sqlite', schema }),
    emailAndPassword: { enabled: true },
    events: { store: createDatabaseAuthEventStore({ db }) },
  }
})
```

The event store supports Node SQLite and Cloudflare D1. It records new events after setup. Read the [event log contract](/docs/auth/events) for retention, event coverage, and storage failure limits. The Console checks `console.authorize` for the `auth` section before reading either store. `events.authorize` controls the separate CLI endpoint and is not required for the Console.

Activity returns event IDs, types, times, and actor and subject names and IDs. It does not send event metadata, IP addresses, tokens, or secret values to the client.

## Declare fields and policy

Better Auth `user.additionalFields` become columns and profile fields. Fields with `returned: false` stay private. All fields start read-only. Opt in to editing each field under `console.fields`.

```ts [server/auth.ts]
import { defineAuth } from 'vite-hub/auth'
import { admin, organization } from 'better-auth/plugins'
import { countProjectsByUser } from './projects'

export default defineAuth({
  plugins: [admin(), organization()],
  user: {
    additionalFields: {
      plan: { type: ['free', 'pro'], defaultValue: 'free', required: false },
    },
  },
  console: {
    fields: {
      plan: { label: 'Plan', editable: true },
    },
    columns: {
      projects: {
        label: 'Projects',
        type: 'number',
        async read(users) {
          // Return one value per user id. ViteHub calls this once per page.
          return countProjectsByUser(users.map(user => user.id))
        },
      },
    },
    roles: { editable: false, reason: 'Roles come from the app directory.' },
    actions: {
      impersonate: { editable: false, reason: 'Use the support account flow.' },
    },
    access: [
      'Only invited email addresses can sign in.',
      'Members of the configured GitHub organization can sign in.',
    ],
  },
})
```

Computed columns receive public core Better Auth users and return values keyed by user id. They run on the server. Their types are `string`, `number`, `boolean`, or `date`. Computed values are read-only. A computed key cannot replace an additional field.

Additional fields use the Better Auth field type. Strings, enum choices, numbers, booleans, dates, and string or number arrays have editors. Other types are shown as JSON and stay read-only. Fields with `input: false` can still be edited by an admin when the app sets `editable: true`; Better Auth's admin update API owns that operation.

A field policy accepts `label`, `editable`, and `reason`. `roles` and each entry in `actions` accept `false` or `{ editable: false, reason }` to deny an action. `true` keeps the Better Auth capability; it cannot grant a missing permission. Supported action keys are `ban`, `unban`, `remove`, `revokeSession`, `revokeSessions`, `setRole`, `editField`, `impersonate`, and `revokeConsent`.

`access` contains display text only. It does not enforce sign-in rules. Define those rules in Better Auth and your app's route authorization.

The `console` option also works in a request-time Auth Definition callback. It has no Nuxt, Vite, or Console host dependency. Apps with external roles can mirror those fields into Better Auth and mark them read-only with a source note.

## Changes and limits

Ban, unban, remove, role changes, field edits, session revocation, and impersonation call Better Auth plugin APIs. They do not write through the adapter. Better Auth checks the current app session and runs its hooks. A successful action returns an actor receipt in the form `user:<id>`.

The client never receives session tokens, account passwords, access tokens, refresh tokens, or OAuth client secrets. Session revocation resolves the stored token on the server. Impersonation forwards only Better Auth's HttpOnly cookies and opens the app.

Better Auth OAuth Provider 1.7.7 has no admin endpoint that revokes one user's grant. Its consent-delete endpoint is owner-only and does not revoke issued tokens. The Console shows Revoke disabled with this reason. It does not impersonate users or delete token rows to bypass the provider.

Session lists read the Better Auth session table. Sessions kept only in secondary storage cannot be enumerated. Set `session.storeSessionInDatabase: true` when using secondary storage to inspect those sessions.

Lists use a default page size of 25 and a maximum of 100. Search and the approved-client filter read matching ids in batches because Better Auth adapters do not share a join query API. Plain user and session pages use database pagination. User detail shows the first 100 linked accounts and organization memberships. Session and approved-client lists have pagination. Organization members and invitations also have pagination.

## Inspect from code

Use the same reader from trusted server code:

```ts
import { getAuthConsoleForRequest } from 'vite-hub/auth/server'

const inspect = getAuthConsoleForRequest(request)
const [error, users] = await inspect.users({ search: 'ada', offset: 0, limit: 25 })
if (error) throw error
for (const user of users.items) console.log(user.email, user.fields)
```

Operations return `[error, data]`. Errors have a typed code, a cause for server diagnostics, and a link to [Auth errors](/docs/auth/limits-and-errors).

`inspect.overview()` returns the same totals, chart data, and recent events as Overview. `inspect.activity({ group: 'admin', userId: 'user-id', limit: 25 })` returns safe display records and a `nextCursor`. Pass that cursor with the same filters for the next page.

Manual hosts can use `createAuthConsole(auth, consoleOptions, eventStore)` from `vite-hub/auth/console-runtime`. `auth` is the app's Better Auth instance. Pass the same store as `events.store`, or omit it to disable event reads. Read methods do not check HTTP access themselves. A host must check its access policy before exposing them in a route.

Use `inspect.execute(action, request)` for the same policy and permission checks as the Console, or call Better Auth's own API from trusted code. No separate CLI is needed for these operations.
