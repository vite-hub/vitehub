---
title: Open your app in the Console
description: Turn on the Console endpoint of your app, deploy it, and link it in console.vitehub.dev with one public key.
navigation.title: Get started
navigation.order: 2
navigation.group: Start
icon: i-lucide-rocket
---

## Choose the console option

The `console` option of `vitehub()` has three states:

| `console` | Development server | Production build |
| --- | --- | --- |
| Not set | The [Operations endpoint](/docs/console/development) answers this machine, so `vitehub <command>` works. | Nothing under `/_vitehub`. |
| `false` | Nothing under `/_vitehub`. | Nothing under `/_vitehub`. |
| `true` or an object | The Console endpoint with the configured access policy. | The Console endpoint with the configured access policy. `auth: false` is refused. |

With `console: false`, ViteHub registers no Console RPC route, Console Nitro plugin, or Console public asset path, also on a development server. Commands such as `vitehub kv` and `vitehub schedule run` then cannot reach the development server. Remove the option to get the development endpoint back.

## In development

The Console calls each app from its server, so it cannot reach a `vite dev` server on your machine. During development, use the [`vitehub` commands](/docs/development/cli). They call the Operations endpoint of the dev server:

```bash [Terminal]
pnpm vitehub project info
pnpm vitehub kv list
```

To use the Console UI, deploy the app and link it.

## Link a deployed app

1. Set `console: true` and deploy.
2. Open [console.vitehub.dev](https://console.vitehub.dev) and sign in. **Get started** asks for the app URL. Later, select **+** next to **Apps** in the sidebar.
3. The Console shows a variable and its value, such as `VITEHUB_CONSOLE_KEY_CONSOLE_3F9A12BC=<public key>`. Set it on the server, deploy, and select **Check connection**.

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

Each link has its own variable, so the app can keep other keys next to it, such as the key of the CLI. To unlink a project, unlink it in the Console and remove its variable from the app.

The Console server keeps an Ed25519 key pair for each linked project, with the private key encrypted, and [signs](/docs/console/signed-requests) each call to the project with it. The signature names the person who calls. The app keeps only the public key, and the browser never sees the private key.

An app under a base path keeps every Console route under that base: an explicit ViteHub application base (set from Nuxt `app.baseURL`), else a root-relative Vite `base`. With `base: '/portal/'`, the route is `/portal/_vitehub/rpc`, and you link the app as `https://app.example.com/portal`.

To limit who may use which section, see [Console access](/docs/console/access). The Console does not turn on [Comments](/docs/comments). Add `server/comments.ts` or set `comments: true` to get the **Comments** section.

## Teams and members

Sign in with GitHub or a passkey. Each account has a personal team, and you can make more teams and invite people. A team's projects open in any browser where a member signs in.

The sidebar lists the team's apps, **Members** to invite people and remove them, and **Settings** for your name, GitHub sign-in, and passkeys. Invitations are links that you send yourself. The Console sends no email.

## Self-host the Console

The Console app is [`@vite-hub/console`](https://github.com/vite-hub/vitehub/tree/main/packages/console). It runs on Node.js with SQLite, or on Cloudflare Workers with D1. Its README shows how to build, configure, and deploy it.
