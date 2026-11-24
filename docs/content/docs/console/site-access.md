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

**Site access** in the Console signs browsers in to the app for you. The app needs no [Auth](/docs/auth), no database, and no store for it: the Console keeps the passes, the invites, and the codes, and the app checks a signed token.

| Action | What it does |
| --- | --- |
| **Open site** | Opens the app in a new tab, signed in as you. |
| **Link a phone** | Shows a QR code, valid for 10 minutes, that signs the phone in as you. |
| **`/_vitehub`** | Signs in through the Console and returns to the page with the pill open. |
| **Invite someone** | Makes a link for a guest with the name that their comments show and the roles that you pick, such as **Write comments**. It works once, in one browser, for 1, 7 or 30 days. |

A member gets the `console` role, which shows the **Console** link, and the page tool roles allowed by `grants` (every page tool when `grants` is omitted). Without `console.authorize`, a member keeps the roles in their token and gets any new roles from the app's current page tools on the next request. Turning off the Comments overlay does not remove signed Comments API permissions. With `authorize`, only the roles in the token apply until the Console signs the next one. A guest gets the roles that you picked, such as the `comments-read`, `comments-write`, `comments-resolve` and `comments-delete` roles that [Comments checks](/docs/comments/configure#roles-from-site-access). A guest never gets the **Console** link or into the Console.

The person and the roles live only in the app's site cookie. They are not app users, so routes that check the app's Auth session do not let them in. The page tools, the **Console** link, and Comments read the person of the site cookie.

**Revoke** next to a browser in the Console stops the Console from signing new tokens for it. The app keeps the cookie that it has until the cookie ends, at most 12 hours later. To sign every browser out at once, rotate the [Console key](/docs/console/signed-requests) of the app.

### How the app checks a visit

1. `GET /_vitehub/site?return=/docs` sets the `__Host-vitehub-site-state` cookie, a random state for this browser that lasts 10 minutes, and sends the browser to the Console's `/visit` with the SHA-256 of the state.
2. The Console checks the person, the team, and the pass, and asks the app for the person's Site access with the `site.access` operation. It then signs a token with the private key of the app's link, and sends the browser back to `GET /_vitehub/site?token=vst1.…`.
3. The app checks the token with the `VITEHUB_CONSOLE_KEY_<NAME>` public keys of its links. The token must be for the app URL, for the state of this browser, and not older than 60 seconds. The app then sets the `__Host-vitehub-site` cookie, which holds the token, and opens the page with `?vitehub`.
4. Each request checks the cookie with the same keys. The cookie ends 12 hours after the Console signed the token. After that, `/_vitehub` sends the browser through the Console again, which signs a new token while the person still has access.

The app refuses a token for another app, for another browser, an expired token, and a token of an unknown key with `401` and `CONSOLE_SITE_TOKEN_REFUSED`. The cookies are `HttpOnly`, `Secure`, and `SameSite=Lax`. A `POST` to `/_vitehub/site` from a page of the app signs the browser out. The account menu of the pill does it.

| Operation | Does |
| --- | --- |
| `site.access` | Returns the Site access of the caller: `write`, which follows write access to the `site` section, and `roles`, the page tool roles that the caller gets and may give guests. The Console calls it before it signs a token. |

Put `/_vitehub` after the app address, before the page path. `https://app.example.com/_vitehub/projects/meetups?task=x` comes back to `/projects/meetups?task=x`, and keeps its hash. A link to `/_vitehub` on a page of the app comes back to that page, from the `Referer` header. Without a page, `/_vitehub` comes back to the app home.

| Who opens it | What happens |
| --- | --- |
| You, on a development server | The page opens with `?vitehub`. The pill needs no sign-in there. |
| You, already signed in to the app through the Console | The page opens with `?vitehub`, without the Console. |
| Anyone else | The browser goes to `/_vitehub/site`, then to the Console, which asks you to sign in when needed, signs a token for the app, and opens the page with `?vitehub`. |

`/_vitehub` comes back only to pages of the same app. ViteHub serves its own routes below `/_vitehub`, so these first path segments never come back to a page, and answer 404 when no ViteHub route matched: `.well-known`, `_vitehub`, `agent`, `agents`, `api`, `blob`, `channel-task`, `channels`, `comments`, `connections`, `console`, `content`, `forms`, `health`, `host`, `i`, `mcp`, `mcp-client`, `page`, `ready`, `realtime`, `rpc`, `schedule`, `site`, `warm`, and `webhook-queue`. For a page such as `/content/intro`, open the page and follow a link to `/_vitehub` from it.

## One-time links

A draft preview needs your app's origin to render, and impersonation needs it to set the session cookie, but the Console runs on another origin. So it calls an operation with a signed request, which checks the section, the grant and the target, and gets back `{ url, expiresAt }`. It opens `url`, a `GET /_vitehub/rpc?ticket=<ticket>` on your app, in a new tab, and the app redeems the ticket once and answers with the draft or with a redirect home and the session cookies.

| Operation | Opens | The app checks at redemption |
| --- | --- | --- |
| `documents.preview` | A document's page with its saved draft, through the [preview frame](/docs/content/preview). | The person may read the document. |
| `auth.impersonate` | The app home as the user. See [impersonation](/docs/auth/console#changes-and-limits). | The browser's app session has the person's email and Better Auth's `impersonate` permission. |
| `auth.stop-impersonating` | The app home as the administrator again. | The browser impersonates for the person. |

A ticket works for 60 seconds and only once, even when two instances get it at the same time. A used, expired or changed ticket gets `401` with `CONSOLE_TICKET_INVALID`, and one from another app, or in a browser signed in as another person, gets `403` with `CONSOLE_TICKET_MISMATCH`.

The store is the verification table of Better Auth when the app has [Auth with a Database](/docs/auth/configure#keep-users-in-the-app-database). Without Auth, it is the app's default [KV store](/docs/kv) when its driver takes a key out once: Redis, Upstash, or the `database` driver. Cloudflare KV, Deno KV, and `fs-lite` cannot, because two instances could both read a ticket before either deletes it. A development server without a store keeps tickets in memory. A production app with none of these stores refuses tickets with `500` and `CONSOLE_TICKET_STORE_MISSING`.

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
| Production, with [`console.authorize`](/docs/console/access) | Visitors for whom `authorize` returns `true` or a non-empty `{ sections }`. It gets `via: 'page'`, the page's session request, and the Site access person as `user`, with the roles comma-separated in `role`, when the browser has a site cookie. |
| Production, without `authorize` | Members of the Console team that Site access signed in: the `console` role. |

```ts [server/console-authorize.ts]
import { defineConsoleAuthorize } from 'vite-hub/console/auth'

export default defineConsoleAuthorize((context) => {
  // Show the Console link to every person that Site access signed in, guests too.
  if (context.via === 'page') return Boolean(context.user)
  // Every other caller keeps the access that it has without `authorize`.
  return true
})
```

An `authorize` that returns `true` for every context shows the link to every visitor, so check `context.via` first.

The pill shows only when the page has a hint: `?vitehub` in the URL, the `vitehub-tools=1` cookie of an earlier visit, or a new site cookie or app Auth session. Without Auth on a development server, open a page with `?vitehub` once. A page on `http:` with a non-loopback host, such as a LAN address, has no **Console** segment, because the Console cannot open that URL.

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
