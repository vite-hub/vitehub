---
title: Auth abilities
description: Write each permission rule once, then check it in server routes and in Vue.
navigation.title: Abilities
navigation.order: 10
icon: i-lucide-shield-check
---

An ability is a named rule about what the signed-in user can do, such as `posts.edit`. You write the rules in one file. Server routes and Vue pages run the same rules, so the button that the page shows and the check that the route makes cannot drift apart. The design comes from [Capsa](https://github.com/OrlS15/nuxt-capsa) by Orlando Sica.

## Write the rules

Put the rules in `shared/abilities.ts`, next to the `server/` folder. The app needs an [Auth Definition](/docs/auth/get-started).

```ts [shared/abilities.ts]
import { defineAbilities, deny, guest } from 'vite-hub/auth/abilities'

export interface Post {
  id: string
  authorId: string
  published: boolean
}

export default defineAbilities({
  'posts.read': guest((user, post: Post) => post.published || user?.id === post.authorId),
  'posts.edit': (user, post: Post) => user.id === post.authorId || 'not-author',
  'posts.publish': (user, post: Post) => user.id === post.authorId || deny('not-found', { status: 404 }),
})
```

A rule gets the signed-in user, then its arguments:

- `true` allows. `false`, a code string, or `deny(code, { status, details })` refuse. A code gives `403`. `deny()` can give another 4xx status, and `details` for the page.
- A signed-out visitor gets `401` with the code `signed-out`, and the rule does not run. Wrap a rule in `guest()` to run it for signed-out visitors too, with `user` set to `null`.
- A rule must return at once, because it also runs in the browser. Load the data first and pass it in. Do not import server-only code into this file.

In Nuxt, the app's file replaces the layer files. Without an app file, one layer may provide the rules. Two layers with rules fail with `AUTH_C0060`; add an app file to choose the rules.

The Auth Vite plugin finds the file and registers its type in `.vitehub/types/auth.d.ts`. The ability names, the argument types, and the user type come from TypeScript inference. A wrong name or a wrong argument fails to compile.

## Check a rule on the server

`requireAbility(event, name, ...args)` returns the checked `{ request, session, user }`, or throws an error that H3 sends with the rule's status. The body has `{ code, details }` in `data`.

```ts [server/utils/posts.ts]
import type { Post } from '../../shared/abilities'

const posts = new Map<string, Post>([['1', { id: '1', authorId: 'user-1', published: false }]])

export function findPost(id: string): Post | undefined {
  return posts.get(id)
}
```

```ts [server/api/posts/[id].get.ts]
import { createError, defineEventHandler, getRouterParam } from 'h3'
import { requireAbility } from 'vite-hub/auth/server'
import { findPost } from '../../utils/posts'

export default defineEventHandler(async (event) => {
  const post = findPost(getRouterParam(event, 'id') ?? '')
  if (!post) throw createError({ status: 404 })

  await requireAbility(event, 'posts.read', post)
  return post
})
```

`can(event, name, ...args)` from the same import returns `true` or `false` and throws nothing. Both read the session once per request.

## Check a rule in Vue

`<AuthPermission>` renders `#allowed` when the rule allows and `#denied` with `{ code, details }` when it refuses. Default content is shorthand for `#allowed`. If both are present, `#allowed` takes precedence. Neither slot renders while the session is unknown or `pending` is true. `useAbility().can()` and `useAbility().cannot()` return `undefined` for the same unknown state.

In Nuxt, these APIs are auto-imported. In other Vue apps, import them from `vite-hub/auth/vue`.

```vue [app/pages/posts/[id].vue]
<script setup lang="ts">
const route = useRoute()
const { data: post } = await useFetch(`/api/posts/${route.params.id}`)
</script>

<template>
  <AuthPermission v-if="post" check="posts.edit" :args="[post]">
    <template #allowed>
      <button>Edit</button>
    </template>
    <template #denied="{ code }">
      <p v-if="code === 'signed-out'">Sign in to edit this post.</p>
      <p v-else>Only the author can edit this post.</p>
    </template>
  </AuthPermission>
</template>
```

Pass rule arguments in `args`, in the same order as on the server. For one argument, use `:args="[post]"`; for two, use `:args="[from, to]"`. Omit `args` when the rule takes no arguments or all its arguments are optional. The types check the rule name and its argument tuple. Use `v-if` to wait for data, or set `:pending="!post"` to show nothing while it loads.

For the allowed case alone, use default content:

```vue fragment
<AuthPermission check="posts.edit" :args="[post]">
  <button>Edit</button>
</AuthPermission>
```

In Nuxt, the server reads the session for the page, so server rendering shows the right slot. In a Vue app without server rendering, the component shows nothing until Better Auth answers.

Nuxt registers `<AuthPermission>` only when the app or a layer has `shared/abilities.ts`. Adding or removing that file in development restarts Nuxt. An app component with the same name wins. A custom prefix, such as `vitehub: { auth: { components: { prefix: 'Custom' } } }`, registers `<CustomAuthPermission>` with the same types. Prefixes follow Nuxt's component prefix rules.

Nuxt uses the Auth Definition's configured base path for browser session refreshes. In other Vue apps with a custom client, call `provideAuthClient(client)` from a parent component's setup. Descendant `<AuthPermission>` components and Auth composables share that client. For a single check, pass the client directly to `useAbility(client)`.

```ts fragment
import { createAuthClient, provideAuthClient } from 'vite-hub/auth/vue'

const client = createAuthClient({ basePath: '/auth' })
provideAuthClient(client)
```

## Refuse a page

`useAbility().authorize(name, ...args)` checks a rule and throws when it refuses. The error has the status and the `{ code, details }` data that `requireAbility()` sends from the server. In Nuxt, the error is fatal, so the visitor sees the error page with that status. Call it in the page after the data loads:

```vue [app/pages/posts/[id]/edit.vue]
<script setup lang="ts">
const route = useRoute()
const { authorize } = useAbility()
const { data: post } = await useFetch(`/api/posts/${route.params.id}`)
if (!post.value) throw createError({ status: 404, fatal: true })
await authorize('posts.edit', post.value)
</script>

<template>
  <h1>Edit {{ post?.id }}</h1>
</template>
```

On the server and while Nuxt hydrates the page, `authorize()` uses the session that the server read for the page. At other times in the browser, such as after a navigation, it sends one request to Better Auth's `/get-session` for the current session, so a sign-in or sign-out in the tab counts. On the server, a session that the server could not read counts as signed out, so a rule that is not open to guests refuses with `401`. In a Vue app without Nuxt, `authorize()` throws the same `AbilityError` that `requireAbility()` throws.

`authorize()` only decides what the page shows. Check the same rule with `requireAbility()` in the server route that returns or changes the data.

## Abilities and route guards

[`requireAuthorization(event, authorize)` and `withAuthorization()`](/docs/auth/server-api) check the caller with an `authorize` callback. `requireAuthorization()` runs inside the handler; `withAuthorization()` wraps it. Use them when the decision needs only the user, such as an admin area. Use an ability when the decision needs data that the handler loads, such as the post, or when the page must show the same decision.
