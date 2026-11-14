---
title: Open your app in the Console
description: Turn on the Console endpoint of your app, deploy it, and link it in console.vitehub.dev with one public key.
navigation.title: Get started
navigation.order: 2
navigation.group: Start
icon: i-lucide-rocket
---

Turn the Console on, deploy, and link the app in [console.vitehub.dev](https://console.vitehub.dev) with the public key that it gives you.

## Choose the console option

| `console` | Development server | Production build |
| --- | --- | --- |
| Not set | The [Operations endpoint](/docs/console/development), for this machine only. | Nothing under `/_vitehub`. |
| `false` | Nothing under `/_vitehub`, so `vitehub kv`, `vitehub schedule run` and the other commands cannot reach it. | Nothing under `/_vitehub`. |
| `true` or an object | The Console endpoint with your access policy. | The same. `auth: false` is refused. |

## In development

```bash [Terminal]
pnpm vitehub project info
pnpm vitehub kv list
```

The Console calls each app from its own server, so it cannot reach a `vite dev` server on your machine. Until you deploy, the [`vitehub` commands](/docs/cli) call the dev server's Operations endpoint instead.

## Link a deployed app

Turn the Console on and deploy:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    console: true,
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'
import { nitro } from 'nitro/vite'

export default defineConfig({
  plugins: [vitehub({
    console: true,
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
    console: true,
  })],
})
```
:::
::

Sign in to the Console and enter the app URL in **Get started**, or later with **+** next to **Apps**. Set the variable that it shows on the server, deploy again, and select **Check connection**:

```txt
VITEHUB_CONSOLE_KEY_CONSOLE_3F9A12BC=<public key>
```

The Console keeps the private key of each link encrypted and [signs](/docs/console/signed-requests) every call with it. Your app and the browser never see it. Each link has its own variable, so the app can keep other keys, such as the CLI's, beside it. To unlink, unlink the app in the Console and remove its variable.

Under a base path, from Nuxt `app.baseURL` or a root-relative Vite `base`, every Console route moves too. With `base: '/portal/'` the route is `/portal/_vitehub/rpc`, and you link `https://app.example.com/portal`.

::note
The Console does not turn on [Comments](/docs/comments): add `server/comments.ts` or set `comments: true` to get its section. To limit who may use each section, see [Console access](/docs/console/access).
::

## Teams and members

You sign in with GitHub or a passkey. Each account has a personal team, and you can create more teams and invite people under **Members**, so the team's apps open wherever a member signs in. **Settings** holds your name, GitHub sign-in and passkeys. Invitations are links that you send yourself, because the Console sends no email.

## Self-host the Console

The Console is the [`@vite-hub/console`](https://github.com/vite-hub/vitehub/tree/main/packages/console) package. It runs on Node.js with SQLite or on Cloudflare Workers with D1, and its README shows how to build, configure and deploy it.
