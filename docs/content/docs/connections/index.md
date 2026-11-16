---
title: Connections
layout: landing
navigation.title: Overview
description: Connect a Google account or an API key once, then call the provider API from your server.
navigation.order: 1
icon: i-lucide-plug
---

::product-hero{tagline="Connect a Google account or an API key once, then call its API from your server without handling tokens." hosts="Node, Docker, Cloudflare, Vercel, Netlify, Deno"}
  :hero-figure{name="connections"}
::

::product-features
  :::product-feature-item{title="Connect an account once" icon="i-lucide-plug" to="/docs/connections/get-started#connect-the-account"}
  Sign in to the provider once. The app keeps the tokens encrypted in its database.
  :::

  :::product-feature-item{title="Typed calls, fresh tokens" icon="i-lucide-code-2" to="/docs/connections/server-api#calls"}
  `useConnection()` gives typed methods such as `gmail.users.labels.list()`. Tokens refresh before they expire.
  :::

  :::product-feature-item{title="Decide who can read and write" icon="i-lucide-lock" to="/docs/connections/configure#access-rules"}
  Rules allow reads and writes per caller. A caller without a rule is denied.
  :::

  :::product-feature-item{title="Tokens go only to the right API" icon="i-lucide-shield-check" to="/docs/connections/configure#provider-origins"}
  A request to any other address fails and gets no token.
  :::

  :::product-feature-item{title="API keys work too" icon="i-lucide-key-round" to="/docs/connections/configure#api-key-connections"}
  Add a key while the app runs, not in code. The same rules apply.
  :::

  :::product-feature-item{title="A record of each change" icon="i-lucide-history" to="/docs/connections/server-api#activity"}
  Records writes, denied calls, and failures. Never stores tokens or request bodies.
  :::
::

::agent-only{skill="connections"}
Use Connections when a person or application must connect a provider account with OAuth 2 or an API key, then call that provider through an explicit access policy.

Connections require a Database and encryption key policy. Keep provider scopes and operation allowlists visible. A connected account is not automatically available to an Agent or route.

Keep the connected account, actor, and operation scope in the request policy.
Never expose provider tokens to application responses or Agent prompts.

Prove the connect and callback flow, an authorized operation, and a denied operation. Inspect the stored metadata without exposing tokens.
::
