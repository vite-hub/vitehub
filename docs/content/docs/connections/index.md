---
title: Connections
navigation.title: Overview
description: Connect provider accounts with OAuth 2 or an API key, call their APIs with access rules, and record how routes and Agents use them.
navigation.order: 1
icon: i-lucide-plug
---

::agent-only{skill="connections"}
Use Connections when a person or application must connect a provider account with OAuth 2 or an API key, then call that provider through an explicit access policy.

Read [Get started](/docs/connections/get-started) and [Server API](/docs/connections/server-api).

Connections require a Database and encryption key policy. Keep provider scopes and operation allowlists visible. A connected account is not automatically available to an Agent or route.

Keep the connected account, actor, and operation scope in the request policy.
Never expose provider tokens to application responses or Agent prompts.

Prove the connect and callback flow, an authorized operation, and a denied operation. Inspect the stored metadata without exposing tokens.
::

::product-hero{tagline="Call provider APIs as an app-owned account: OAuth 2 or API key, sealed in the app database, checked per call." hosts="Node, Docker, Cloudflare, Vercel, Netlify, Deno"}
  :::code-group
  ```ts [Definition]
  import { useServerEnv } from '#vitehub/env/server'
  import { defineConnection } from 'vite-hub/connections'
  import { google } from 'vite-hub/connections/google'

  export default defineConnection({
    provider: google({
      clientId: () => useServerEnv().google.clientId,
      clientSecret: () => useServerEnv().google.clientSecret.unseal(),
    }),
    scopes: ['https://www.googleapis.com/auth/gmail.modify'],
    access: {
      server: { write: ['gmail.*'] },
      agents: {
        labeller: { write: ['gmail.messages.*', 'gmail.labels.list', 'gmail.drafts.create'], approve: true },
      },
    },
  })
  ```

  ```ts [Route]
  import { useConnection } from 'vite-hub/connections/server'

  export default defineEventHandler(async (event) => {
    const connection = useConnection('google')
    return await connection.gmail.users.labels.list()
  })
  ```

  ```ts [API key]
  import { apiKey, defineConnection } from 'vite-hub/connections'

  export default defineConnection({
    provider: apiKey({ id: 'executor', origins: ['https://executor.sh'] }),
  })
  ```

  ```bash [CLI]
  vitehub connections list
  vitehub connections status google
  vitehub connections activity google
  vitehub connections connect google
  vitehub connections refresh google
  printf %s "$EXECUTOR_API_KEY" | vitehub connections set-key executor
  ```
  :::
::


::product-features
  :::product-feature-item{title="Writes are denied until a rule allows them" icon="i-lucide-shield-check" to="/docs/connections/configure#access-rules"}
  With an `access` map, actors without a matching rule are denied.
  :::

  :::product-feature-item{title="The credential goes only to declared origins" icon="i-lucide-shield-alert" to="/docs/connections/configure#provider-origins"}
  Other origins fail with `CONNECTION_INVALID` and get no credential.
  :::

  :::product-feature-item{title="API keys get the same rules and activity" icon="i-lucide-key-round" to="/docs/connections/configure#api-key-connections"}
  `apiKey()` seals a static key; set it in the Console or CLI.
  :::

  :::product-feature-item{title="Every write, denial, and failure is recorded" icon="i-lucide-activity" to="/docs/connections/server-api"}
  Activity stores actor, Operation, and outcome, never bodies or tokens.
  :::

  :::product-feature-item{title="Agents call it under their own rule" icon="i-lucide-bot" to="/docs/agents/capabilities/gmail"}
  An `approve` match makes the Agent tool ask for approval.
  :::

  :::product-feature-item{title="Access stays scoped" icon="i-lucide-shield-check" to="/docs/connections/configure"}
  Store provider credentials with an explicit account and grant policy.
  :::
::
