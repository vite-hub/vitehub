---
title: Site access and Console links
description: Sign browsers in to your app from the Console, invite guests, open previews with one-time links, and link your pages to the Console.
navigation.title: Site access
navigation.order: 12
navigation.group: Use the Console
icon: i-lucide-door-open
---

## Sign browsers in

The [tools pill](/docs/comments/configure#turn-comment-mode-on-and-off) on your app's pages, with Comments and the **Console** link, shows to people the app knows. With [Auth](/docs/auth), **Site access** in the Console signs browsers in to the app for you:

- **Open site** opens the app in a new tab, signed in as the app user with the email of your Console account. Site access makes that user when there is none.
- **Link a phone** shows a QR code. The phone's camera opens the link, and the phone is signed in as you. The code works for 10 minutes.
- **Invite someone** makes a link for a guest. You give them a name, which becomes the author of their comments, and pick what they can do, such as **Write comments**. The link works once, in one browser, for 1, 7, or 30 days. It signs the browser in as a new app user with that name. Guests never get the **Console** link, and the Console never lets them in.

The people are Better Auth users, and each browser is a Better Auth session, so your app's session settings decide how long it lasts: Better Auth's default is 7 days, renewed once a day while the browser uses it. What they may do are roles of Better Auth's [`admin()` plugin](https://www.better-auth.com/docs/plugins/admin), in the comma-separated `user.role`, so Site access needs `admin()` in the `plugins` of `defineAuth()`:

- A member gets the `console` role, which shows the **Console** link, and the roles of every page tool.
- A guest gets the `guest` role and the roles that you picked. Comments offers `comments-read`, `comments-write`, `comments-resolve`, and `comments-delete`, and [checks them](/docs/comments/configure#roles-from-site-access).

A guest user has no password and a placeholder email, `guest-<id>@guests.invalid`. Better Auth runs your `databaseHooks.user.create` for them, so a hook that closes sign-up refuses guests too.

Each Site access link is a one-time link, made by the `site.link` or `site.invite` operation.

**Revoke** next to a browser in **Site access**, or `site.revoke-session`, signs it out. A guest has one browser, so revoking it also deletes the guest. Their comments keep their name. A guest is an app user with a session, so routes of your app that let in any signed-in user let them in too: check the role there.

| Operation | Does |
| --- | --- |
| `site.link` | Returns a one-time link that signs the browser in as you, then opens `path`, or the app home. `qr: true` makes it last 10 minutes. |
| `site.invite` | Returns a one-time link that signs a guest in with `name` and the roles in `grants`. `expiresInDays` is 1, 7 (the default), or 30. |
| `site.invites` and `site.revoke-invite` | List the invites that nobody opened yet, and revoke one. |
| `site.sessions` and `site.revoke-session` | List the browsers of members and guests, and sign one out. |
| `site.grants` | Lists the roles that Site access gives. |

## One-time links

Content preview, impersonation, and Site access need your app's origin: the page renders the draft, or the app sets its own session cookie. The Console page runs on another origin, so it opens them with a one-time link:

1. The Console calls an operation with a signed request, such as `documents.preview` or `auth.impersonate`. The operation checks the section, the grant, and the target, as any operation does.
2. The operation returns `{ url, expiresAt }`. `url` is `GET /_vitehub/rpc?ticket=<ticket>` on your app.
3. The Console opens `url` in a new tab. Your app redeems the ticket once and answers with the page: the draft preview, or a redirect to the app home with the session cookies.

| Operation | Opens | The app checks at redemption |
| --- | --- | --- |
| `documents.preview` | The page of a document with its saved draft. | The person may read the document. The page renders the draft through the [preview frame](/docs/content/preview). |
| `auth.impersonate` | The app home as the user. See [impersonation](/docs/auth/console#changes-and-limits). | The browser's app session has the email of the person and Better Auth's `impersonate` permission. |
| `auth.stop-impersonating` | The app home as the administrator again. | The browser impersonates for the person. |

A ticket is 32 random bytes. Your app keeps only its SHA-256, with the purpose, the app origin and mount, the person, the target, and the expiry. Redemption takes it out of the store first, so each ticket works once, also when two instances get it at the same time. A ticket works for 60 seconds. A used, expired, or changed ticket gets `401` with `CONSOLE_TICKET_INVALID`. A ticket that another app made, or that reaches a browser signed in to the app as another person, gets `403` with `CONSOLE_TICKET_MISMATCH`.

The store is the verification table of Better Auth, so the app needs [Auth with a Database](/docs/auth/configure#keep-users-in-the-app-database). A development server without one keeps tickets in memory. A production app without one refuses tickets with `500` and `CONSOLE_TICKET_STORE_MISSING`.

## Link to the Console

`hostedConsoleUrl()` from `vite-hub/runtime` builds a link to one page of a project in the Console. `consoleInvocationUrl()` and GitHub pull request comments use it. It encodes both values, and throws a `TypeError` for a project URL or a path that the Console refuses:

```ts
import { hostedConsoleUrl } from 'vite-hub/runtime'

hostedConsoleUrl('https://app.example.com', '/agents/support/invocations/abc')
// https://console.vitehub.dev/open?project=https%3A%2F%2Fapp.example.com&path=%2Fagents%2Fsupport%2Finvocations%2Fabc
```

- `project` is the app origin, with its base path if it has one, such as `https://app.example.com/portal`.
- `path` is the page in the Console, such as `/kv` or `/agents/<agent>/invocations/<id>`. It must start with one `/`.

The Console opens that page of the app of your team whose URL is `project`. When your team has not linked the app, the link opens Home. A self-hosted Console takes its origin as the third argument, such as `hostedConsoleUrl(url, '/kv', 'https://console.example.com')`.

## Open the Console from your pages

With `console` set, the tools pill on your app's pages has a **Console** segment. It is a link. It opens your app in [console.vitehub.dev](https://console.vitehub.dev) in a new tab, with `hostedConsoleUrl()`, the page origin, and the app base. When the page shows one Content document, through [`contentField()`](/docs/content/server-api#field-addresses) attributes, the link opens that document. Otherwise it opens the project overview. The app does not need Comments for this.

The link gives no access. The Console checks the person and the team when it opens the link. The pill still keeps the link away from the app's other users:

| Where | Who sees **Console** |
| --- | --- |
| Development server | Every visitor. |
| Production, with [`console.authorize`](/docs/console/access) | Visitors for whom `authorize` returns `true`, or `{ sections }` with one section or more. `authorize` gets `via: 'page'`, the session request of the page, and the app's Auth `user` when someone signed in. |
| Production, without `authorize` | App Auth users with the admin role of Better Auth's `admin()` plugin, or the `console` role that Site access gives. [Give the first admin role](/docs/auth/configure#give-the-first-admin-role) with `VITEHUB_ADMINS` or a claim code. Without app Auth, nobody. |

```ts [server/console-authorize.ts]
import { defineConsoleAuthorize } from 'vite-hub/console/auth'

export default defineConsoleAuthorize((context) => {
  // Show the Console link to every signed-in user of the app.
  if (context.via === 'page') return Boolean(context.user)
  // Every other caller keeps the access that it has without `authorize`.
  return true
})
```

An `authorize` that returns `true` for every context also shows the link to every visitor. Check `context.via` first.

The pill shows only when the page has a hint: `?vitehub` in the URL, the `vitehub-tools=1` cookie of an earlier visit, or a new app Auth session. On a development server without Auth, open a page with `?vitehub` once. A page on `http:` with a host that is not `localhost` or a loopback address, such as a LAN address, has no **Console** segment, because the Console cannot open that URL.
