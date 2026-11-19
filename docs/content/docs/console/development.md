---
title: Console endpoint on a development server
description: How the Operations endpoint of vite dev answers only this machine, how to share a dev server safely, and which user dev calls run as.
navigation.title: Development server
navigation.order: 22
navigation.group: Secure it
icon: i-lucide-laptop
---

In `vite dev` without a `console` option, the app serves the Operations endpoint with every section open, to this machine only, so the `vitehub` commands work without a signature. `console: false` turns it off.

## Turn off signatures in development

A dev server with `console: true` and no `VITEHUB_CONSOLE_KEY_<NAME>` answers unsigned calls from this machine, so you can keep `console: true` in every environment:

```bash [Terminal]
pnpm vitehub kv list
```

Once the dev server has a key in its environment, it takes only signed calls, like a deployment. You can also set `console: { auth: false }` for development only; a production build refuses it.

The dev server prints a warning at startup when it listens beyond loopback, as with `--host`. An unsigned call must come from the app origin, or send `x-vitehub-console: 1` with no `Origin` header. Otherwise it gets `403` with `CONSOLE_ORIGIN_REJECTED`, so browsers on other origins cannot call it.

## Only this machine

While the endpoint takes unsigned calls, a request gets `403` with `CONSOLE_LOOPBACK_ONLY` when one of these checks fails. The `vitehub` CLI on this machine passes them.

| Check | Refused when |
| --- | --- |
| `Host` | It is not `localhost`, a `.localhost` name, `127.0.0.1` or `[::1]`. |
| Peer address | It is not loopback, on hosts that expose it. |
| Forwarding headers | Any of `Forwarded`, `Via`, `X-Forwarded-*`, `X-Real-IP`, `True-Client-IP`, `X-Client-IP`, `X-Cluster-Client-IP`, `CDN-Loop`, `CF-*`, `Fly-Client-IP`, `Fastly-Client-IP`, `X-Vercel-Forwarded-For`, `Ngrok-*` or `Tailscale-*` is present. |

## Share a development server

A tunnel or reverse proxy on this machine, such as `cloudflared`, `ngrok`, `tailscale serve`, `ssh -R` or Caddy, also connects from `127.0.0.1`, and an unsigned dev server trusts whoever reaches it. To share one, remove `console.auth` and set a `VITEHUB_CONSOLE_KEY_<NAME>` on it so it takes only [signed calls](/docs/console/signed-requests#sign-calls-to-a-development-server).

::warning
A forwarder that copies raw TCP bytes, such as `ssh -R` or `tailscale serve --tcp`, adds no header, so ViteHub cannot tell its requests from yours. Only signed calls protect a dev server behind one.
::

## The development user

```ts fragment
context.user = { id: 'local', name: 'You' }
```

In `vite dev`, a call without a signed user runs as this user, in Comments and Content alike. A build never adds it: a production call from the CLI has no `context.user`, and a Console call has the person that the Console signed.
