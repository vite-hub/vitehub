---
title: Protect pages in Nuxt
description: Send signed-out visitors to the login page, keep signed-in users off guest pages, and protect the APIs that the pages call.
navigation.title: Protect pages
navigation.order: 10
icon: i-lucide-file-lock
---

In a Nuxt app, you protect pages with `access.pages` in the Auth Definition or `definePageMeta({ auth })` in a page. This is the page guard. It runs when the server renders the page and on each navigation in the browser. It decides where the browser goes. It does not protect your data, so you also [protect the API routes](#protect-the-apis-that-the-pages-call) that the page calls.

> [!NOTE] Before you start
> Add Auth to your Nuxt app with [Get started](/docs/auth/get-started). Your app must have an `app/pages/` folder, because the guard reads the meta of Nuxt pages.

## Protect one page

Add `definePageMeta({ auth: 'user' })` to the page:

```vue [app/pages/account.vue]
<script setup lang="ts">
definePageMeta({ auth: 'user' })

const { user } = useUserSession()
</script>

<template>
  <h1>Hello {{ user?.name }}</h1>
</template>
```

- A visitor without a session goes to `/login?redirect=/account`.
- A signed-in user sees the page. The server reads the session for the request, so the page renders signed in and does not flash signed out.

## Protect a group of pages

Put the pages in one folder, and add the guard to the parent page of that folder:

```vue [app/pages/dashboard.vue]
<script setup lang="ts">
definePageMeta({ auth: 'user' })
</script>

<template>
  <NuxtPage />
</template>
```

- Each page in `app/pages/dashboard/` is a child of this page. Vue Router gives each child the meta of its parent, so the guard applies to all of them.
- To make one child page public, set `definePageMeta({ auth: false })` in that page. The meta of a child replaces the value of its parent.

## Keep signed-in users off guest pages

A guest page is a page for visitors without a session, such as the login or sign-up page. Add `definePageMeta({ auth: 'guest' })` to it. A signed-in user who opens it goes to `/`.

The guard sends visitors to the login page with `?redirect=<the page>`. After the sign-in, send the user back to that page:

```vue [app/pages/login.vue]
<script setup lang="ts">
definePageMeta({ auth: 'guest' })

const route = useRoute()
const { signIn } = useUserSession()
const email = ref('')
const password = ref('')
const message = ref('')

async function submit() {
  const { error } = await signIn.email({ email: email.value, password: password.value })
  if (error) {
    message.value = error.message ?? 'Sign-in failed.'
    return
  }
  // Accept only a path on this site, so the link cannot send the user to another site.
  const redirect = route.query.redirect
  await navigateTo(typeof redirect === 'string' && redirect.startsWith('/') && !redirect.startsWith('//') ? redirect : '/')
}
</script>

<template>
  <form @submit.prevent="submit">
    <input v-model="email" type="email" autocomplete="email">
    <input v-model="password" type="password" autocomplete="current-password">
    <button type="submit">Sign in</button>
    <p v-if="message">{{ message }}</p>
  </form>
</template>
```

- `signIn.email()` needs `emailAndPassword: { enabled: true }` in `server/auth.ts`. Social sign-in uses `signIn.social({ provider })`.
- `signIn.email()` returns `{ data, error }`. It does not throw when the email or the password is wrong.

## Guard pages from one route map

In a Nuxt app, the page guard sends each visitor to a page that they may open. It runs when the server renders a page and on each navigation in the browser. List the pages that it guards in `access.pages` of the Auth Definition:

```ts [server/auth.ts]
import { defineAuth } from 'vite-hub/auth'

export default defineAuth({
  access: {
    pages: {
      '/dashboard/**': 'user',
      '/dashboard/pricing': false,
      '/login': 'guest',
    },
  },
})
```

- `'user'` sends a visitor without a session to [`access.signIn`](#choose-where-visitors-go), `/login?redirect=<the page>` by default. A direct load and a navigation in the browser go to the same page.
- `'guest'` sends a signed-in user to `access.afterSignIn`, `/` by default. Use it for the login and sign-up pages.
- `false` removes the guard of a wider pattern. Here, `/dashboard/pricing` is public.
- A key is a Nuxt route rule pattern with static segments, `:name` for one segment, and a last `/**` for the path and every path below it. When patterns overlap, the most specific pattern wins: Nuxt compares the segments from the left, and a static segment wins over `:name`, which wins over `**`.
- Optional, repeated, and regex params, such as `/account/:id?`, stop the build with `AUTH_PAGE_ROUTES_INVALID`, because Nuxt then orders the patterns by their position and not by how specific they are. For an optional segment, add one key with the segment and one key without it. A `*` also stops the build, because Nuxt reads a last `*` as `**`: use `:name` for one segment and `/**` for every depth. Two keys that match the same pages also stop the build: keys that differ only in param names, such as `/team/:id` and `/team/:slug`, in letter case, such as `/Team` and `/team`, or in percent-encoding, such as `/caf%C3%A9` and `/café`.

The Nuxt module reads `access.pages` at build time, like `access.signIn`. Write it as an object in the `defineAuth()` call, with string keys and literal values, and do not use a spread or a computed key in `access`. ViteHub adds the guard to the `appMiddleware` route rule of each pattern and keeps the other rules of the pattern. A wrong key or value, or a value that the build cannot read, stops the build with `AUTH_PAGE_ROUTES_INVALID`. `access` must be an object in the call too: when it is a variable or a call, the build cannot see `access.pages`, so the build stops with the same code. In a `defineAuth()` callback, the build reads the object that the callback returns first. When Auth resolves a callback that returns other `access.pages`, that request fails with the same code. `access.pages` guards Nuxt pages only. It is not `access.routes`, which guards server routes.

To guard a page from its own file, use `definePageMeta({ auth })`. It takes `'user'`, `'guest'`, `false`, or `{ only, redirectTo }`. Page meta wins over `access.pages`, so `definePageMeta({ auth: false })` makes one page public inside a `'user'` pattern.

> [!NOTE]
> A wide pattern such as `'/**': 'user'` also covers the sign-in page. The guard never sends a visitor to the page they are on, so a signed-out visitor gets a `401` error page there instead. Set the sign-in page to `'guest'`, so that signed-out visitors can open it and a signed-in user leaves it.

The page guard decides which page the browser shows. It does not protect data, because a request straight to an API route skips it. Guard API routes with `access.routes` in `server/auth.ts`, for example `'/api/dashboard/**'`. Do not put page paths in `access.routes`. A direct load of the page then gets `401`, or starts the `access.signIn` provider sign-in, while a navigation in the browser goes to the login page.

Do not cache a guarded page with a route rule such as `swr`, `isr`, or `prerender`. The cached page is rendered for one visitor and served to all visitors.

## Choose where visitors go

Set the default pages in `access` of the Auth Definition:

```ts [server/auth.ts]
import { defineAuth } from 'vite-hub/auth'

export default defineAuth({
  access: { signIn: '/sign-in', afterSignIn: '/dashboard' },
})
```

- `signIn` is where visitors without a session go from `'user'` pages. The default is `/login`.
- `afterSignIn` is where signed-in users go from `'guest'` pages. The default is `/`.
- With a provider, such as `signIn: { provider: 'github' }`, the guard sends visitors to `/api/auth/sign-in`, which starts the GitHub sign-in and comes back to the page. You need no sign-in page. After `signOut()` on a `'user'` page, the guard opens `/`, so the visitor is not signed in again at once.

To change the target for one page, use the object form:

```vue [app/pages/reports.vue]
<script setup lang="ts">
definePageMeta({ auth: { only: 'user', redirectTo: '/pricing' } })
</script>
```

| `auth` | Who may open the page | Others go to |
| --- | --- | --- |
| `'user'` or `true` | Visitors with a session | `access.signIn`, with `?redirect=<the page>` |
| `'guest'` | Visitors without a session | `access.afterSignIn` |
| `{ only, redirectTo }` | `only` is `'user'` (default) or `'guest'` | `redirectTo`. A `'user'` page also adds `?redirect=<the page>`. |
| `false` | Everyone | |
| Not set | The policy of the most specific `access.pages` pattern, or everyone if no pattern matches | |

The page guard is for Nuxt only. In a Vite app without Nuxt, `access.signIn` with a provider still serves the [sign-in link](/docs/auth/server-api#sign-in-and-out-with-a-link).

## Protect the APIs that the pages call

The page guard controls which page the browser shows. The code of the page and the API routes that it calls are still public. A person can send a request to `/api/dashboard/stats` with `curl` and skip the page guard. Protect the data on the server with `access.routes` in the Auth Definition:

```ts [server/auth.ts]
import { defineAuth } from 'vite-hub/auth'
import { authDatabase } from 'vite-hub/auth/database'

export default defineAuth({
  appName: 'Acme',
  database: authDatabase(),
  emailAndPassword: { enabled: true },
  access: {
    routes: ['/api/dashboard/**'],
  },
})
```

- A route that ends in `/**` matches its base path and every path below it.
- All other routes are literal paths. `/api/users/:id` and `/api/admin/*` fail the build. Use `/api/users/**` and check the id in the handler.
- An API request without a session gets `401` with `{ "status": 401, "statusText": "Unauthorized", "message": "Unauthorized.", "data": { "code": "SIGNED_OUT" } }`. Your handler does not run. See [Read a refusal](/docs/auth/limits-and-errors#read-a-refusal).
- To check a role, use a route object with `authorize`. See [Authorize access routes](/docs/auth/server-api#authorize-access-routes).
- To guard one handler, and to read the user in it, wrap the handler in [`withAuth()`](/docs/auth/server-api#use-it-at-runtime).

Use both guards. The page guard gives the visitor the correct page. The server guard keeps the data safe.

| | Page guard | `access.routes` |
| --- | --- | --- |
| Where it runs | In Nuxt route middleware, on the server render and on each navigation in the browser | In server middleware, on each request that matches a route |
| What it protects | Which page the browser shows | The response of the route: data and actions |
| Without a session | Sends the browser to the login page | Returns `401`. For an HTML `GET` with [`access.signIn`](/docs/auth/configure), it starts the provider sign-in. |
| What skips it | A request straight to an API route | Nothing. Each request that matches a route goes through it. |

Do not put Nuxt page paths in `access.routes`. A visitor without a session then gets a `401` response instead of your login page, unless `access.signIn` is set. Navigation in the browser does not request the page from the server, so the server guard does not run for it.

## Read the session and sign in or out

Nuxt imports these composables for you:

| Composable | Gives |
| --- | --- |
| `useUserSession()` | `user`, `session`, `loggedIn`, `pending`, and `ready` refs, and the `signIn`, `signUp`, `signOut`, and `refresh` actions. `signIn` and `signUp` are Better Auth's, such as `signIn.email()` and `signUp.email()`. |
| `useAuthClient()` | The Better Auth client that the composables use. |

On a protected page, `signOut()` sends the visitor to the configured sign-in page. If Auth starts a provider directly, Nuxt instead shows a signed-out page so it does not restart OAuth. To open a different page after sign-out, pass a public destination:

```vue [app/components/UserMenu.vue]
<script setup lang="ts">
const { loggedIn, user, signOut } = useUserSession()

async function logout() {
  await signOut({ redirectTo: '/goodbye' })
}
</script>

<template>
  <div v-if="loggedIn">
    {{ user?.name }}
    <button @click="logout">Sign out</button>
  </div>
  <NuxtLink v-else to="/login">Sign in</NuxtLink>
</template>
```

The composables call `/api/auth`, below the Nuxt `app.baseURL`. If your Auth Definition sets another `basePath`, create a client with the same path. See [Server API](/docs/auth/server-api#use-it-at-runtime).

## Next steps

::card-group
:::card{title="Server API" icon="i-lucide-code-2" to="/docs/auth/server-api"}
Guard server handlers and check roles with `authorize`.
:::

:::card{title="Configure" icon="i-lucide-sliders-horizontal" to="/docs/auth/configure"}
Keep users in a database and set the sign-in redirect for HTML requests.
:::

:::card{title="Limits and errors" icon="i-lucide-circle-alert" to="/docs/auth/limits-and-errors"}
Check Auth before you go to production.
:::
::
