---
title: Auth
navigation.title: Overview
description: Configure Better Auth server behavior, route exposure, runtime options, and session checks.
navigation.order: 1
icon: i-lucide-shield-check
---

::agent-only{skill="auth"}
Use Auth when the application needs sign-in, sessions, route protection, or Better Auth server plugins. Auth owns identity and session state. It does not automatically protect Agent, Console, or primitive routes.

Read [Get started](/docs/auth/get-started), [Configure](/docs/auth/configure), or [Server API](/docs/auth/server-api).

Keep route access explicit. Configure the Auth Definition and its `access` policy, then mount the route through the Vite or Nuxt integration. Keep application authorization in the route or Capability that uses the session.

Treat local session storage as development state unless the selected provider
gives it durable storage. A signed-in user is not automatically an Agent actor.

Prove the flow with a real sign-in or session lookup, then request a protected route and inspect the generated route or provider output for the selected host.
::

::product-hero{tagline="Better Auth sessions and route guards from one Auth Definition that ViteHub discovers and mounts for your host." hosts="Node, Docker, Cloudflare, Vercel, Netlify, Deno"}
  :::code-group
  ```ts [Definition]
  import { defineAuth } from '@vite-hub/auth'

  export default defineAuth(({ env, requestOrigin }) => ({
    appName: 'Acme',
    baseURL: requestOrigin,
    secret: env.auth.secret.unseal(),
    socialProviders: {
      github: {
        clientId: env.auth.github.clientId,
        clientSecret: env.auth.github.clientSecret.unseal(),
      },
    },
  }))
  ```

  ```ts [Route]
  import { auth } from '@vite-hub/auth/server'

  export default defineEventHandler(async (event) => {
    const headers = new Headers(getRequestHeaders(event))

    return auth.api.getSession({ headers })
  })
  ```

  ```ts [Access]
  import { defineAuth } from '@vite-hub/auth'

  export default defineAuth({
    access: {
      routes: [
        {
          route: '/_vitehub/**',
          authorize: ({ user }) => user.isAdmin === true,
        },
        {
          route: '/api/_vitehub/console/**',
          authorize: ({ user }) => user.isAdmin === true,
        },
      ],
    },
  })
  ```

  ```ts [Agent]
  import { defineAgent } from '@vite-hub/agent'
  import { authenticated } from '@vite-hub/auth/agent'

  export default defineAgent({
    invoker: authenticated(),
    driver: {
      run: ({ invoker }) => ({ invoker }),
    },
  })
  ```
  :::
::


::product-features
  :::product-feature-item{title="Read the session in any server route" icon="i-lucide-user-check" to="/docs/auth/server-api"}
  Better Auth at `/api/auth/**`; guard routes with `withAuth()`.
  :::

  :::product-feature-item{title="Guard listed routes, decide roles in code" icon="i-lucide-shield-check" to="/docs/auth/server-api#authorize-access-routes"}
  `authorize` returns `true`, `false` for `403`, or a `Response`.
  :::

  :::product-feature-item{title="Secrets come from Server Env at request time" icon="i-lucide-key-round" to="/docs/auth/configure#runtime-options"}
  Read `secret` and `baseURL` from Server Env, never Public Env.
  :::

  :::product-feature-item{title="Placement metadata is not a database adapter" icon="i-lucide-database" to="/docs/auth/configure#storage-placement-metadata"}
  Return a concrete Better Auth adapter to persist sessions.
  :::

  :::product-feature-item{title="Map the signed-in user to an Agent Invoker" icon="i-lucide-bot" to="/docs/agents/invokers"}
  `authenticated()` maps the session to an `authUser` Invoker.
  :::

  :::product-feature-item{title="Sessions carry identity" icon="i-lucide-user-round-check" to="/docs/auth/server-api"}
  Route guards can read the authenticated user without provider details.
  :::
::
