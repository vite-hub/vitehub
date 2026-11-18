---
title: Logs configuration
navigation.title: Configure
navigation.order: 3
description: "Pass Evlog options through the ViteHub logs option, log browser errors, or read an existing log backend with a LogSource module for the Console and the CLI."
icon: i-lucide-logs
---

## Evlog options

Logs are part of `observability` in `vitehub()`. Pass native Evlog options under `observability.evlog`:

```ts fragment
observability: {
  logs: true,
  evlog: {
    env: { service: 'checkout' },
    redact: { paths: ['customer.email'] },
    exclude: ['/_vitehub/**', '/_vitehub/**'],
  },
}
```

Read the [Evlog documentation](https://evlog.dev) for its options and drains. If your app already registers the Evlog Nitro module, keep its options there. ViteHub reuses it.

## Log browser errors

An error in the browser does not reach your server logs. Set `browserErrors: true` to send uncaught browser errors to the server:

::code-tree
:::framework{name="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { observability: { browserErrors: true } },
})
```
:::
:::framework{name="Nitro"}
```ts [vite.config.ts]
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({ observability: { browserErrors: true } }),
    nitro(),
  ],
})
```
:::
:::framework{name="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ observability: { browserErrors: true } })],
})
```
:::
::

- The page sends each error to `POST /_vitehub/browser-errors`. The server adds it to the Evlog event of that request, at error level, with `browserError: { kind, path }`. Your `redact`, sampling, and drains apply to it, as to your server errors.
- The page reports window `error` and `unhandledrejection` events. In Nuxt, it also reports the errors of the `vue:error` and `app:error` hooks.
- To report an error that your code catches, such as a failed copy that shows a toast, call the browser's [`reportError(error)`](https://developer.mozilla.org/en-US/docs/Web/API/Window/reportError). It fires the window `error` event without throwing.
- The page sends the path without the query. The server removes the query from each URL in the message and the stack, and cuts the message to 1,000 characters and the stack to 4,000.
- The route accepts only requests from pages of the same origin, bodies of 16 KiB or less, and 20 reports a minute from one address in each server process. A page sends at most 10 reports, one for each message.

It is off by default. If your `evlog.exclude` excludes `/_vitehub/**`, the reports go to the server console.

## Read an existing backend

Set `observability.logs.source` to a server module that exports a `LogSource` as its default export:

```ts fragment
observability: { logs: { source: './server/logs.ts' } }
```

The module implements the [Server API](/docs/logs/server-api) read contract. Query your backend with server credentials, normalize events, and return the newest first. List only filters the backend can apply. Pass the abort signal to backend requests.

Source mode starts no logger, drain, or local buffer, unless `observability.service` turns on Agent telemetry, which registers Evlog. Your setup keeps sending events. The source only reads them.

Evlog can export to PostHog, OTLP, and other destinations, but those drains give the Console no history. ViteHub has no built-in PostHog or OTLP history adapter. Write a source against the destination's query API, because OTLP ingestion alone cannot answer queries.

Keep backend credentials in server config. Remove sensitive fields before you return events to the Console.
