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

`<Can>` shows its content when the rule allows, the `#denied` slot with `{ code, details }` when it refuses, and nothing while the session is unknown. `<Cannot>` is the mirror: it shows its content, with `{ code, details }`, only when the rule refuses. `useAbility().can()` and `useAbility().cannot()` return `undefined` for the same unknown state. In Nuxt, all of them are auto-imported. In other Vue apps, import them from `vite-hub/auth/vue`.

```vue [app/pages/posts/[id].vue]
<script setup lang="ts">
const route = useRoute()
const { data: post } = await useFetch(`/api/posts/${route.params.id}`)
const { can } = useAbility()
</script>

<template>
  <article v-if="post">
    <Can do="posts.edit" :with="post">
      <button>Edit</button>
      <template #denied="{ code }">
        <p v-if="code === 'signed-out'">Sign in to edit this post.</p>
      </template>
    </Can>
    <button v-if="can('posts.publish', post)">Publish</button>
    <Cannot do="posts.edit" :with="post" v-slot="{ code }">
      <p v-if="code === 'not-author'">Only the author can edit this post.</p>
    </Cannot>
  </article>
</template>
```

For a rule with one argument, required or optional, pass it in `with`. For every other rule, such as two arguments, a default parameter, or a rest parameter, pass the list in `args`: `:args="[from, to]"`. `<Cannot>` takes the same props. The types pick the prop, so the wrong one fails to compile. The components and the functions pass the arguments as they are, the same as the server. Only the session makes the answer unknown, so render `<Can>` after the data loads (`v-if`), or set `:pending="!post"` to show nothing until then.

In Nuxt, the server reads the session for the page, so server rendering shows the right slot. In a Vue app without server rendering, `<Can>` shows nothing until Better Auth answers.

Nuxt registers `<Can>` only when the app or a layer has `shared/abilities.ts`. Without the file, the name stays free for your own components. In development, adding or removing the file restarts Nuxt. When the app already has a `Can` component, its component wins. To register `<Can>` under another name, set a prefix in `nuxt.config.ts`: `vitehub: { auth: { components: { prefix: 'Auth' } } }` gives `<AuthCan>`, with the same types. The prefix follows Nuxt's component prefix rules: Nuxt splits it into words as it splits the prefix of `components: [{ path, prefix }]`, so `'my-auth'` gives `<MyAuthCan>`.

Nuxt uses the Auth Definition's configured base path for browser session refreshes too. In other Vue apps with a custom client, call `provideAuthClient(client)` from a parent component's setup. Descendant `<Can>` components and Auth composables then share that client. For a single check, pass the client directly to `useAbility(client)`.

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
