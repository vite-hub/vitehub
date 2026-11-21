---
title: Logs configuration
navigation.title: Configure
navigation.order: 3
description: "Pass Evlog options through the ViteHub logs option, log browser errors, or read an existing log backend with a LogSource module for the Console and the CLI."
icon: i-lucide-logs
---

## Evlog options

Logs reads Evlog events. Pass native Evlog options under `observability.evlog`:

```ts fragment
logs: true,
observability: {
  evlog: {
    env: { service: 'checkout' },
    redact: { paths: ['customer.email'] },
    exclude: ['/_vitehub/**', '/_vitehub/**'],
  },
},
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

- The page sends each report to `POST /_vitehub/browser-errors`. The server adds it to the Evlog event of that request with `browserError: { kind, path, level }`. Your `redact`, sampling, and drains apply to it, as to your server errors.
- The page reports window `error`, `unhandledrejection`, and `vite:preloadError` events. In Nuxt, it also reports errors from the `vue:error`, `app:error`, and `app:chunkError` hooks. An error that Nuxt sends through two hooks is reported once. A chunk that fails to load is reported once per browser tab, not again after each reload. Errors thrown by a loaded chunk still follow the per-page limit.
- The page sends the path without the query. The server removes the query from each URL in the message, the stack, and the fields, and cuts the message to 1,000 characters and the stack to 4,000.
- The route accepts only requests from pages of the same origin, bodies of 16 KiB or less, and 20 reports a minute from one address in each server process. The page can omit fields or an oversized stack to fit the byte limit without losing the message. It sends at most 10 reports, one for each action and message.

It is off by default. If your `evlog.exclude` excludes `/_vitehub/**`, the reports go to the server console.

### Report a caught error

An error that your code catches, such as a failed save that shows a toast, does not reach the window events. Send it with `reportBrowserError()`:

```ts [app/utils/save-order.ts]
import { reportBrowserError } from 'vite-hub/logs/client'

export async function saveOrder(orderId: string, lines: string[]) {
  try {
    const response = await fetch(`/api/orders/${orderId}`, { method: 'PUT', body: JSON.stringify({ lines }) })
    if (!response.ok) throw new Error(`The order save failed with status ${response.status}`)
    return true
  }
  catch (error) {
    reportBrowserError(error, { action: 'save-order', fields: { orderId } })
    return false
  }
}
```

The server logs it with `browserError: { kind: 'handled', path, level: 'error', action: 'save-order', fields: { orderId } }`.

| Option | Description |
| --- | --- |
| `action` | What the page was doing. The server keeps 100 characters. |
| `level` | `'error'` (default) or `'warn'`. A warning goes to `log.warn()`, with the message only. |
| `fields` | At most 20 flat values: strings, numbers, booleans, or `null`. Put an HTTP status, a request id, or the id of the record that failed here. The event counts invalid fields and fields omitted to fit the count or byte limits in `droppedFields`. The report is still sent. A string keeps 300 characters. |

`reportBrowserError()` uses the same limits as the uncaught errors: 10 reports a page, and one report for each action and message. It never throws. On the server, and when `browserErrors` is off, it does nothing. Decide in your code which errors to send. For example, do not send a 404 that the server already logged.

## Read an existing backend

Set `logs.source` to a server module that exports a `LogSource` as its default export:

```ts fragment
logs: { source: './server/logs.ts' }
```

The module implements the [Server API](/docs/logs/server-api) read contract. Query your backend with server credentials, normalize events, and return the newest first. List only filters the backend can apply. Pass the abort signal to backend requests.

Source mode starts no logger, drain, or local buffer, unless you also set `observability`, which registers Evlog. Your setup keeps sending events. The source only reads them.

Evlog can export to PostHog, OTLP, and other destinations, but those drains give the Console no history. ViteHub has no built-in PostHog or OTLP history adapter. Write a source against the destination's query API, because OTLP ingestion alone cannot answer queries.

Keep backend credentials in server config. Remove sensitive fields before you return events to the Console.
