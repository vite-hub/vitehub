---
title: Open your app in the Console
description: Turn on the Console endpoint of your app, deploy it, and link it in console.vitehub.dev with one public key.
navigation.title: Get started
navigation.order: 2
navigation.group: Start
icon: i-lucide-rocket
---

Turn on the Console endpoint of your app, deploy it, and link it in [console.vitehub.dev](https://console.vitehub.dev) with the public key that the Console gives you.

## Choose the console option

| `console` | Development server | Production build |
| --- | --- | --- |
| Not set | The [Operations endpoint](/docs/console/development), for this machine only. | Nothing under `/_vitehub`. |
| `false` | Nothing under `/_vitehub`, so `vitehub kv`, `vitehub schedule run`, and the other commands cannot reach it. | Nothing under `/_vitehub`. |
| `true` or an object | The Console endpoint, with your access policy. | The same. `auth: false` is refused. |

## In development

```bash [Terminal]
pnpm vitehub project get
pnpm vitehub kv list
```

The Console calls each app from its own server, so it cannot reach a `vite dev` server on your machine. Until you deploy, the [`vitehub` commands](/docs/cli) call the dev server's Operations endpoint instead.

## Link a deployed app

Set `console: true` in your app:

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

Then sign in once and deploy:

```bash [Terminal]
pnpm vitehub login
pnpm vitehub deploy
```

`vitehub deploy` links the deployed URL in your team, sets the key of the link on the host, checks the connection, and prints the Console page of the app. A second deploy keeps the same link. See [Link the app in the Console](/docs/cli/project#link-the-app-in-the-console).

When you deploy another way, link the app with `vitehub apps link <url>`, the `link_app` tool of the [Console MCP](/docs/console/mcp), or the Console: enter your app URL in **Get started**, or later with **+** next to **Apps**. Set the variable that it shows on your server, deploy again, and select **Check connection**:

```txt
VITEHUB_CONSOLE_KEY_CONSOLE_3F9A12BC=<public key>
```

The Console names each app by the **Name** that you give it when you link it. Without one, it uses the name that the app reports, from its `package.json`. Owners and admins can rename an app from the menu of its row on Home.

The Console keeps the private key of each link encrypted and [signs](/docs/console/signed-requests) every call with it. Your app and the browser never see it. Each link has its own variable, so the app can keep other keys beside it, such as the key of the CLI. To unlink, unlink the app in the Console and remove its variable.

When your app uses a base path from Nuxt `app.baseURL` or a root-relative Vite `base`, every Console route moves under it. With `base: '/portal/'`, the endpoint is `/portal/_vitehub/rpc` and you link `https://app.example.com/portal`.

::note
The Console does not turn on [Comments](/docs/comments). Add `server/comments.ts` or set `comments: true` to get the Comments section. To limit who can use each section, see [Console access](/docs/console/access).
::

## Teams and members

Sign in with GitHub or a passkey. Each account has a personal team. You can create more teams and invite people under **Members**, so the team's apps open wherever a member signs in. **Settings** holds your name, GitHub sign-in, and passkeys. Invitations are links that you send yourself, because the Console sends no email.

## Self-host the Console

The Console is the [`@vite-hub/console`](https://github.com/vite-hub/vitehub/tree/main/packages/console) package. It runs on Node.js with SQLite, on Cloudflare Workers with D1, or on Vercel with hosted libSQL, and its README covers how to build, configure, and deploy it.

Set `console.url` in the app to the origin of your Console. `/_vitehub`, the Console links of the app, Site access visits that start on the app, and the Console segment of the Comments pill then go to your Console and not to `https://console.vitehub.dev`. Guest invites and phone links return to the Console that issued them:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    console: { url: 'https://console.example.com' },
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
    console: { url: 'https://console.example.com' },
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
    console: { url: 'https://console.example.com' },
  })],
})
```
:::
::

The value must be an `https://` origin without a path. `http://localhost` is allowed for a Console on your computer. The build fails with [`VITE_HUB_B0004`](/docs/development/diagnostics/vite_hub_b0004) for other values.

If the app uses an origin list in its Content Security Policy, [allow the new Console origin in `script-src`](/docs/console/site-access#content-security-policy).
