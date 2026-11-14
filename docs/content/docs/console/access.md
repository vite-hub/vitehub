---
title: Console access
description: Decide who may call the Console endpoint of your app, and give each person, key, or agent only some sections, read only or with writes.
navigation.title: Access
navigation.order: 20
navigation.group: Secure it
icon: i-lucide-shield-check
---

## Who can call the endpoint

The Console route checks access itself. App Auth access routes, such as `/_vitehub/**` or `/**`, do not cover it.

| Configuration | Check |
| --- | --- |
| `console: true`, or an object without `auth` | Verifies the [Ed25519 signature](/docs/console/signed-requests) with the `VITEHUB_CONSOLE_KEY_<NAME>` that it names: the ViteHub Console and the CLI. Returns `401`, or `500` when no key is set or one is malformed. A cookie, a session, or a bearer token never counts. |
| `console: { auth: false }` | Development only. Takes calls without a signature from this machine. See [Development server](/docs/console/development). |
| `authorize` | Runs after either check. It can reject the request or limit it to some sections. |

> [!WARNING]
> A production build with `auth: false` fails with `VITE_HUB_B0022`, also when `authorize` is set. Remove `auth` and set a `VITEHUB_CONSOLE_KEY_<NAME>` variable. Development, CLI discovery, and `nuxi prepare` still accept `auth: false`.

When `console` is missing or `false`, a production build registers no Console route, and the host returns its normal not-found response.

## Write authorize

A signed caller gets every Console section. Set `console.authorize` to limit it:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    auth: true,
    console: { authorize: './server/console-authorize.ts' },
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({
    auth: true,
    console: { authorize: './server/console-authorize.ts' },
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
    auth: true,
    console: { authorize: './server/console-authorize.ts' },
  })],
})
```
:::
::

The context names the caller in `via`. Allow each one on its own:

| `via` | Caller | Context |
| --- | --- | --- |
| `'console'` | A person in the ViteHub Console. | `user`, which the Console signed, and `team`, the team that linked the app with the role of the user in it. |
| `'cli'` | The `vitehub` CLI or a CI job. | No `user`. |
| `'agent'` | An Agent that calls operations as tools. | The Auth user of its Invoker. |
| `'page'` | The tools pill, when it asks whether to show the [Console link](/docs/console/site-access#open-the-console-from-your-pages). | The session request of the page, and the app's Auth `user` when someone signed in. |

`'console'` and `'cli'` contexts have `key`, the `<NAME>` of the key. Operations get the same user as `context.user`.

```ts [server/console-authorize.ts]
import { defineConsoleAuthorize } from 'vite-hub/console/auth'

export default defineConsoleAuthorize((context) => {
  if (context.via === 'console') return context.user.email?.endsWith('@example.com') ?? false
  if (context.via === 'cli') return { sections: ['kv', 'logs:read'] }
  if (context.via === 'agent') return { sections: ['kv:read'] }
  return false
})
```

The people who edit in the Console are Console accounts, not users of your app. To give editors only some sections, check the signed `user`:

```ts [server/console-authorize.ts]
import { defineConsoleAuthorize } from 'vite-hub/console/auth'

const editors = new Set(['editor@example.com'])

export default defineConsoleAuthorize((context) => {
  if (context.via !== 'console') return context.via === 'cli'
  if (context.team?.role === 'owner' || context.team?.role === 'admin') return true
  if (context.user.email && editors.has(context.user.email)) return { sections: ['content', 'comments', 'blob:media'] }
  return false
})
```

## What authorize returns

Every Console call runs `authorize` with the Web `Request` before it reads data: operations, invocation actions, Channel replay, and Schedule runs.

| Result | Effect |
| --- | --- |
| `true` | Allows every Console section. |
| `{ sections: ['content'] }` | Allows only these section ids, with all their actions. An empty list returns `403`. |
| `{ sections: ['kv:read'] }` | Allows `kv` for reads only. `write` and `destructive` operations return `403`, unless the call only reads (`readOnlyWhen`). |
| `{ sections: ['blob:media'] }` | Allows Blob operations on the `media` store only. `'blob:media:read'` allows only reads. |
| `false` | Returns `403`. |
| A `Response` | Goes out as it is, for example a `401`. |

Any other value returns `500`.

Section ids are the ids in the Console URL, such as `env`, `agents`, `usage`, `content`, `blob`, `databases`, `kv`, `workspaces`, `workflows`, `queues`, and `schedules`. Each route and operation declares its section, and the server returns `403` for a section outside the list. Write actions need the section that owns them:

- Agent Invocations and Channel replay: `agents`. Schedule runs: `schedules`.
- Workflow starts, cancels, and resumes: `workflows`.
- Content saves and publishes: `content`. Content then checks `content.can()`, so `defineContent({ authorize })` decides which collections and actions an editor gets.

The Console shows only allowed sections, but the server check is the security boundary.

## Read-only grants

A section entry is the section id, or `'<section>:read'` for read only. A read grant allows only `kind: 'read'` operations and calls that `readOnlyWhen` marks as reads, on every surface: Console RPC, `vitehub <namespace> --url`, agent tools, and MCP. Schedule runs refuse it, and so do write operations such as `channels.replay`, `agents.invoke`, and `media.upload`. With `'kv:read'` and `'kv'` together, the full grant wins. The Console hides write actions for a read grant.

::warning
Breaking change: a section grant now includes its write actions. `{ sections: ['kv'] }` lets a user set and delete keys, `'blob'` lets them upload and delete blobs, and `'rate-limits'` lets them reset counters. For a read-only role, use `'<section>:read'`, such as `{ sections: ['kv:read', 'blob:read'] }`.
::

## Grant one Blob store

`'blob'` allows the Blob operations (`blob.list`, `blob.head`, `blob.get`, `blob.put`, `blob.delete`, `blob.media`, and `blob.variants`) on every store. `'blob:<store>'` allows them on one store, and `'blob:<store>:read'` only the reads. A store grant gives editors the public Media store without the private Content store:

```ts [server/console-authorize.ts]
import { defineConsoleAuthorize } from 'vite-hub/console/auth'

export default defineConsoleAuthorize((context) => {
  if (context.via !== 'console') return false
  if (context.team?.role === 'owner') return true
  // `media` is the served store. The `default` store keeps the Content workspace.
  return { sections: ['content', 'comments', 'blob:media'] }
})
```

The server checks the store of each call on every surface. A call without `store` uses `default`. A call to another store returns `403` with `CONSOLE_ACCESS_DENIED`, and the message names the needed grant, such as `'blob:default'`. `blob.list` returns only allowed stores in `stores`. A store grant does not open the Blob section, which needs `'blob'` or `'blob:read'`, so editors use the [Media library](/docs/content/console#media-library) of Content. A store named `read`, or with `:` in its name, needs the whole `'blob'` grant.

## Keep Console routes out of search engines

ViteHub sends `X-Robots-Tag: noindex, nofollow` on the Console routes. This does not block access. Access comes from the signature.

Nuxt needs no SEO module for this default. If the app uses `@nuxtjs/robots` or `@nuxtjs/seo`, add route rules so its robots and sitemap modules skip the Console routes:

```ts [nuxt.config.ts] fragment
// With @nuxtjs/robots or @nuxtjs/seo in `modules`
routeRules: {
  '/_vitehub': { robots: false },
  '/_vitehub/**': { robots: false },
},
```

Do not use `robots.txt` as access control. Crawlers can ignore it, and a blocked URL can still be listed. Read [Auth](/docs/auth/server-api#authorize-access-routes) for the full callback contract.
