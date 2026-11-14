---
title: Auth Console
description: Inspect auth activity, sign-in counts, users, sessions, organizations, and approved clients.
navigation.title: Console
navigation.order: 8
icon: i-lucide-users-round
---

The Auth section of the [Console](/docs/console) appears when the app has a primary Auth Definition. To read stored data, it needs a Better Auth database adapter such as [`authDatabase()`](/docs/auth/configure#keep-users-in-the-app-database). With stateless Auth, it explains why the data is missing.

Turn on and protect the [Console](/docs/console). The section id for `console.authorize` is `auth`, and it covers every Auth page and management request. Console access lets you look. Changes also need a signed-in session from the primary Auth Definition and the matching Better Auth permissions. A Console account gives no app admin rights.

`console: { auth: false }` is for development. A production build with it fails. Set `console: true` and link the app in the Console at `https://console.vitehub.dev`, which shows the `VITEHUB_CONSOLE_KEY_<NAME>` line to set.

Each page and action of the section is an operation on the Console RPC: `auth.describe`, `auth.overview`, `auth.activity`, `auth.users`, `auth.user`, `auth.sessions`, `auth.organizations`, `auth.organization`, and `auth.agents` read, and `auth.ban`, `auth.unban`, `auth.remove`, `auth.revoke-sessions`, `auth.revoke-session`, `auth.set-role`, `auth.edit-field`, and `auth.revoke-consent` change. `auth.impersonate` and `auth.stop-impersonating` return a [one-time link](/docs/console/site-access#one-time-links), because impersonation sets the session cookie on the app origin.

## Who makes Auth changes

The Console [signs](/docs/console/signed-requests) the person who calls, with their email. Changes run as the app user with that email, with the newest app session of that user that is not an impersonation, so Better Auth checks the permissions of that account and Activity records it as the actor. The session never leaves the server.

- Without an app user with that email, changes are refused with `403`: "No app user has the email of your Console account".
- Without a live app session of that user, changes are refused with `401`. Sign in to the app as that user once, then try again.
- The CLI signs no person, so `vitehub auth ban` and the other changes are refused with `403`. The CLI can still read.

`auth.describe` says why each action is off, so the Console disables the buttons with the same reason.

## Pages

- **Overview** shows users, new users in the last seven days, active sessions, and approved agents (with the OAuth provider plugin). With events on, it adds active users in the last seven days, daily sign-ins and sign-ups for 30 UTC days, sign-in methods, and the eight latest events.
- **Activity** lists events, newest first. Filter by Sign-in, Admin actions, Agents, or Organizations, and by subject user ID. Next and Previous use cursors, so new events do not shift later pages. Refresh goes back to the newest page. Actor and subject names link to the user panel. Deleted users keep their IDs in the log.
- **Users** searches names and emails, filters admins, banned users, or users with approved clients, and loads one page at a time. A user shows their profile, declared fields, sessions, linked accounts, organizations, approved clients, and recent events. View all opens Activity for that user.
- **Sessions** shows active sessions, devices, and creation and expiry dates. Revoke a session by its id.
- **Organizations** appears with the Better Auth organization plugin. It shows members, roles, and pending invitations.
- **Agents** appears with the OAuth provider or MCP plugin. It shows each user's approved clients and scopes. Last use is `Unknown` when the provider does not record it.

Active users are distinct users with a recorded sign-in in the last seven days, including sessions created at sign-up. The chart covers today, which is not complete, and the 29 UTC days before. Method shares use recorded sign-ins in this window. Counts cover only kept events, with no backfill. By default, the log keeps 90 days or 100,000 events.

Users and new users come from the user database. Active sessions count unexpired database sessions, so the count is missing when sessions live only in secondary storage. Approved agents counts consent grants, one per user and client.

## Enable events

Without an event store, Overview and Activity show the setup steps. Overview still shows totals from the Auth database.

Add `events.store` to `defineAuth()`. This example uses a SQLite Database Definition named `auth`. Keep your Better Auth adapter and options.

```ts [server/databases/auth/index.ts]
import { defineDatabase } from 'vite-hub/database'

export default defineDatabase({ name: 'auth', schema: {} })
```

```ts [server/auth.ts]
import { createDatabaseAuthEventStore, defineAuth } from 'vite-hub/auth'
import { authDatabase } from 'vite-hub/auth/database'
import { useDatabase } from 'vite-hub/database'

export default defineAuth(() => ({
  database: authDatabase('auth'),
  emailAndPassword: { enabled: true },
  events: { store: createDatabaseAuthEventStore({ db: useDatabase('auth').db }) },
}))
```

The event store supports Node SQLite and Cloudflare D1, and records events from setup on. The [event log](/docs/auth/events) page covers retention, which events it records, and storage failures. The Console checks `console.authorize` for the `auth` section before it reads either store. `events.authorize` controls only the CLI endpoint, so the Console does not need it.

Activity sends event IDs, types, times, and actor and subject names and IDs. It never sends event metadata, IP addresses, tokens, or secrets to the client.

## Declare fields and policy

Better Auth `user.additionalFields` become columns and profile fields. Fields with `returned: false` stay private. All fields are read-only until you allow editing in `console.fields`.

Use a Better Auth adapter and schema with those columns. [`authDatabase()`](/docs/auth/configure#keep-users-in-the-app-database) has a fixed `user` table and rejects `user.additionalFields` with `AUTH_C0055`.

```ts [server/auth.ts] fragment
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

Computed columns run on the server. They receive public core Better Auth users and return values keyed by user id, typed `string`, `number`, `boolean`, or `date`. They are read-only, and a computed key cannot replace an additional field.

Additional fields use their Better Auth type. Strings, enums, numbers, booleans, dates, and string or number arrays get editors. Other types show as read-only JSON. With `editable: true`, an admin can edit a field even when it has `input: false`. Better Auth's admin update API does the change.

- A field policy takes `label`, `editable`, and `reason`.
- `roles` and each entry in `actions` take `false` or `{ editable: false, reason }` to deny an action. `true` keeps the Better Auth permission but cannot add a missing one.
- Action keys are `ban`, `unban`, `remove`, `revokeSession`, `revokeSessions`, `setRole`, `editField`, `impersonate`, and `revokeConsent`.
- `access` is display text only. It does not enforce sign-in rules. Put those in Better Auth and your route authorization.

The `console` option also works in a request-time Auth Definition callback, and needs no Nuxt, Vite, or Console host. Apps with external roles can copy them into Better Auth fields and mark them read-only with a source note.

### Computed roles

When the app computes roles, for example from an environment variable, add `read` to `roles`. The Console shows those roles and the Admins filter uses them, also for users who have not signed in since the rule changed. It writes nothing.

```ts [server/auth.ts] fragment
console: {
  roles: {
    editable: false,
    reason: 'Admins come from ADMIN_EMAILS.',
    read: users => Object.fromEntries(users.map(user => [user.id, adminEmails.includes(user.email) ? 'admin' : 'user'])),
  },
},
```

`read` gets public core users and returns a role per user id, like a computed column. `null` keeps the stored role. The database cannot filter a computed role, so the Admins filter calls `read` for every user, 500 at a time. Impersonation refuses a user whose computed role is an admin role.

Better Auth's admin endpoints still check the signed-in admin's stored `user.role`. Write that role at sign-in, for example in a `session.create.after` database hook.

## Changes and limits

Ban, unban, remove, role changes, field edits, session revocation, and impersonation call Better Auth plugin APIs, not the adapter. Better Auth checks the current app session and runs its hooks. A successful action returns an actor receipt such as `user:<id>`.

The client never gets session tokens, account passwords, access or refresh tokens, or OAuth client secrets. Session revocation looks up the stored token on the server. Impersonation forwards only Better Auth's HttpOnly cookies and opens the app.

Impersonation is off until the host turns it on. In ViteHub, `console.impersonation: true` turns it on. It also needs `events.store`, so each start and stop is recorded. With it on, `describe(request)` returns `impersonation` with the session length and the user the session impersonates, and `user(id, request)` says if Better Auth accepts that user as a target. Server code passes `getAuthConsoleForRequest(request, event, { impersonation: true })`, and `inspect.stopImpersonating(request)` ends it.

In the Console, open a user and select **Impersonate**. The Console calls `auth.impersonate`, and a new tab opens the [one-time link](/docs/console/site-access#one-time-links) on your app. The app then checks the browser:

1. The browser must be signed in to the app with the email of your Console account. Otherwise the tab shows `CONSOLE_TICKET_MISMATCH`.
2. Better Auth must let that app session impersonate the user, with the `impersonate` permission of the admin plugin.

The app sets the impersonation session cookie and opens its home page as the user. **Stop impersonating** in the user panel opens a link that ends the impersonation of this browser and restores your session. The app's own UI can stop it too, with `stopImpersonating()` of `useUserSession()`.

With the admin plugin, Auth limits every impersonation session, whoever starts it:

- It never refreshes past its `impersonationSessionDuration`.
- It cannot create OAuth, MCP, or device grants, API keys, passkeys, passwords, email, phone number, or username changes, linked accounts, two-factor settings, one-time tokens, or another impersonation.
- It cannot unlink an account, or read or refresh a linked account's provider tokens through `/get-access-token`, `/refresh-token`, or `/account-info`.

Those requests return `403` with `IMPERSONATION_FORBIDDEN`, and so do server calls such as `auth.api.setPassword()` that use the impersonation session. Grant and client reads, such as `/oauth2/get-consents`, still work.

Better Auth OAuth Provider 1.7.7 has no admin endpoint to revoke one user's grant. Its consent-delete endpoint is owner-only and does not revoke issued tokens. So the Console shows Revoke as disabled, with this reason. It does not impersonate users or delete token rows to get around the provider.

Session lists read the Better Auth session table, so sessions only in secondary storage are not listed. To see them, set `session.storeSessionInDatabase: true`.

Lists show 25 items by default, up to 100. Better Auth adapters share no join query API, so search and the approved-client filter read matching ids in batches. Plain user and session pages use database pagination. User detail shows the first 100 linked accounts and organization memberships. Session, approved-client, member, and invitation lists have pagination.

## Inspect from code

Trusted server code can use the same reader:

```ts fragment
import { getAuthConsoleForRequest } from 'vite-hub/auth/server'

const inspect = getAuthConsoleForRequest(request)
const [error, users] = await inspect.users({ search: 'ada', offset: 0, limit: 25 })
if (error) throw error
for (const user of users.items) console.log(user.email, user.fields)
```

Operations return `[error, data]`. Errors have a typed code, a cause for server logs, and a link to [Auth errors](/docs/auth/limits-and-errors).

`inspect.overview()` returns the totals, chart data, and recent events of Overview. `inspect.activity({ group: 'admin', userId: 'user-id', limit: 25 })` returns safe display records and a `nextCursor`. For the next page, pass that cursor with the same filters.


::warning
Read methods do not check HTTP access. Check your access policy before you expose them in a route.
::

`inspect.execute(action, request)` runs the same policy and permission checks as the Console. Trusted code can also call Better Auth's API. These operations need no separate CLI.
