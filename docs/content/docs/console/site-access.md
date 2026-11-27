---
title: Site access and Console links
description: Sign browsers in to your app from the Console, invite guests, impersonate users and open previews with signed tokens, and link your pages to the Console.
navigation.title: Site access
navigation.order: 12
navigation.group: Use the Console
icon: i-lucide-door-open
---

From the Console you can open your app already signed in, sign in a phone and invite guests. The same signed token opens drafts and impersonation on your app's own origin, and your pages can link back to the Console.

With `console.authorize`, a member needs the `site` section. The result’s `grants` selects their [page tool roles](/docs/console/access#what-authorize-returns).

## Sign browsers in

**Site access** in the Console signs browsers in to the app for you. The app needs no [Auth](/docs/auth), no database, and no store for it: the Console keeps the passes, the invites, and the codes, and the app checks a signed token.

| Action | What it does |
| --- | --- |
| **Open site** | Opens the app in a new tab, signed in as you. |
| **Link a phone** | Shows a QR code, valid for 10 minutes, that signs the phone in as you. |
| **Invite someone** | Makes a link for a guest with the name that their comments show and the roles that you pick, such as **Write comments**. It works once, in one browser, for 1, 7 or 30 days. |

A member gets the `console` role, which shows the **Console** segment of the Comments pill, and the page tool roles allowed by `grants` (every page tool when `grants` is omitted). Without `console.authorize`, a member keeps the roles in their token and gets any new roles from the app's current page tools on the next request. Turning off the Comments overlay does not remove signed Comments API permissions. With `authorize`, only the roles in the token apply until the Console signs the next one. A guest gets the roles that you picked, such as the `comments-read`, `comments-write`, `comments-resolve` and `comments-delete` roles that [Comments checks](/docs/comments/configure#roles-from-site-access). A guest never gets the **Console** segment or into the Console.

The person and the roles live only in the app's site cookie. They are not app users, so routes that check the app's Auth session do not let them in. The page tools, the **Console** segment, and Comments read the person of the site cookie.

**Revoke** next to a browser in the Console stops the Console from signing new tokens for it. The app keeps the cookie that it has until the cookie ends, at most 12 hours later. To sign every browser out at once, rotate the [Console key](/docs/console/signed-requests) of the app.

### How the app checks a visit

1. `GET /_vitehub/site?return=/docs` sets the `__Host-vitehub-site-state` cookie, a random state for this browser that lasts 10 minutes, and sends the browser to the Console's `/visit` with the SHA-256 of the state.
2. The Console checks the person, the team, and the pass, and asks the app for the person's Site access with the `site.access` operation. It then signs a token with the private key of the app's link, and sends the browser back to `GET /_vitehub/site?token=vst1.…`.
3. The app checks the token with the `VITEHUB_CONSOLE_KEY_<NAME>` public keys of its links. The token must be for the app URL, for the state of this browser, and not older than 60 seconds. The app then sets the `__Host-vitehub-site` cookie, which holds the token, and opens the page with `?vitehub`.
4. Each request checks the cookie with the same keys. The cookie ends 12 hours after the Console signed the token. After that, open the app from the Console again. The Console signs a new token while the person still has access.

The app refuses a token for another app, for another browser, an expired token, and a token of an unknown key with `401` and `CONSOLE_SITE_TOKEN_REFUSED`. The cookies are `HttpOnly`, `Secure`, and `SameSite=Lax`. A `POST` to `/_vitehub/site` from a page of the app signs the browser out. The account menu of the pill does it.

| Operation | Does |
| --- | --- |
| `site.access` | Returns the Site access of the caller: `write`, which follows write access to the `site` section, and `roles`, the page tool roles that the caller gets and may give guests. The Console calls it before it signs a token. |

## Impersonation and Content preview

A draft preview needs your app's origin to render, and impersonation needs it to set the session cookie, but the Console runs on another origin. So they use the route and the token of [Site access](#how-the-app-checks-a-visit), with the kind `preview` or `impersonate`. The app keeps no state and needs no store for them, and an app without Comments takes them too.

1. In the Console, you click **Preview** or **Impersonate**. The Console calls the operation of the action on your app as you, with a signed request. The operation checks the section, the grant, and the target, and answers the app path to open.
2. The Console keeps what you started for 60 seconds in a cookie of this browser, and opens `GET /_vitehub/site?intent=<id>` of your app in a new tab. The app sets a separate state cookie for that intent and sends the browser to the Console's `/visit`.
3. The Console finds the cookie of the intent, checks that you are still signed in and a member of the team, and calls the operation again. Then it signs a token of the kind for 60 seconds, with the target, and sends the browser back to `GET /_vitehub/site?token=vst1.…&intent=<id>`.
4. The app checks the token as for Site access: for this app, for the state of this browser, of a known key, and not older than 60 seconds. It runs the action in this request and keeps no cookie for the token.

| Operation | Kind | Opens | The app checks when it gets the token |
| --- | --- | --- | --- |
| `documents.preview` | `preview` | A document's page with its saved draft, through the [preview frame](/docs/content/preview). | The person may read the document. |
| `auth.impersonate` | `impersonate` | The app home as the user. See [impersonation](/docs/auth/console#changes-and-limits). | The browser's app session has the person's email and Better Auth's `impersonate` permission. |
| `auth.stop-impersonating` | `impersonate` | The app home as the administrator again. | The browser impersonates for the person. |

The app refuses a token for another app, for another browser, of another kind, and an expired token with `401` and `CONSOLE_SITE_TOKEN_REFUSED`. A `site` token cannot run an action, and an action token cannot sign a browser in to Site access. In a browser signed in to the app as another person, an impersonation gets `403` with `CONSOLE_SITE_ACCOUNT_MISMATCH`. When the app runs an action, its response clears the state cookie of the browser. After the browser applies that response, the app refuses the same token.

## Link to the Console

```ts
import { hostedConsoleUrl } from 'vite-hub/runtime'

hostedConsoleUrl('https://app.example.com', '/agents/support/invocations/abc')
// https://console.vitehub.dev/open?project=https%3A%2F%2Fapp.example.com&path=%2Fagents%2Fsupport%2Finvocations%2Fabc
```

`hostedConsoleUrl()` builds a link to one Console page of a project, as Agent invocation links and GitHub pull request comments do. The first argument is the app origin with any base path, such as `https://app.example.com/portal`, and the second a Console path that starts with one `/`, such as `/kv` or `/agents/<agent>/invocations/<id>`. It encodes both. It throws `RUNTIME_CONSOLE_PROJECT_URL_INVALID` for a project URL and `RUNTIME_CONSOLE_PATH_INVALID` for a path that the Console refuses. A self-hosted Console takes its origin as a third argument, such as `hostedConsoleUrl(url, '/kv', 'https://console.example.com')`.

The link opens that page of your team's app with that URL, or Home when your team has not linked it.

## Open the Console from the app

Put `/_vitehub` after the app address to open the app in the Console. The rest of the path and the query select the Console page: `https://app.example.com/_vitehub/agents/support?tab=trace` opens `/agents/support?tab=trace` of this app in the Console, and `https://app.example.com/_vitehub` opens the project overview. For an app below a base path, `https://app.example.com/portal/_vitehub` opens the project `https://app.example.com/portal`.

An app with the Comments pill goes back to the page instead: [Comments](/docs/comments) through Site access, and an app without Comments that the Console links through [Hosted Comments](/docs/comments/configure#add-hosted-comments). There, `https://app.example.com/_vitehub/recetas/alioli` opens `/recetas/alioli?vitehub`, and `https://app.example.com/_vitehub` opens the page of the `Referer` on the same origin, else `/`. If no more specific handler serves a reserved path such as `/_vitehub/agents`, the fallback opens the Console in an app with Hosted Comments and answers `404` in an app with Comments. Open the Console from the pill.

Otherwise, the route answers `303` with a link to `/open` on the Console set by `console.url`, or `https://console.vitehub.dev` by default. It gives no access, because the Console checks the person and the team when it opens. When you set `vitehub({ publicUrl })`, a build answers only on those origins, and another hostname of the same deployment gets `404`. An app origin that the Console cannot open, such as `http:` on a LAN address, gets `404` too.

## The Console segment of the Comments pill

With `console` set and [Comments](/docs/comments) on, the Comments pill gets a **Console** segment. It opens the configured Console in a new tab, at the Content document that the page shows through [`contentField()`](/docs/content/server-api#field-addresses) attributes, or at the project overview. An app without Comments that the Console links gets the [Hosted Comments](/docs/comments/configure#add-hosted-comments) pill of the Console. An app with `comments: false`, or without Console keys, has no pill and adds no script to its pages. Open its Console from `/_vitehub` or from the Console.

The segment grants nothing, because the Console checks the person and the team when it opens. The pill still hides it from the app's other users:

| Where | Who sees **Console** |
| --- | --- |
| Development server | Every visitor. |
| Production | Members of the Console team that Site access signed in: the `console` role. |

The pill shows only when the page has a hint: `?vitehub` in the URL, the `vitehub-tools=1` cookie of an earlier visit, or a new site cookie or app Auth session. Without Auth on a development server, open a page with `?vitehub` once. A page on `http:` with a non-loopback host, such as a LAN address, has no **Console** segment, because the Console cannot open that URL.

When you set `vitehub({ publicUrl })`, a build shows the pill only on that origin. Another hostname of the same deployment, such as a domain that serves user uploads, gets no pill, and `/_vitehub` and the page tools route answer `404` there. Other ViteHub routes, such as `/_vitehub/rpc`, Realtime, Channels, and webhooks, answer on every hostname. A `localhost` or `127.0.0.1` host and a development server always get the pill.

### Content Security Policy

The configured Console serves the segment script at `/page/<version>/page-tool.js`. The app serves no Console file. If your Content Security Policy uses an origin list, add the origin from `console.url` to `script-src`. For the default Console:

```http
Content-Security-Policy: script-src 'self' https://console.vitehub.dev
```

A policy with a nonce needs no Console origin. ViteHub puts the nonce of the `Content-Security-Policy` response header on the page tools loader, and the scripts that the loader imports run with the same nonce. This also works with `'strict-dynamic'`.

`'strict-dynamic'` makes the browser ignore the origins in `script-src`, such as `'self'` and `https://console.vitehub.dev`. With `'strict-dynamic'` and no nonce in the response header, for example a policy with hashes only, the browser blocks the page tools loader of Comments and the **Console** segment. A page that blocks only the Console origin shows **Retry Console** in the pill.
