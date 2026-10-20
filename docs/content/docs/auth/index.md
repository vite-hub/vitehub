---
title: Auth
navigation.title: Overview
description: Add sign-up, sign-in, and protected routes to your app with Better Auth, from one server file.
navigation.order: 1
icon: i-lucide-shield-check
---

::product-hero{tagline="Add sign-in and user sessions to your app with Better Auth, set up from one server file." hosts="Node, Docker, Cloudflare, Vercel, Netlify, Deno"}
  :::product-files
  ```ts [server/auth.ts]
  import { defineAuth } from 'vite-hub/auth'

  // Sign-up, sign-in, and session routes
  // appear under /api/auth.
  export default defineAuth({
    appName: 'Acme',
    emailAndPassword: { enabled: true },
    access: {
      // Users must sign in to open these pages
      routes: ['/admin/**'],
    },
  })
  ```

  ```ts [server/api/profile.get.ts]
  import { defineEventHandler } from 'h3'
  import { withAuth } from 'vite-hub/auth/server'

  // Runs only when the user is signed in
  export default defineEventHandler(
    withAuth((_event, { user }) => ({
      id: user.id,
      email: user.email,
    })),
  )
  ```

  ```vue [src/components/SignOutButton.vue]
  <script setup lang="ts">
  import { useUserSession } from 'vite-hub/auth/vue'

  // Session state in the browser
  const { loggedIn, user, signOut } = useUserSession()
  </script>

  <template>
    <button v-if="loggedIn" @click="signOut()">
      Sign out {{ user?.name }}
    </button>
  </template>
  ```

  ```ts [vite.config.ts]
  import { defineConfig } from 'vite'
  import { vitehub } from 'vite-hub'

  export default defineConfig({
    plugins: [
      vitehub({ preset: 'node', auth: true }),
    ],
  })
  ```
  :::
::

::product-features
  :::product-feature-item{title="One file sets up sign-in" icon="i-lucide-file-code-2" to="/docs/auth/configure#auth-definition"}
  Add `server/auth.ts`. Sign-up, sign-in, and session routes appear under `/api/auth`.
  :::

  :::product-feature-item{title="Protect a route" icon="i-lucide-lock" to="/docs/auth/server-api#use-it-at-runtime"}
  Wrap a handler in `withAuth()`. It runs only for signed-in users.
  :::

  :::product-feature-item{title="Decide who gets in" icon="i-lucide-shield-check" to="/docs/auth/server-api#authorize-access-routes"}
  An `authorize` function checks your own roles. Return `false` to send `403`.
  :::

  :::product-feature-item{title="Session state in Vue" icon="i-lucide-user-check" to="/docs/auth/server-api#use-it-at-runtime"}
  `useUserSession()` gives you the user, `loggedIn`, and sign-in and sign-out actions.
  :::

  :::product-feature-item{title="Keep secrets out of your code" icon="i-lucide-key-round" to="/docs/auth/configure#runtime-options"}
  Read the auth secret and OAuth keys from server environment variables when a request arrives.
  :::

  :::product-feature-item{title="Add a database for production" icon="i-lucide-database" to="/docs/auth/configure#storage-placement-metadata"}
  The default store loses users when the server restarts. Give Better Auth a database adapter to keep them.
  :::
::
