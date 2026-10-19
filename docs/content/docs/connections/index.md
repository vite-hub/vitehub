---
title: Connections
navigation.title: Overview
description: Connect a Google account or an API key once, then call the provider API from your server.
navigation.order: 1
icon: i-lucide-plug
---

::product-hero{tagline="Connect a Google account or an API key once, then call its API from your server without handling tokens." hosts="Node, Docker, Cloudflare, Vercel, Netlify, Deno"}
  :::product-files
  ```ts [server/connections/google.ts]
  import { useServerEnv } from '#vitehub/env/server'
  import { defineConnection } from 'vite-hub/connections'
  import { google } from 'vite-hub/connections/google'

  // The file name makes this the "google" Connection
  export default defineConnection({
    provider: google({
      clientId: () => useServerEnv().google.clientId,
      clientSecret: () =>
        useServerEnv().google.clientSecret.unseal(),
    }),
    scopes: [
      'https://www.googleapis.com/auth/gmail.readonly',
    ],
    // Server code can read, but not write
    access: {
      server: { read: true, write: false },
    },
  })
  ```

  ```ts [server/api/labels.get.ts]
  import { defineEventHandler } from 'h3'
  import {
    useConnection,
  } from 'vite-hub/connections/server'

  // Gmail labels of the connected account
  export default defineEventHandler(async () => {
    const google = useConnection('google')
    return google.gmail.users.labels.list({
      userId: 'me',
    })
  })
  ```

  ```ts [server/connections/crm.ts]
  import {
    apiKey,
    defineConnection,
  } from 'vite-hub/connections'

  // An admin adds the key later.
  // It is never in your code.
  export default defineConnection({
    provider: apiKey({
      id: 'crm',
      origins: ['https://api.crm.example.com'],
    }),
    access: {
      server: { read: true },
    },
  })
  ```

  ```ts [server/api/contacts.get.ts]
  import { defineEventHandler } from 'h3'
  import {
    useConnection,
  } from 'vite-hub/connections/server'

  // The key is added to the request for you
  export default defineEventHandler(async () => {
    const crm = useConnection('crm')
    const response = await crm.fetch(
      'https://api.crm.example.com/contacts',
    )
    return response.json()
  })
  ```
  :::
::

::product-features
  :::product-feature-item{title="Connect an account once" icon="i-lucide-plug" to="/docs/connections/get-started#connect-the-account"}
  Sign in to the provider once. The app keeps the tokens, encrypted, in its database.
  :::

  :::product-feature-item{title="Typed calls, fresh tokens" icon="i-lucide-code-2" to="/docs/connections/server-api#calls"}
  `useConnection()` gives typed methods such as `gmail.users.labels.list()`. Tokens refresh before they expire.
  :::

  :::product-feature-item{title="Decide who can read and write" icon="i-lucide-lock" to="/docs/connections/configure#access-rules"}
  Rules allow reads and writes for each caller. A caller without a rule is denied.
  :::

  :::product-feature-item{title="Tokens go only to the right API" icon="i-lucide-shield-check" to="/docs/connections/configure#provider-origins"}
  A request to any other address fails and gets no token.
  :::

  :::product-feature-item{title="API keys work too" icon="i-lucide-key-round" to="/docs/connections/configure#api-key-connections"}
  Add a key while the app runs instead of in your code. The same rules apply.
  :::

  :::product-feature-item{title="A record of each change" icon="i-lucide-history" to="/docs/connections/server-api#activity"}
  Writes, denied calls, and failures are recorded. Tokens and request bodies are never stored.
  :::
::
