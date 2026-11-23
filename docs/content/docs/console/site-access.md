---
title: Site access and Console links
description: Sign browsers in to your app from the Console, invite guests, open previews with one-time links, and link your pages to the Console.
navigation.title: Site access
navigation.order: 12
navigation.group: Use the Console
icon: i-lucide-door-open
---

From the Console you can open your app already signed in, sign in a phone and invite guests. One-time links open drafts and impersonation on your app's own origin, and your pages can link back to the Console.

With `console.authorize`, a member needs the `site` section. The result’s `grants` selects their [page tool roles](/docs/console/access#what-authorize-returns).

## Sign browsers in

With [Auth](/docs/auth) or [without it](#site-access-without-auth), **Site access** in the Console signs browsers in to the app for you:

| Action | What it does |
| --- | --- |
| **Open site** | Opens the app in a new tab as the app user with your Console account's email, and creates that user if needed. An app user with that email who never verified it is refused, because anyone can sign up with an email they do not own. |
| **Link a phone** | Shows a QR code, valid for 10 minutes, that signs the phone in as you. |
| **`/_vitehub`** | Signs in through the Console and returns to the page with the pill open. |
| **Invite someone** | Makes a link for a guest with the name that their comments show and the grants that you pick, such as **Write comments**. It works once, in one browser, for 1, 7 or 30 days, and creates a new app user. |

With Auth, each browser is a Better Auth session, so your session settings decide how long it lasts; Better Auth's default is 7 days, renewed daily while in use. Grants are roles in the comma-separated `user.role`, the field of Better Auth's [`admin()` plugin](https://www.better-auth.com/docs/plugins/admin). With `authDatabase()`, Auth adds this field for you, so you do not need `admin()`. With your own schema, add a nullable `role` text column to the `user` table and declare it, or add `admin()`:

```ts [server/auth.ts] fragment
export default defineAuth({
  database: drizzleAdapter(db, { provider: "sqlite", schema }),
  user: { additionalFields: { role: { type: "string", required: false, input: false } } },
})
```

`input: false` stops users from setting their own roles, and Site access refuses a `role` field without it. A member gets the `console` role, which shows the **Console** link, and the page tool roles allowed by `grants` (every page tool when `grants` is omitted). A guest gets `guest` and the roles that you picked, such as the `comments-read`, `comments-write`, `comments-resolve` and `comments-delete` roles that [Comments checks](/docs/comments/configure#roles-from-site-access).

A guest has no password and the email `guest-<id>@guests.invalid`, and never gets the **Console** link or into the Console. Better Auth runs your `databaseHooks.user.create` for guests, so a hook that closes sign-up refuses them too. **Revoke** next to a browser, or `site.revoke-session`, signs it out; for a guest, it also deletes the user, and their comments keep the name.

::warning
A guest is an app user with a session, so routes that let in any signed-in user let guests in too. Check the role there.
::

| Operation | Does |
| --- | --- |
| `site.link` | Returns a one-time link that signs the browser in as you and opens `path`, or the app home. `qr: true` makes it last 10 minutes. With the `state` of `/_vitehub`, it works only in the browser that opened `/_vitehub`. |
| `site.invite` | Returns a one-time link that signs a guest in with `name` and the roles in `grants`. `expiresInDays` is 1, 7 (the default) or 30. |
| `site.invites`, `site.revoke-invite` | List unopened invites, and revoke one. |
| `site.sessions`, `site.revoke-session` | List the browsers of members and guests, and sign one out. |
| `site.grants` | Lists the roles that Site access gives. |

Put `/_vitehub` after the app address, before the page path. `https://app.example.com/_vitehub/projects/meetups?task=x` comes back to `/projects/meetups?task=x`, and keeps its hash. A link to `/_vitehub` on a page of the app comes back to that page, from the `Referer` header. Without a page, `/_vitehub` comes back to the app home.

| Who opens it | What happens |
| --- | --- |
| You, on a development server | The page opens with `?vitehub`. The pill needs no sign-in there. |
| You, already signed in to the app through the Console | The page opens with `?vitehub`, without the Console. |
| Anyone else | The browser goes to the Console, which asks you to sign in when needed, signs the browser in to the app, and opens the page with `?vitehub`. |

`/_vitehub` comes back only to pages of the same app. ViteHub serves its own routes below `/_vitehub`, so these first path segments never come back to a page, and answer 404 when no ViteHub route matched: `.well-known`, `_vitehub`, `agent`, `agents`, `api`, `blob`, `channel-task`, `channels`, `comments`, `connections`, `console`, `content`, `forms`, `health`, `host`, `i`, `mcp`, `mcp-client`, `page`, `ready`, `realtime`, `rpc`, `schedule`, `warm`, and `webhook-queue`. For a page such as `/content/intro`, open the page and follow a link to `/_vitehub` from it.

## Site access without Auth

A docs site or another app without Auth gets Site access too. Opening the link sets the `vitehub_site` cookie instead of a Better Auth session. The cookie holds the person (the id, name, email, and image of your Console account, or the guest's name) and the roles: `console` and the roles allowed by `console.authorize` (every page tool role by default) for a member, `guest` and the picked roles for a guest. The page tools session, the **Console** link, and Comments read it after `identify` and the Auth session.

- The cookie is sealed with AES-GCM under a key that `VITEHUB_SECRET` gives for this purpose alone, so the browser cannot read or change it. It is `HttpOnly`, `SameSite=Lax`, `Secure` on HTTPS, and lasts 7 days. A changed cookie, a cookie of another secret, and an expired cookie count as no cookie.
- The app trusts the person and the roles in the cookie as much as the Console key: a signed Console call made the ticket.
- Each cookie names a session in the app's default KV store. **Revoke**, or `site.revoke-session`, deletes it, and the cookie stops working on the next request. `site.sessions` lists the sessions.
- It needs `VITEHUB_SECRET`, else `site.link` and `site.invite` fail with `500` and `CONSOLE_SITE_SECRET_MISSING`, and a KV store that takes a ticket out once (see [one-time links](#one-time-links)), else they fail with `CONSOLE_TICKET_STORE_MISSING`. A development server keeps sessions in memory.

## One-time links

A draft preview needs your app's origin to render, and a sign-in needs it to set the session cookie, but the Console runs on another origin. So it calls an operation with a signed request, which checks the section, the grant and the target, and gets back `{ url, expiresAt }`. It opens `url`, a `GET /_vitehub/rpc?ticket=<ticket>` on your app, in a new tab, and the app redeems the ticket once and answers with the draft or with a redirect home and the session cookies.

| Operation | Opens | The app checks at redemption |
| --- | --- | --- |
| `documents.preview` | A document's page with its saved draft, through the [preview frame](/docs/content/preview). | The person may read the document. |
| `auth.impersonate` | The app home as the user. See [impersonation](/docs/auth/console#changes-and-limits). | The browser's app session has the person's email and Better Auth's `impersonate` permission. |
| `auth.stop-impersonating` | The app home as the administrator again. | The browser impersonates for the person. |

A ticket works for 60 seconds and only once, even when two instances get it at the same time. A used, expired or changed ticket gets `401` with `CONSOLE_TICKET_INVALID`, and one from another app, or in a browser signed in as another person, gets `403` with `CONSOLE_TICKET_MISMATCH`.

The store is the verification table of Better Auth when the app has [Auth with a Database](/docs/auth/configure#keep-users-in-the-app-database). Without Auth, it is the app's default [KV store](/docs/kv) when its driver takes a key out once: Redis, Upstash, or the `database` driver. Cloudflare KV, Deno KV, and `fs-lite` cannot, because two instances could both read a ticket before either deletes it. A development server without a store keeps tickets in memory. A production app without one refuses tickets with `500` and `CONSOLE_TICKET_STORE_MISSING`.

## Link to the Console

```ts
import { hostedConsoleUrl } from 'vite-hub/runtime'

hostedConsoleUrl('https://app.example.com', '/agents/support/invocations/abc')
// https://console.vitehub.dev/open?project=https%3A%2F%2Fapp.example.com&path=%2Fagents%2Fsupport%2Finvocations%2Fabc
```

`hostedConsoleUrl()` builds a link to one Console page of a project, as Agent invocation links and GitHub pull request comments do. The first argument is the app origin with any base path, such as `https://app.example.com/portal`, and the second a Console path that starts with one `/`, such as `/kv` or `/agents/<agent>/invocations/<id>`. It encodes both. It throws `RUNTIME_CONSOLE_PROJECT_URL_INVALID` for a project URL and `RUNTIME_CONSOLE_PATH_INVALID` for a path that the Console refuses. A self-hosted Console takes its origin as a third argument, such as `hostedConsoleUrl(url, '/kv', 'https://console.example.com')`.

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

When you set `vitehub({ publicUrl })`, a build shows the pill only on that origin. Another hostname of the same deployment, such as a domain that serves user uploads, gets no pill, and `/_vitehub` and the page tools route answer `404` there. Other ViteHub routes, such as `/_vitehub/rpc`, Realtime, Channels, and webhooks, answer on every hostname. A `localhost` or `127.0.0.1` host and a development server always get the pill.

The link adds the [page tools script](/docs/comments/configure#turn-comment-mode-on-and-off) to every HTML page, about 320 bytes inline. To leave the link and the script out, set `pill: false`:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    console: { pill: false },
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'
import { nitro } from 'nitro/vite'

export default defineConfig({
  plugins: [vitehub({
    console: { pill: false },
  }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({
    console: { pill: false },
  })],
})
```
:::
::

The pages then have no page tools script, unless Comments is on. The Console has no **Site access** section, because Site access opens the app with the pill.

## Site access from the terminal

Each operation is also a [`vitehub` command](/docs/cli/inspect#run-any-operation). Without `--url`, it calls your development server. With `--url https://app.example.com` and a [Console key](/docs/console/signed-requests), it calls the deployed app.

```bash [Terminal]
pnpm vitehub site sessions
pnpm vitehub site revoke <id> --yes
pnpm vitehub site invite Ana --grants comments-write --expires-in-days 7
pnpm vitehub site invites
pnpm vitehub site revoke-invite <id> --yes
pnpm vitehub site grants
```

`vitehub site sessions` prints the id, kind, person, device, last use, and expiry of each browser. `--json` prints the operation result.

`vitehub site open [path]` runs `site.link`, but a command cannot sign a browser in as you. The link opens the app as the person who asks, and a command signs its calls with a key, not as a person. A development server knows you only as the local developer, without an email. So the command fails with `403` and `CONSOLE_TICKET_NO_PERSON`, and so does `vitehub site invite` against a deployed app, since an invite records the member who made it:

- For a deployed app, use **Open site**, **Link a phone**, or **Invite someone** in the Console.
- On a development server, which the Console cannot reach, invite your own browser as a guest with the roles you need: `vitehub site invite Me --grants comments-read,comments-write`, then open the link that it prints in a browser on the same machine, since the development server answers only this machine. `vitehub site grants` lists the roles.
