---
title: Site access and Console links
description: Sign browsers in to your app from the Console, invite guests, open previews with one-time links, and link your pages to the Console.
navigation.title: Site access
navigation.order: 12
navigation.group: Use the Console
icon: i-lucide-door-open
---

From the Console you can open your app already signed in, sign in a phone and invite guests. One-time links open drafts and impersonation on your app's own origin, and your pages can link back to the Console.

## Sign browsers in

With [Auth](/docs/auth), **Site access** in the Console signs browsers in to the app for you:

| Action | What it does |
| --- | --- |
| **Open site** | Opens the app in a new tab as the app user with your Console account's email, and creates that user if needed. |
| **Link a phone** | Shows a QR code, valid for 10 minutes, that signs the phone in as you. |
| **Invite someone** | Makes a link for a guest with the name that their comments show and the grants that you pick, such as **Write comments**. It works once, in one browser, for 1, 7 or 30 days, and creates a new app user. |

Each browser is a Better Auth session, so your session settings decide how long it lasts; Better Auth's default is 7 days, renewed daily while in use. Grants are roles of Better Auth's [`admin()` plugin](https://www.better-auth.com/docs/plugins/admin) in the comma-separated `user.role`, so Site access needs `admin()` in the `plugins` of `defineAuth()`. A member gets the `console` role, which shows the **Console** link, and the roles of every page tool. A guest gets `guest` and the roles that you picked, such as the `comments-read`, `comments-write`, `comments-resolve` and `comments-delete` roles that [Comments checks](/docs/comments/configure#roles-from-site-access).

A guest has no password and the email `guest-<id>@guests.invalid`, and never gets the **Console** link or into the Console. Better Auth runs your `databaseHooks.user.create` for guests, so a hook that closes sign-up refuses them too. **Revoke** next to a browser, or `site.revoke-session`, signs it out; for a guest, it also deletes the user, and their comments keep the name.

::warning
A guest is an app user with a session, so routes that let in any signed-in user let guests in too. Check the role there.
::

| Operation | Does |
| --- | --- |
| `site.link` | Returns a one-time link that signs the browser in as you and opens `path`, or the app home. `qr: true` makes it last 10 minutes. |
| `site.invite` | Returns a one-time link that signs a guest in with `name` and the roles in `grants`. `expiresInDays` is 1, 7 (the default) or 30. |
| `site.invites`, `site.revoke-invite` | List unopened invites, and revoke one. |
| `site.sessions`, `site.revoke-session` | List the browsers of members and guests, and sign one out. |
| `site.grants` | Lists the roles that Site access gives. |

## One-time links

A draft preview needs your app's origin to render, and a sign-in needs it to set the session cookie, but the Console runs on another origin. So it calls an operation with a signed request, which checks the section, the grant and the target, and gets back `{ url, expiresAt }`. It opens `url`, a `GET /_vitehub/rpc?ticket=<ticket>` on your app, in a new tab, and the app redeems the ticket once and answers with the draft or with a redirect home and the session cookies.

| Operation | Opens | The app checks at redemption |
| --- | --- | --- |
| `documents.preview` | A document's page with its saved draft, through the [preview frame](/docs/content/preview). | The person may read the document. |
| `auth.impersonate` | The app home as the user. See [impersonation](/docs/auth/console#changes-and-limits). | The browser's app session has the person's email and Better Auth's `impersonate` permission. |
| `auth.stop-impersonating` | The app home as the administrator again. | The browser impersonates for the person. |

A ticket works for 60 seconds and only once, even when two instances get it at the same time. A used, expired or changed ticket gets `401` with `CONSOLE_TICKET_INVALID`, and one from another app, or in a browser signed in as another person, gets `403` with `CONSOLE_TICKET_MISMATCH`.

Tickets live in Better Auth's verification table, so production needs [Auth with a Database](/docs/auth/configure#keep-users-in-the-app-database) or refuses them with `500` and `CONSOLE_TICKET_STORE_MISSING`. A development server without one keeps them in memory.

## Link to the Console

```ts
import { hostedConsoleUrl } from 'vite-hub/runtime'

hostedConsoleUrl('https://app.example.com', '/agents/support/invocations/abc')
// https://console.vitehub.dev/open?project=https%3A%2F%2Fapp.example.com&path=%2Fagents%2Fsupport%2Finvocations%2Fabc
```

`hostedConsoleUrl()` builds a link to one Console page of a project, as `consoleInvocationUrl()` and GitHub pull request comments do. The first argument is the app origin with any base path, such as `https://app.example.com/portal`, and the second a Console path that starts with one `/`, such as `/kv` or `/agents/<agent>/invocations/<id>`. It encodes both, and throws a `TypeError` for a URL or path that the Console refuses. A self-hosted Console takes its origin as a third argument, such as `hostedConsoleUrl(url, '/kv', 'https://console.example.com')`.

The link opens that page of your team's app with that URL, or Home when your team has not linked it.

## Open the Console from your pages

With `console` set, the [tools pill](/docs/comments/configure#turn-comment-mode-on-and-off) on your pages gets a **Console** segment. It opens the app in [console.vitehub.dev](https://console.vitehub.dev) in a new tab, at the Content document that the page shows through [`contentField()`](/docs/content/server-api#field-addresses) attributes, or at the project overview. Comments is not required.

The link grants nothing, because the Console checks the person and the team when it opens. The pill still hides it from the app's other users:

| Where | Who sees **Console** |
| --- | --- |
| Development server | Every visitor. |
| Production, with [`console.authorize`](/docs/console/access) | Visitors for whom `authorize` returns `true` or a non-empty `{ sections }`. It gets `via: 'page'`, the page's session request, and the app's Auth `user` when someone signed in. |
| Production, without `authorize` | App Auth users with the `admin()` admin role or the Site access `console` role. [Give the first admin role](/docs/auth/configure#give-the-first-admin-role) with `VITEHUB_ADMINS` or a claim code. Without app Auth, nobody. |

```ts [server/console-authorize.ts]
import { defineConsoleAuthorize } from 'vite-hub/console/auth'

export default defineConsoleAuthorize((context) => {
  // Show the Console link to every signed-in user of the app.
  if (context.via === 'page') return Boolean(context.user)
  // Every other caller keeps the access that it has without `authorize`.
  return true
})
```

An `authorize` that returns `true` for every context shows the link to every visitor, so check `context.via` first.

The pill shows only when the page has a hint: `?vitehub` in the URL, the `vitehub-tools=1` cookie of an earlier visit, or a new app Auth session. Without Auth on a development server, open a page with `?vitehub` once. A page on `http:` with a non-loopback host, such as a LAN address, has no **Console** segment, because the Console cannot open that URL.
