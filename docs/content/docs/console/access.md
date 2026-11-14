---
title: Console access
description: Decide who may call the Console endpoint of your app, and give each person, key, or agent only some sections, read only or with writes.
navigation.title: Access
navigation.order: 20
navigation.group: Secure it
icon: i-lucide-shield-check
---

Only signed callers reach your app's Console endpoint, and your `authorize` function decides what each one may do: use every section, a few, or only read.

## Who can call the endpoint

| Configuration | Who gets in |
| --- | --- |
| `console: true`, or an object without `auth` | Callers with a valid [Ed25519 signature](/docs/console/signed-requests) from a `VITEHUB_CONSOLE_KEY_<NAME>` key: the ViteHub Console and the CLI. Others get `401`. A cookie, session or bearer token never counts. |
| `console: { auth: false }` | Unsigned calls from this machine, in [development](/docs/console/development) only. |
| `authorize` | Runs after either check, to reject the call or limit it to some sections. |

With no key set, or a malformed one, every call gets `500`. The route checks access itself, so app Auth [access routes](/docs/auth/server-api#authorize-access-routes) such as `/_vitehub/**` or `/**` do not cover it. Without `console`, or with `console: false`, a production build has no Console route and the host answers not found.

::warning
A production build with `auth: false` fails with `VITE_HUB_B0022`, even when `authorize` is set. Remove `auth` and set a `VITEHUB_CONSOLE_KEY_<NAME>` variable. Development, CLI discovery and `nuxi prepare` still accept it.
::

## Write authorize

A signed caller gets every section until you set `console.authorize`:

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


```ts [server/console-authorize.ts]
import { defineConsoleAuthorize } from 'vite-hub/console/auth'

const editors = new Set(['editor@example.com'])

export default defineConsoleAuthorize((context) => {
  if (context.via === 'cli') return { sections: ['kv', 'logs:read'] }
  if (context.via === 'agent') return { sections: ['kv:read'] }
  if (context.via !== 'console') return false
  if (context.team?.role === 'owner' || context.team?.role === 'admin') return true
  if (context.user.email && editors.has(context.user.email)) return { sections: ['content', 'comments', 'blob:media'] }
  return false
})
```

`context.via` names the caller:

| `via` | Caller | Context |
| --- | --- | --- |
| `'console'` | A person in the ViteHub Console. | The signed `user`, and the `team` that linked the app with the user's role. |
| `'cli'` | The `vitehub` CLI or a CI job. | No `user`. |
| `'agent'` | An Agent that calls operations as tools. | The Auth user of its Invoker. |
| `'page'` | The tools pill, asking whether to show the [Console link](/docs/console/site-access#open-the-console-from-your-pages). | The page's session request, and the app's Auth `user` when someone signed in. |

`'console'` and `'cli'` also carry `key`, the `<NAME>` of the signing key. Console editors are Console accounts, not users of your app, so check the signed `user`, as above. Operations get the same user as `context.user`.

## What authorize returns

`authorize` gets the Web `Request` and runs before any Console call reads data, Channel replay and Schedule runs included.

| Result | Effect |
| --- | --- |
| `true` | Allows every section. |
| `{ sections: ['content'] }` | Allows only these section ids, with all their actions. An empty list returns `403`. |
| `{ sections: ['kv:read'] }` | Allows `kv` for reads only. See [Read-only grants](#read-only-grants). |
| `{ sections: ['blob:media'] }` | Allows Blob operations on the `media` store only. See [Grant one Blob store](#grant-one-blob-store). |
| `false` | Returns `403`. |
| A `Response` | Goes out as it is, for example a `401`. |
| Anything else | Returns `500`. |

Section ids are the ids in the Console URL, such as `env`, `agents`, `usage`, `content`, `blob`, `databases`, `kv`, `workspaces`, `workflows`, `queues` and `schedules`. A write action needs the section that owns it: `agents` for Agent Invocations and Channel replay, `schedules` for Schedule runs, `workflows` for Workflow starts, cancels and resumes, and `content` for Content saves and publishes. Content then checks `content.can()`, so `defineContent({ authorize })` decides which collections and actions an editor gets.

The Console hides sections that you may not use, but the server check is the security boundary.

## Read-only grants

`'<section>:read'` allows only `kind: 'read'` operations and calls that `readOnlyWhen` marks as reads. It holds on every surface (Console RPC, `vitehub <namespace> --url`, agent tools and MCP) and refuses Schedule runs and writes such as `channels.replay`, `agents.invoke` and `media.upload`, which the Console then hides. With both `'kv:read'` and `'kv'`, the full grant wins.

::warning
Breaking change: a section grant now includes its writes. `'kv'` sets and deletes keys, `'blob'` uploads and deletes blobs, and `'rate-limits'` resets counters. For a read-only role, grant `'<section>:read'`, such as `{ sections: ['kv:read', 'blob:read'] }`.
::

## Grant one Blob store

```ts [server/console-authorize.ts]
import { defineConsoleAuthorize } from 'vite-hub/console/auth'

export default defineConsoleAuthorize((context) => {
  if (context.via !== 'console') return false
  if (context.team?.role === 'owner') return true
  // `media` is the served store. The `default` store keeps the Content workspace.
  return { sections: ['content', 'comments', 'blob:media'] }
})
```

`'blob'` allows the Blob operations (`blob.list`, `head`, `get`, `put`, `delete`, `media` and `variants`) on every store, `'blob:<store>'` on one store, and `'blob:<store>:read'` only its reads. A call without `store` uses `default`, and a call to a store outside the grant gets `403` with `CONSOLE_ACCESS_DENIED` and the grant it needs, such as `'blob:default'`. `blob.list` returns only the allowed `stores`.

A store grant does not open the Blob section, which needs `'blob'` or `'blob:read'`, so editors use the [Media library](/docs/content/console#media-library) of Content. A store named `read`, or with `:` in its name, needs the whole `'blob'` grant.

## Keep Console routes out of search engines

ViteHub sends `X-Robots-Tag: noindex, nofollow` on the Console routes. If the app uses `@nuxtjs/robots` or `@nuxtjs/seo`, also skip the routes in their robots and sitemap output:

```ts [nuxt.config.ts] fragment
// With @nuxtjs/robots or @nuxtjs/seo in `modules`
routeRules: {
  '/_vitehub': { robots: false },
  '/_vitehub/**': { robots: false },
},
```

None of this blocks access; the signature does. Do not use `robots.txt` as access control, because crawlers can ignore it and a blocked URL can still be listed.
