---
title: Protect pages in Nuxt
description: Send signed-out visitors to the login page, keep signed-in users off guest pages, and protect the APIs that the pages call.
navigation.title: Protect pages
navigation.order: 10
icon: i-lucide-file-lock
---

In a Nuxt app, you protect a page with `definePageMeta({ auth })`. This is the page guard. It runs when the server renders the page and on each navigation in the browser. It decides where the browser goes. It does not protect your data, so you also [protect the API routes](#protect-the-apis-that-the-pages-call) that the page calls.

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

## Choose where visitors go

Set the default pages under `vitehub.auth.redirects`:

```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    auth: {
      redirects: { login: '/sign-in', guest: '/dashboard' },
    },
  },
})
```

- `login` is where visitors without a session go from `'user'` pages. The default is `/login`.
- `guest` is where signed-in users go from `'guest'` pages. The default is `/`.

To change the target for one page, use the object form:

```vue [app/pages/reports.vue]
<script setup lang="ts">
definePageMeta({ auth: { only: 'user', redirectTo: '/pricing' } })
</script>
```

| `auth` | Who may open the page | Others go to |
| --- | --- | --- |
| `'user'` or `true` | Visitors with a session | `redirects.login`, with `?redirect=<the page>` |
| `'guest'` | Visitors without a session | `redirects.guest` |
| `{ only, redirectTo }` | `only` is `'user'` (default) or `'guest'` | `redirectTo`. A `'user'` page also adds `?redirect=<the page>`. |
| `false` or not set | Everyone | |

The guard and `redirects` are for Nuxt only. A Vite app without Nuxt ignores them.

## Protect the APIs that the pages call

The page guard controls which page the browser shows. The code of the page and the API routes that it calls are still public. A person can send a request to `/api/dashboard/stats` with `curl` and skip the page guard. Protect the data on the server with `access.routes` in the Auth Definition:

```ts [server/auth.ts]
import { defineAuth } from 'vite-hub/auth'

export default defineAuth({
  appName: 'Acme',
  emailAndPassword: { enabled: true },
  access: {
    routes: ['/api/dashboard/**'],
  },
})
```

- A route that ends in `/**` matches its base path and every path below it.
- All other routes are literal paths. `/api/users/:id` and `/api/admin/*` fail the build. Use `/api/users/**` and check the id in the handler.
- An API request without a session gets `401` with `{"error":"Unauthorized."}`. Your handler does not run.
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
| `useSession()` | Better Auth's session ref: `data`, `error`, `isPending`, `isRefetching`, and `refetch`. |
| `useAuthClient()` | The Better Auth client that the composables use. |

The guard runs only when the route changes. After a sign-out, send the user to another page yourself:

```vue [app/components/UserMenu.vue]
<script setup lang="ts">
const { loggedIn, user, signOut } = useUserSession()

async function logout() {
  await signOut()
  await navigateTo('/login')
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
