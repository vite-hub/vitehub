---
title: Console endpoint on a development server
description: How the Operations endpoint of vite dev answers only this machine, how to share a dev server safely, and which user dev calls run as.
navigation.title: Development server
navigation.order: 22
navigation.group: Secure it
icon: i-lucide-laptop
---

In `vite dev` without a `console` option, the app serves the Operations endpoint with the local policy, so every section is open. It answers only this machine, so the `vitehub` commands can call it without a signature. `console: false` turns it off.

## Turn off signatures in development

`console: { auth: false }` works like the local policy: calls without a signature, from this machine only. Set it for the dev server only, and the build keeps signed calls:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    console: true,
    kv: true,
    host: 'node',
  },
  $development: {
    vitehub: { console: { auth: false } },
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig(({ command }) => ({
  plugins: [vitehub({
    console: command === 'serve' ? { auth: false } : true,
    kv: true,
    host: 'node',
  }), nitro()],
}))
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { vitehub } from 'vite-hub'
import { defineConfig } from 'vite'

export default defineConfig(({ command }) => ({
  plugins: [vitehub({
    console: command === 'serve' ? { auth: false } : true,
    kv: true,
    host: 'node',
  })],
}))
```
:::
::

When the endpoint takes calls without a signature, the dev server prints a note at startup. A server that listens on more than loopback, for example with `--host`, prints it as a warning.

A call without a signature must come from the app origin, or send `x-vitehub-console: 1` with no `Origin` header, or it gets `403` with `CONSOLE_ORIGIN_REJECTED`. Browsers cannot call the endpoint from another origin.

## Only this machine

A request gets `403` with `CONSOLE_LOOPBACK_ONLY` when it has:

- a `Host` other than `localhost`, a `.localhost` name, `127.0.0.1`, or `[::1]`,
- a peer address that is not loopback, when the host exposes it,
- or a forwarding header: `Forwarded`, `Via`, any `X-Forwarded-*`, `X-Real-IP`, `True-Client-IP`, `X-Client-IP`, `X-Cluster-Client-IP`, `CDN-Loop`, any `CF-*`, `Fly-Client-IP`, `Fastly-Client-IP`, `X-Vercel-Forwarded-For`, any `Ngrok-*`, or any `Tailscale-*`.

The `vitehub` CLI on this machine passes this check.

## Share a development server

A development server without signed calls trusts whoever can reach it. A tunnel or a reverse proxy on this machine, such as `cloudflared`, `ngrok`, `tailscale serve`, an `ssh -R` tunnel, or Caddy, connects to the dev server from `127.0.0.1` too.

To share a dev server through one, remove `console.auth`, so the server takes only [signed calls](/docs/console/signed-requests#sign-calls-to-a-development-server).

A forwarder that copies raw TCP bytes, such as `ssh -R` or `tailscale serve --tcp`, adds no header, so ViteHub cannot tell its requests from yours. Only signed calls protect a dev server behind one.

## The development user

In `vite dev`, a call without a signed user runs as `context.user = { id: 'local', name: 'You' }`. The RPC builds the context in one place, so Comments and Content see the same user. A build never adds it: a production call from the CLI has `context.user` unset, and a call from the Console has the person that the Console signed.
